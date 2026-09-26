import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `omo daemon` - the operator's view of the one machine-wide engine host.
 *
 * Everything that decides WHO serves the socket lives in the engine (`senpi host`): probing an
 * existing host, comparing build ordinals, handing a generation over, refusing when the two sides
 * cannot agree. This wrapper owns three much smaller things, and deliberately nothing else:
 * omo's launch spec is the argv source, omo.json is where the policy comes from, and the caller
 * gets an exit code it can branch on without reading prose.
 */

const SUBCOMMANDS = new Set(["run", "attach", "status", "stop", "handoff"])
/** Flags this wrapper consumes itself; anything else after `attach` belongs to the launch. */
const DAEMON_FLAGS = new Set(["--json", "--no-upgrade", "--persistent", "--foreground", "--include-workers", "--drain"])
/** The subcommands that can bring a host into existence, and therefore need omo's argv source. */
const NEEDS_SPEC = new Set(["run", "attach", "handoff"])

/** A named code per outcome, so a script never has to parse the message to know what happened. */
export const DAEMON_EXIT = {
  ok: 0,
  usage: 2,
  notRunning: 3,
  unsupported: 4,
  engineRefused: 5,
}

const USAGE = [
  "usage: omo daemon <run|attach|status|stop|handoff> [options]",
  "",
  "  run       ensure a daemon is serving this agent dir (start, reuse, or hand off)",
  "  attach    print the environment a child needs to reach the daemon",
  "  status    report who is serving and which sessions exist",
  "  stop      end the daemon; --drain lets in-flight work finish first",
  "  handoff   hand the socket to this build, keeping live sessions",
  "",
  "  --json            print the engine's JSON line instead of a summary",
  "  --no-upgrade      never hand off, even from an older build",
  "  --persistent      outlive the process that started it",
  "  --foreground      run the host in this process instead of detaching",
  "  --include-workers include subagent sessions in status",
].join("\n")

/**
 * The policy the engine is allowed to apply. A flag beats config, config beats the default,
 * and the default is the one that keeps a newer build from being blocked by an older one.
 */
function resolvePolicy(args, config) {
  if (args.includes("--no-upgrade")) return "never"
  const configured = config?.task?.host_engine_policy
  if (configured === "fallback" || configured === "never" || configured === "upgrade") return configured
  return "upgrade"
}

