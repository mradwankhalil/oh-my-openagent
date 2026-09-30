import type { OhMyOpenCodeConfig } from "../config"
import { isCompactionAgent } from "../shared/compaction-marker"
import { resolveMessageEventSessionID, resolveSessionEventID } from "../shared/event-session-id"
import type { ContextLimitModelCacheState } from "../shared/context-limit-resolver"

import { createPostCompactionDegradationMonitor } from "./preemptive-compaction-degradation-monitor"
import { runPreemptiveCompactionIfNeeded } from "./preemptive-compaction-trigger"
import { createCompactionLoopBreaker } from "./preemptive-compaction-loop-breaker"
import type {
  CachedCompactionState,
  PreemptiveCompactionContext,
  SummarizeAttempt,
  TokenInfo,
} from "./preemptive-compaction-types"

export function createPreemptiveCompactionHook(
  ctx: PreemptiveCompactionContext,
  pluginConfig: OhMyOpenCodeConfig,
  modelCacheState?: ContextLimitModelCacheState,
) {
  const compactionInProgress = new Set<string>()
  const compactedSessions = new Set<string>()
  const lastCompactionTime = new Map<string, number>()
  const summarizeStartedAt = new Map<string, SummarizeAttempt>()
  const tokenCache = new Map<string, CachedCompactionState>()

  const postCompactionMonitor = createPostCompactionDegradationMonitor({
    client: ctx.client,
    directory: ctx.directory,
    pluginConfig,
    tokenCache,
    compactionInProgress,
  })

  // fix: compaction-loop-breaker — after 2 consecutive compactions that do not
  // reduce the reported usage, disable preemptive compaction for the session and
  // write a handoff note (claude-code bridge keeps full history otherwise).
  const loopBreaker = createCompactionLoopBreaker({
    client: ctx.client,
    directory: ctx.directory,
  })

  const toolExecuteAfter = async (
    input: { tool: string; sessionID: string; callID: string },
    _output: { title: string; output: string; metadata: unknown }
  ) => {
    await runPreemptiveCompactionIfNeeded({
      ctx,
      pluginConfig,
      modelCacheState,
      sessionID: input.sessionID,
      tokenCache,
      compactionInProgress,
      compactedSessions,
      lastCompactionTime,
      summarizeStartedAt,
      loopBreaker,
    })
  }

  const eventHandler = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.deleted") {
      const sessionID = resolveSessionEventID(props)
      if (sessionID) {
        compactionInProgress.delete(sessionID)
        compactedSessions.delete(sessionID)
        lastCompactionTime.delete(sessionID)
        summarizeStartedAt.delete(sessionID)
        tokenCache.delete(sessionID)
        postCompactionMonitor.clear(sessionID)
        loopBreaker.clear(sessionID)
      }
      return
    }

    if (event.type === "session.compacted") {
      const sessionID = resolveSessionEventID(props)
      if (sessionID) {
        // The cached measurement is the pre-compaction prompt, which is above the
        // threshold by definition. Reusing it after the prompt has been replaced would
        // immediately justify another compaction (observed firing at 7% real usage).
        // Drop it; the next finished non-compaction assistant message re-populates it.
        loopBreaker.onSessionCompacted(sessionID, tokenCache.get(sessionID)?.tokens)
        tokenCache.delete(sessionID)
        postCompactionMonitor.onSessionCompacted(sessionID)
      }
      return
    }

    if (event.type === "message.updated") {
      const info = props?.info as {
        id?: string
        agent?: unknown
        role?: string
        sessionID?: string
        providerID?: string
        modelID?: string
        finish?: unknown
        tokens?: TokenInfo
        parts?: unknown
      } | undefined

      const sessionID = resolveMessageEventSessionID(props)
      const finish = info?.finish
      if (!info || info.role !== "assistant" || !finish || !sessionID) return
      if (isCompactionAgent(info.agent)) return

      if (info.providerID && info.tokens) {
        tokenCache.set(sessionID, {
          providerID: info.providerID,
          modelID: info.modelID ?? "",
          tokens: info.tokens,
          agent: typeof info.agent === "string" ? info.agent : undefined,
        })
        loopBreaker.onPostCompactionUsage(
          sessionID,
          info.tokens,
          info.modelID ? `${info.providerID}/${info.modelID}` : undefined,
        )
      }
      compactedSessions.delete(sessionID)

      await postCompactionMonitor.onAssistantMessageUpdated({
        sessionID,
        id: info.id,
        parts: info.parts,
      })
    }
  }

  return {
    "tool.execute.after": toolExecuteAfter,
    event: eventHandler,
  }
}
