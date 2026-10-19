import { log } from "../../shared"
import type { PendingParentWake } from "./parent-wake-dedupe"
import type { ParentWakeDispatchedTracker } from "./parent-wake-dispatched-tracker"
import type { ParentWakeSessionInspector } from "./parent-wake-session-inspector"
import { parentWakeDeliveryTimeLeft } from "./parent-wake-visible-notice"

type ParentWakeWindowRecoveryInput = {
  readonly sessionID: string
  readonly wake: PendingParentWake
  readonly dispatchedTracker: ParentWakeDispatchedTracker
  readonly sessionInspector: ParentWakeSessionInspector
  readonly requeueWake: (wake: PendingParentWake) => void
  readonly scheduleFlush: (delayMs?: number) => void
  readonly sendVisibleNotice: (wake: PendingParentWake) => Promise<void>
}

export async function handleDispatchedParentWakeWindowElapsed(
  input: ParentWakeWindowRecoveryInput,
): Promise<void> {
  const currentWake = input.dispatchedTracker.getWake(input.sessionID)
  if (!currentWake || currentWake.dispatchedAt !== input.wake.dispatchedAt) {
    return
  }

  if (await input.sessionInspector.hasAssistantOrToolOutputAfterDispatchedWake(input.sessionID, input.wake)) {
    input.dispatchedTracker.clearWake(input.sessionID)
    log("[background-agent] Cleared dispatched parent wake after observing assistant output:", {
      sessionID: input.sessionID,
    })
    return
  }

  const retryCount = input.wake.noAssistantOutputRetryCount ?? 0
  const timeLeft = parentWakeDeliveryTimeLeft(input.wake)
  if (!input.wake.shouldReply || timeLeft === 0) {
    if (input.wake.shouldReply) {
      await input.sendVisibleNotice(input.wake)
    }
    input.dispatchedTracker.clearWake(input.sessionID)
    log("[background-agent] Finished parent wake recovery without another model turn:", {
      sessionID: input.sessionID,
      retryCount,
    })
    return
  }

  input.dispatchedTracker.clearWake(input.sessionID)
  input.wake.noAssistantOutputRetryCount = retryCount + 1
  input.requeueWake(input.wake)
  const retryDelayMs = Math.min(1_000 * 2 ** Math.min(retryCount, 3), 8_000, timeLeft)
  input.scheduleFlush(retryDelayMs)
  log("[background-agent] Requeued dispatched parent wake after no assistant output:", {
    sessionID: input.sessionID,
    retryCount: input.wake.noAssistantOutputRetryCount,
    retryDelayMs,
    timeLeft,
  })
}

export function logParentWakeWindowRecoveryError(sessionID: string, error: unknown): void {
  const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  log("[background-agent] Failed to inspect dispatched parent wake after recovery window:", {
    sessionID,
    error: errorText,
  })
}

export function rescheduleParentWakeWindowRecoveryAfterError(
  sessionID: string,
  wake: PendingParentWake,
  dispatchedTracker: ParentWakeDispatchedTracker,
): void {
  const currentWake = dispatchedTracker.getWake(sessionID)
  if (!currentWake || currentWake.dispatchedAt !== wake.dispatchedAt) {
    return
  }
  dispatchedTracker.refreshWakeTimer(sessionID)
}