/** omo.json is optional and may be hand-edited, so unreadable config must not take the CLI down. */
function readConfig(agentDir) {
  const path = join(agentDir, "omo.json")
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * The engine owns four subcommands - ensure, status, stop, handoff. `run` and `attach` are omo's
 * words for the same ensure: one asks for a daemon, the other asks for a daemon plus the
 * environment to reach it. Mapping them here is what keeps this file from inventing a fifth.
 */
const ENGINE_SUBCOMMAND = { run: "ensure", attach: "ensure", status: "status", stop: "stop", handoff: "handoff" }

function buildArgs(subcommand, args, { specPath, policy, config }) {
  const engineArgs = ["host", ENGINE_SUBCOMMAND[subcommand], "--json"]
  if (subcommand === "run" || subcommand === "attach" || subcommand === "handoff") {
    engineArgs.push("--launch-spec", specPath, "--policy", policy)
    const idleExitMs = config?.task?.host_idle_exit_ms
    if (typeof idleExitMs === "number" && Number.isFinite(idleExitMs)) {
      engineArgs.push("--idle-exit-ms", String(Math.trunc(idleExitMs)))
    }
    if (args.includes("--persistent")) engineArgs.push("--persistent")
    if (args.includes("--foreground")) engineArgs.push("--foreground")
  }
  if (subcommand === "stop" && args.includes("--drain")) engineArgs.push("--drain")
  if (subcommand === "status" && args.includes("--include-workers")) engineArgs.push("--include-workers")
  return engineArgs
}

function parseLine(stdout) {
  const line = stdout.trim().split("\n").filter(Boolean).pop()
  if (line === undefined) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** What a child process needs in its environment to reach this daemon rather than start its own. */
function attachEnv(parsed, agentDir) {
  return {
    OMO_ENABLE_SHARED_HOST: "1",
    OMO_RPC_SOCKET: parsed?.socket ?? join(agentDir, "rpc", "rpc.sock"),
  }
}

function summarize(subcommand, parsed, exitCode) {
  if (subcommand === "status") {
    if (exitCode === DAEMON_EXIT.notRunning || parsed === undefined) return "daemon: not running"
    const sessions = parsed.sessions?.total ?? parsed.sessions?.length
    const suffix = sessions === undefined ? "" : `, ${sessions} session(s)`
    return `daemon: running pid ${parsed.pid}${suffix}`
  }
  if (parsed === undefined) return `daemon: ${subcommand} failed`
  const pid = parsed.pid === undefined ? "" : ` pid ${parsed.pid}`
  return `daemon: ${parsed.action ?? subcommand}${pid}`
}

/**
 * @param args argv after `omo daemon`
 * @param options.engine  something that can run the engine CLI; injected so tests never spawn one
 * @returns the process exit code the launcher should use
 */
export function runDaemonCommand(args, options) {
  const { engine, pluginRoot, agentDir, env, stdout, stderr, platform } = options
  const subcommand = args[0]

  if (subcommand === "--help" || subcommand === "-h") {
    stdout.write(`${USAGE}\n`)
    return DAEMON_EXIT.ok
  }
  if (subcommand === undefined) {
    stderr.write(`${USAGE}\n`)
    return DAEMON_EXIT.usage
  }
  if (!SUBCOMMANDS.has(subcommand)) {
    stderr.write(`omo daemon: unknown subcommand '${subcommand}'\n${USAGE}\n`)
    return DAEMON_EXIT.usage
  }
  // A named pipe is per-process on win32: there is no socket for a second client to attach to,
  // so refusing here is honest, where pretending would strand the caller on a host it cannot reach.
  if (platform === "win32") {
    stderr.write("omo daemon: a shared host needs a unix socket, which win32 does not provide\n")
    return DAEMON_EXIT.unsupported
  }

  // Only the subcommands that may START something need the spec; asking who is serving, or
  // asking it to stop, must still work on an install whose plugin payload was never built.
  const specPath = join(pluginRoot, "daemon-launch-spec.json")
  if (NEEDS_SPEC.has(subcommand) && !existsSync(specPath)) {
    stderr.write(`omo daemon: launch spec missing at ${specPath}\n`)
    return DAEMON_EXIT.engineRefused
  }

  const config = readConfig(agentDir)
  const engineArgs = buildArgs(subcommand, args, { specPath, policy: resolvePolicy(args, config), config })
  const result = engine.run(engineArgs, { env: { ...env, OMO_AGENT_DIR: agentDir } })
  const parsed = parseLine(result.stdout ?? "")

  if (result.stderr) stderr.write(result.stderr)

  if (subcommand === "attach") {
    if (result.exitCode !== DAEMON_EXIT.ok) return result.exitCode
    const daemonEnv = attachEnv(parsed, agentDir)
    // `omo daemon attach --model x`: the trailing args are a normal omo launch that should run
    // against the daemon, so the caller gets the merged environment back and continues with them.
    const launchArgs = args.slice(1).filter((arg) => !DAEMON_FLAGS.has(arg))
    if (launchArgs.length > 0) return { passthrough: true, args: launchArgs, env: { ...env, ...daemonEnv } }
    const payload = { ...(parsed ?? {}), env: daemonEnv }
    if (args.includes("--json")) stdout.write(`${JSON.stringify(payload)}\n`)
    else for (const [key, value] of Object.entries(daemonEnv)) stdout.write(`${key}=${value}\n`)
    return DAEMON_EXIT.ok
  }

  if (args.includes("--json") && result.stdout) stdout.write(result.stdout.trim() + "\n")
  else stdout.write(`${summarize(subcommand, parsed, result.exitCode)}\n`)
  return result.exitCode
}

/**
 * The `omo doctor` view: one INFO line, never a FAIL - a machine without a daemon is healthy,
 * it just has nothing shared to report. Returned as lines so doctor can place it with the rest.
 */
export function daemonReportLines({ engine, pluginRoot, agentDir, env, platform }) {
  if (platform === "win32") return ["INFO Daemon: unavailable on win32 (no unix socket to share)"]
  const stdout = { write() {} }
  const captured = []
  const exitCode = runDaemonCommand(["status", "--json"], {
    engine, pluginRoot, agentDir, env, platform,
    stdout: { write: (text) => void captured.push(text) },
    stderr: stdout,
  })
  const parsed = parseLine(captured.join(""))
  if (exitCode !== DAEMON_EXIT.ok || parsed === undefined) return ["INFO Daemon: not running"]
  const sessions = parsed.sessions?.total ?? parsed.sessions?.length ?? 0
  const parts = [
    `pid ${parsed.pid}`,
    parsed.instanceId === undefined ? undefined : `instance ${parsed.instanceId}`,
    parsed.engineVersion === undefined ? undefined : `engine ${parsed.engineVersion}`,
    `${sessions} session(s)`,
    `zombies ${parsed.zombies ?? 0}`,
  ].filter(Boolean)
  return [`INFO Daemon: running ${parts.join(" · ")}`]
}
