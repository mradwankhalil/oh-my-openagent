import { dispatchInternalPrompt, isInternalPromptDispatchAccepted } from "../../hooks/shared/prompt-async-gate"
import { log } from "../../shared"
import type { PendingParentWake } from "./parent-wake-dedupe"
import type { ParentWakeNotifierDeps } from "./parent-wake-notifier-types"

const PARENT_WAKE_DELIVERY_DEADLINE_MS = 60_000

export function parentWakeDeliveryTimeLeft(wake: PendingParentWake): number {
  return Math.max(0, (wake.deliveryStartedAt ?? wake.dispatchedAt ?? Date.now()) + PARENT_WAKE_DELIVERY_DEADLINE_MS - Date.now())
}

export function visibleParentWakeText(wake: PendingParentWake): string {
  return wake.notifications.map((notification) => {
    const text = notification.trim()
    return text.startsWith("<system-reminder>") && text.endsWith("</system-reminder>")
      ? text.slice("<system-reminder>".length, -"</system-reminder>".length).trim()
      : text
  }).join("\n\n")
}

export async function sendParentWakeVisibleNotice(
  deps: Pick<ParentWakeNotifierDeps, "client" | "directory">,
  sessionID: string,
  wake: PendingParentWake,
): Promise<void> {
  const result = await dispatchInternalPrompt({
    mode: "async",
    client: deps.client,
    sessionID,
    source: "background-agent-parent-wake-notice",
    settleMs: 0,
    checkStatus: false,
    checkToolState: false,
    durableRetry: true,
    input: {
      path: { id: sessionID },
      query: { directory: deps.directory },
      body: {
        noReply: true,
        metadata: { omoBackgroundTaskNotice: true },
        parts: [{ type: "text", text: visibleParentWakeText(wake) }],
      },
    },
  })
  if (!isInternalPromptDispatchAccepted(result)) {
    throw new Error(`Visible parent wake notice not accepted: ${result.status}`)
  }
  log("[background-agent] Queued visible parent wake notice after delivery deadline:", { sessionID, status: result.status })
}
