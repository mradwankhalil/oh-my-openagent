export type ExecutionMode = "in-process" | "process"

/** What omo.json may say: either mode, or `auto` = let the shared task daemon decide. */
export type ConfiguredExecutionMode = ExecutionMode | "auto"

/** Which runner a `process` child gets (omo.json `task.process_runner`). */
export type ProcessRunnerKind = "host" | "child-process"

export type ExecutionModeSources = {
  readonly specMode?: ExecutionMode
  readonly agentMode?: ExecutionMode
  readonly configMode?: ConfiguredExecutionMode
  // The parent session's ONE resolution of `auto`. Absent until the first daemon ensure settles;
  // an unresolved `auto` reads as in-process, so no child is ever routed on a guess.
  readonly autoMode?: ExecutionMode
}

// Precedence: spec.execution_mode ?? agentDef.executionMode ?? omo.json task.default_execution_mode
// ?? "in-process". A configured "auto" contributes the parent session's resolved auto mode, so a
// user-set "in-process"/"process" (and every per-agent override) still wins over the daemon check.
export function resolveExecutionMode(sources: ExecutionModeSources): ExecutionMode {
  const configured = sources.configMode === "auto" ? sources.autoMode : sources.configMode
  return sources.specMode ?? sources.agentMode ?? configured ?? "in-process"
}

/**
 * What the ensured daemon must advertise before `auto` routes children to it as sessions:
 * `session_context` (the plugin gates itself per session by the role omo attaches) and
 * `generation_handoff` (an engine upgrade parks and reopens children instead of killing them).
 */
export const AUTO_HOST_CAPABILITIES = ["session_context", "generation_handoff"] as const

export type AutoExecutionModeInput = {
  readonly platform: NodeJS.Platform
  readonly processRunner: ProcessRunnerKind
  // `get_protocol_info.capabilities` of the ensured daemon; undefined = no daemon to host children.
  readonly capabilities: readonly string[] | undefined
}

/** The `auto` decision itself: pure, so the once-per-session gate below is the only stateful part. */
export function resolveAutoExecutionMode(input: AutoExecutionModeInput): ExecutionMode {
  if (input.platform === "win32" || input.processRunner !== "host") return "in-process"
  const advertised = new Set(input.capabilities ?? [])
  return AUTO_HOST_CAPABILITIES.every((capability) => advertised.has(capability)) ? "process" : "in-process"
}

/**
 * The parent session's memoized `auto` resolution. `ensure()` asks the daemon at most once per
 * parent session and never rejects (an unavailable daemon settles on in-process), so a child's mode
 * cannot change because the daemon died later in the session - the mode is a session fact.
 */
export interface ExecutionModeGate {
  /** The resolved mode, or undefined while no ensure has settled yet. */
  current(): ExecutionMode | undefined
  ensure(): Promise<ExecutionMode>
}

export function createExecutionModeGate(resolve: () => Promise<ExecutionMode>): ExecutionModeGate {
  let resolved: ExecutionMode | undefined
  let pending: Promise<ExecutionMode> | undefined
  return {
    current: () => resolved,
    ensure: () => {
      pending ??= resolve().catch((): ExecutionMode => "in-process").then((mode) => {
        resolved = mode
        return mode
      })
      return pending
    },
  }
}
