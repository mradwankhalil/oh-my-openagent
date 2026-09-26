import { isTeamMemberProcess } from "../../team/member-extension/identity"
import { OMO_SENPI_TASK_RPC_CHILD } from "../rpc/spawn"

/**
 * The READER of what `buildChildContext` writes. One extension set serves every session of the
 * shared daemon, so a component asks THIS what the session in front of it is instead of reading
 * process-wide environment variables that belong to whoever launched the process.
 *
 * The environment stays a fallback for the per-child process runner (win32, the daemon's loud
 * fallback, and every pre-daemon child), where one process really is one child.
 */

export const SESSION_ROLES = ["child", "dag_child", "member"] as const

export type SessionRole = (typeof SESSION_ROLES)[number]

/**
 * The per-session labels the opener attached (senpi `open_session.context` -> `pi.sessionContext`).
 * The argument is `unknown` on purpose: the pinned engine's `ExtensionAPI` predates the field, so
 * this IS the boundary that decides whether the running host reports one.
 */
export function readSessionContext(pi: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof pi !== "object" || pi === null || !("sessionContext" in pi)) return undefined
  const context = pi.sessionContext
  if (typeof context !== "object" || context === null) return undefined
  const entries = Object.entries(context).flatMap(([key, value]) => (typeof value === "string" ? [[key, value] as const] : []))
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/**
 * Which omo-spawned role this session serves, or undefined for an ordinary interactive session.
 * An unrecognized future role reads as the plain `child`: it is still omo-spawned work, so the
 * gates that only ask "is this a child?" keep holding, and only the roles this build knows about
 * get their own narrower treatment.
 */
export function readSessionRole(pi: unknown, env: NodeJS.ProcessEnv = process.env): SessionRole | undefined {
  const role = readSessionContext(pi)?.["role"]
  if (role !== undefined && role.length > 0) return isSessionRole(role) ? role : "child"
  if (isTeamMemberProcess(env)) return "member"
  return env[OMO_SENPI_TASK_RPC_CHILD] === "1" ? "child" : undefined
}

/** The member identity the daemon carries on the session, in place of the per-process env trio. */
export interface MemberSessionIdentity {
  readonly teamRunId: string
  readonly memberName: string
  readonly teamConfig: string
  readonly taskId: string
  readonly stateDir: string
}

export function readMemberSessionIdentity(pi: unknown): MemberSessionIdentity | undefined {
  const context = readSessionContext(pi)
  if (context?.["role"] !== "member") return undefined
  const { team_run_id: teamRunId, member_name: memberName, team_config: teamConfig, task_id: taskId, state_dir: stateDir } = context
  if (teamRunId === undefined || memberName === undefined || teamConfig === undefined) return undefined
  if (taskId === undefined || stateDir === undefined) return undefined
  return { teamRunId, memberName, teamConfig, taskId, stateDir }
}

function isSessionRole(value: string): value is SessionRole {
  return SESSION_ROLES.some((role) => role === value)
}
