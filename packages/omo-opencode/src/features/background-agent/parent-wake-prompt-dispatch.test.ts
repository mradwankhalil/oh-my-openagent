/// <reference types="bun-types" />
import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { PromptDispatchClient } from "@oh-my-opencode/utils/prompt-async-gate/types"
import type { PendingParentWake } from "./parent-wake-dedupe"
import { sendParentWakePrompt } from "./parent-wake-prompt-dispatch"

const SESSION_ID = "parent-session-gate-hold"
const HOLD_START_MS = new Date("2026-09-27T00:00:00.000Z").getTime()
const HOLD_MS = 2_000

afterEach(() => {
  setSystemTime()
  releaseAllPromptAsyncReservationsForTesting()
})

function createClient(calls: unknown[] = []): PromptDispatchClient {
  return unsafeTestValue<PromptDispatchClient>({
    session: {
      status: async () => ({ data: { [SESSION_ID]: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
      promptAsync: async (input: unknown) => { calls.push(input); return {} },
    },
  })
}

function createWake(notification: string): PendingParentWake {
  return {
    notifications: [notification],
    promptContext: { agent: "sisyphus" },
    shouldReply: true,
    queuedAt: HOLD_START_MS,
  }
}

async function dispatchAt(nowMs: number, client: PromptDispatchClient, wake: PendingParentWake): Promise<(number | undefined)[]> {
  setSystemTime(new Date(nowMs))
  const flushDelays: (number | undefined)[] = []
  await sendParentWakePrompt({
    client,
    directory: "/tmp",
    sessionID: SESSION_ID,
    latestWake: wake,
    emptyAssistantTurnRetry: false,
    toolWaitDecision: { defer: false, skipPromptGateToolStateCheck: false },
    getDispatchedWake: () => undefined,
    hasRecordedPromptAfterDispatch: async () => false,
    trackDispatchedWake: () => {},
    requeueWake: () => {},
    scheduleFlush: (delayMs) => {
      flushDelays.push(delayMs)
    },
  })
  return flushDelays
}

describe("sendParentWakePrompt promptAsync gate hold", () => {
  test("#given an idle reply-required completion #when dispatched #then its notice is visible instead of a system-reminder-only prompt", async () => {
    const calls: unknown[] = []
    await dispatchAt(HOLD_START_MS, createClient(calls), createWake("<system-reminder>\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>"))
    const call = unsafeTestValue<{ body: { noReply: boolean; parts: { text: string }[] } }>(calls[0])
    expect(call.body.noReply).toBe(false)
    expect(call.body.parts[0]?.text.startsWith("<system-reminder>")).toBe(false)
  })

  test("#given a dispatch with confirmed no output #when retried inside the semantic hold #then the host receives a second prompt", async () => {
    const calls: unknown[] = []
    const client = createClient(calls)
    const wake = createWake("<system-reminder>\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>")
    await dispatchAt(HOLD_START_MS, client, wake)
    wake.noAssistantOutputRetryCount = 1
    await dispatchAt(HOLD_START_MS + 5_000, client, wake)
    expect(calls).toHaveLength(2)
  })

  test("#given a live parent-wake hold #when a wake first meets it #then it backs off a full hold so the live turn can consume the admission", async () => {
    // given
    const client = createClient()
    expect(await dispatchAt(HOLD_START_MS, client, createWake("<system-reminder>first</system-reminder>"))).toEqual([])

    // when
    const delays = await dispatchAt(HOLD_START_MS + 1_000, client, createWake("<system-reminder>second</system-reminder>"))

    // then
    expect(delays).toEqual([HOLD_MS])
  })

})
