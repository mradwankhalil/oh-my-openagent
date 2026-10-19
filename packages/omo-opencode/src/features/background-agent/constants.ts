import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundTask, LaunchInput } from "./types"

export const TASK_TTL_MS = 30 * 60 * 1000
export const TERMINAL_TASK_TTL_MS = 30 * 60 * 1000
export const MIN_STABILITY_TIME_MS = 10 * 1000
export const DEFAULT_STALE_TIMEOUT_MS = 2_700_000
export const DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS = 3_600_000
export const DEFAULT_MAX_TOOL_CALLS = 4000
export const DEFAULT_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD = 20
export const DEFAULT_CIRCUIT_BREAKER_ENABLED = true
export const MIN_RUNTIME_BEFORE_STALE_MS = 30_000
export const DEFAULT_SESSION_GONE_TIMEOUT_MS = 60_000
export const MIN_IDLE_TIME_MS = 5000
export const POLLING_INTERVAL_MS = 3000
// How long a running child may stay continuously idle with open todos before its
// terminal assistant message is accepted as the final response and the task
// completes. The todo-continuation-enforcer resumes a parent within seconds
// (2 s countdown + 5 s cooldown), so 30 s bounds the wait without racing it;
// before this the only escape was the 45 min stale deadline.
export const TODO_CONTINUATION_GRACE_MS = 30_000
export const TASK_CLEANUP_DELAY_MS = 10 * 60 * 1000
export const TMUX_CALLBACK_DELAY_MS = 200


export type OpencodeClient = PluginInput["client"]

export interface MessagePartInfo {
  sessionID?: string
  type?: string
  tool?: string
}

export interface EventProperties {
  sessionID?: string
  info?: { id?: string }
  [key: string]: unknown
}

export interface BackgroundEvent {
  type: string
  properties?: EventProperties
}


export interface QueueItem {
  attemptID: string
  rawConcurrencyKey?: string
  task: BackgroundTask
  input: LaunchInput
}

export interface SubagentSessionCreatedEvent {
  sessionID: string
  parentID: string
  title: string
}

export type OnSubagentSessionCreated = (event: SubagentSessionCreatedEvent) => Promise<void>
