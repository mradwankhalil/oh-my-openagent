# omo daemon — one engine host per machine

`omo daemon` is the operator's view of the shared senpi RPC host: one process per
agent dir that serves every task child, every desktop thread and every attached
terminal as sessions inside itself, instead of one `--mode rpc` process per child.
Everything that decides *who serves the socket* lives in the engine (`senpi host`);
this command supplies omo's launch spec, reads the policy out of `omo.json`, and
turns the engine's answer into an exit code a script can branch on.

```bash
omo daemon run                 # ensure a daemon serves this agent dir: start, reuse, or hand off
omo daemon run --json          # the engine's JSON line verbatim
omo daemon attach              # print the env a child needs to reach it
omo daemon attach --model x    # run omo against the daemon (a normal launch, shared socket)
omo daemon status [--include-workers]
omo daemon stop [--drain]      # --drain lets in-flight work finish first
omo daemon handoff             # hand the socket to THIS build, keeping live sessions
```

Bare `omo` never ensures a daemon. Only `run`, `attach` and `handoff` can bring one
into existence; `status` and `stop` work on an install whose plugin payload was
never built.

## Where it lives

| What | Where |
| --- | --- |
| Socket | `<agentDir>/rpc/rpc.sock` (the canonical agent dir, see `omo doctor`) |
| Host state (v2, fail-closed) | `<agentDir>/rpc/host/` — never a flat legacy pidfile, so a deployed older client cannot mistake this host for its own |
| Launch spec | `<pluginRoot>/daemon-launch-spec.json`, shipped inside the omo plugin payload |
| Child env | `OMO_ENABLE_SHARED_HOST=1` and `OMO_RPC_SOCKET=<socket>` (what `attach` prints) |

## Launch spec

The spec is the **only** argv source for the daemon — `omo daemon run`, a
child-triggered ensure and the desktop server all read the same file, so they
cannot drift from one another. It is a small JSON document:

```json
{ "schemaVersion": 1, "argv": ["--mode", "rpc", "..."], "env": { } }
```

Trust rules match the engine's own: a group- or world-writable spec, or one whose
path contains `..`, is refused before anything is started. Edit the spec by
rebuilding the plugin, not by hand.

## Policy and configuration (`omo.json`)

| Key | Values | Meaning |
| --- | --- | --- |
| `task.host_engine_policy` | `upgrade` (default) · `fallback` · `never` | what `run` may do when a host from another build already serves the socket |
| `task.host_idle_exit_ms` | milliseconds | the daemon exits after this long with no sessions |
| `task.default_execution_mode` | `auto` · `in-process` · `process` | see *Execution mode* below |
| `task.process_runner` | `host` · `child-process` | which runner a `process` child gets |

`--no-upgrade` on the command line forces `never` for that call. A flag beats
config; config beats the default.

### Generations and handoff

Every build carries an ordinal (`<calver>+<build epoch>.<sha>`) and a launch
profile id. With `upgrade`, a newer build that finds an older host serving the
socket asks it to **hand off**: the old generation drains, the new one takes the
socket, live sessions keep their transcripts (the same session path, more lines,
never fewer) and the old process exits. Two builds whose ordinals cannot be
compared — different launch profiles, or an ordinal the host does not report —
never hand off; the newer side reuses or refuses, and says why.

## Execution mode: what `auto` does

With `task.default_execution_mode: auto` the parent session resolves the mode
**once**, at its first daemon ensure:

- daemon reachable and it advertises what `auto` needs (session kind/context,
  retain-on-disconnect, the host protocol) → children run as **sessions in the
  daemon** (`process` mode, `host` runner);
- otherwise → **in-process**, exactly as before.

An unresolved `auto` reads as in-process, so no child is ever routed on a guess.
A user-set `in-process` / `process`, and every per-agent `execution_mode`, still
wins over the daemon check. Real fallbacks to a per-child process happen only for
a capability or policy `engine_mismatch`, on win32, or on a Node without bun.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done — the engine's `action` says which of start / reuse / handoff |
| 2 | usage: no subcommand, or an unknown one (the engine is not called) |
| 3 | `status`: no daemon answers (`daemon: not running`) |
| 4 | unsupported platform: win32 has no unix socket to share (the engine is not called) |
| 5 | the engine refused — read its line; the launch spec may be missing |

## Troubleshooting

**`daemon: not running`** — nothing serves the socket. `omo daemon run` starts one;
if it exits 5, read the engine's reason (a missing spec means the plugin payload
was not built for this install).

**`omo doctor` → `INFO Daemon: running pid … · zombies N`** — `zombies` counts
child processes the host has reaped-but-not-collected; it should be 0. A growing
number means a tool spawned processes the host never waited on; file it with the
tool name.

**`legacy host (no session context)`** — an older engine, started before the v2
state dir, is serving the socket. It has no session kind/context and cannot be
handed off to; `omo daemon stop` (or wait for its idle exit), then `run`.

**Threads grow with sessions** — about one OS thread per session is expected while
the `config-reload` builtin spawns a filesystem-watch worker per session
(tracked upstream as senpi#1794); with that builtin disabled the increment is 0.
It is linear, not flat; size a long-lived daemon from those numbers.

See also: [omob dev binary](./omob-dev-binary.md), [omo.json](./omo-json.md),
[senpi-task guide](../guide/senpi-task.md).
