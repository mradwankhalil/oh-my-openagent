import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { log } from "../shared/logger"

// fix: compaction-loop-breaker
// After N consecutive compactions that fail to reduce the reported context usage
// (input + cacheRead), stop triggering preemptive compaction for the session and
// write a handoff note. Observed on claude-code bridged sessions where the bridge
// carries its own conversation state: opencode compaction rewrites the DB view,
// but the bridge keeps sending the full unreduced history (~780K tokens), so the
// trigger re-fires every cooldown forever (ses_f10e47816, 2026-09-30: six
// compactions in 14 minutes, round 2 fired 29s after round 1 with ~100 chars of
// new content). Breaking the loop protects the user from unbounded cache-read
// burn and gives them a handoff to continue in a fresh session.

const LOOP_BREAKER_STRIKES = 2
const INEFFECTIVE_REDUCTION_RATIO = 0.7

export interface LoopBreakerTokenInfo {
  input?: number
  cache?: { read?: number }
}

interface ClientLike {
  tui: {
    showToast: (input: {
      body: { title: string; message: string; variant: "warning"; duration: number }
    }) => Promise<unknown>
  }
  session: {
    messages: (input: {
      path: { id: string }
      query?: { directory: string }
    }) => Promise<unknown>
  }
}

function totalUsage(tokens: LoopBreakerTokenInfo | undefined): number {
  if (!tokens) return 0
  return (tokens.input ?? 0) + (tokens.cache?.read ?? 0)
}

export function createCompactionLoopBreaker(args: {
  client: ClientLike
  directory: string
}) {
  const { client, directory } = args
  // Pre-compaction usage baseline, captured from tokenCache right before the
  // session.compacted handler deletes it.
  const baseline = new Map<string, number>()
  const ineffectiveStreak = new Map<string, number>()
  const broken = new Set<string>()

  const clear = (sessionID: string): void => {
    baseline.delete(sessionID)
    ineffectiveStreak.delete(sessionID)
    broken.delete(sessionID)
  }

  const isBroken = (sessionID: string): boolean => broken.has(sessionID)

  const onSessionCompacted = (sessionID: string, preCompactionTokens: LoopBreakerTokenInfo | undefined): void => {
    if (broken.has(sessionID)) return
    const pre = totalUsage(preCompactionTokens)
    if (pre <= 0) return
    baseline.set(sessionID, pre)
    log("[preemptive-compaction] loop-breaker tracking post-compaction usage", {
      sessionID,
      baseline: pre,
      ineffectiveStreak: ineffectiveStreak.get(sessionID) ?? 0,
    })
  }

  const fetchLastSummary = async (sessionID: string): Promise<string> => {
    try {
      const res = (await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      })) as { info?: Array<{ agent?: string; parts?: Array<{ type: string; text?: string }> }> }
      const messages = res?.info ?? []
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m?.agent === "compaction") {
          const text = (m.parts ?? [])
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text as string)
            .join("\n")
          if (text) return text.slice(0, 8000)
        }
      }
    } catch {
      // best-effort: the note is still useful without the summary
    }
    return ""
  }

  const writeHandoffNote = async (sessionID: string, context: {
    ineffectiveStreak: number
    baseline: number
    latest: number
    workingModel?: string
  }): Promise<string | null> => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      const dir = join(directory, ".omo", "handoffs")
      await mkdir(dir, { recursive: true })
      const summary = await fetchLastSummary(sessionID)
      const file = join(dir, `handoff-compaction-loop-${sessionID.slice(0, 12)}-${stamp}.md`)
      const body = [
        "# Handoff — compaction loop broken",
        "",
        `**Session:** \`${sessionID}\``,
        `**Time:** ${new Date().toISOString()}`,
        `**Working model:** ${context.workingModel ?? "unknown"}`,
        "",
        `## What happened`,
        `${context.ineffectiveStreak} consecutive compactions failed to reduce the context usage`,
        `(baseline ${context.baseline.toLocaleString()} tokens -> latest ${context.latest.toLocaleString()} tokens).`,
        `Auto-compaction is now DISABLED for this session: the provider bridge appears to keep`,
        `sending the full unreduced history regardless of opencode-side compaction.`,
        `Continuing this session burns cache reads without making progress.`,
        "",
        `## How to proceed`,
        `1. Start a fresh session in this directory.`,
        `2. Feed it this file plus the latest compaction summary below.`,
        `3. Do not resume the wedged session.`,
        "",
        summary ? `## Last compaction summary\n\n${summary}` : "_(last compaction summary unavailable)_",
        "",
      ].join("\n")
      await writeFile(file, body, "utf8")
      return file
    } catch (error) {
      log("[preemptive-compaction] loop-breaker failed to write handoff note", {
        sessionID,
        error: String(error),
      })
      return null
    }
  }

  // Returns true when this call broke the loop (caller need not do anything else).
  const onPostCompactionUsage = (sessionID: string, tokens: LoopBreakerTokenInfo, workingModel?: string): boolean => {
    if (broken.has(sessionID)) return false
    const pre = baseline.get(sessionID)
    if (pre === undefined) return false
    const post = totalUsage(tokens)
    if (post <= 0) return false
    // The baseline is consumed by the first post-compaction measurement.
    baseline.delete(sessionID)

    const ineffective = post > pre * INEFFECTIVE_REDUCTION_RATIO
    const streak = ineffective ? (ineffectiveStreak.get(sessionID) ?? 0) + 1 : 0
    ineffectiveStreak.set(sessionID, streak)

    if (!ineffective) {
      log("[preemptive-compaction] loop-breaker: compaction reduced usage, streak reset", {
        sessionID,
        pre,
        post,
      })
      return false
    }

    if (streak < LOOP_BREAKER_STRIKES) {
      log("[preemptive-compaction] loop-breaker: compaction did not reduce usage", {
        sessionID,
        pre,
        post,
        streak,
        strikes: LOOP_BREAKER_STRIKES,
      })
      return false
    }

    broken.add(sessionID)
    log("[preemptive-compaction] compaction loop detected: auto-compaction disabled for session (compaction-loop-breaker)", {
      sessionID,
      pre,
      post,
      streak,
    })

    void (async () => {
      const noteFile = await writeHandoffNote(sessionID, {
        ineffectiveStreak: streak,
        baseline: pre,
        latest: post,
        workingModel,
      })
      await client.tui
        .showToast({
          body: {
            title: "Compaction loop detected",
            message: noteFile
              ? `2 compactions did not shrink the context. Auto-compaction stopped. Handoff note: ${noteFile}`
              : "2 compactions did not shrink the context. Auto-compaction stopped. Start a fresh session.",
            variant: "warning",
            duration: 15000,
          },
        })
        .catch(() => {})
    })()

    return true
  }

  return {
    clear,
    isBroken,
    onSessionCompacted,
    onPostCompactionUsage,
  }
}
