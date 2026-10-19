/// <reference types="bun-types" />
import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../../hooks/shared/prompt-async-gate"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { PromptDispatchClient } from "@oh-my-opencode/utils/prompt-async-gate/types"
import type { PendingParentWake } from "./parent-wake-dedupe"
import { ParentWakeNotifier } from "./parent-wake-notifier"
import { sendParentWakePrompt } from "./parent-wake-prompt-dispatch"
import { storedMessagesToV1 } from "../../v2/message-shape"

// Incident ses_eede11ad1ffe (2026-10-19): the parent (native "general" agent) took
// 20.2 s from the wake prompt to its first streamed token. The 5 s recovery window
// saw no output, requeued the wake, and the requeued wake later re-dispatched while
// the answer already existed, so the owner saw the completion twice.

type ParentWakeNotifierClientForTest = ConstructorParameters<typeof ParentWakeNotifier>[0]["client"]
type PromptAsyncCall = Parameters<ParentWakeNotifierClientForTest["session"]["promptAsync"]>[0]

const FINAL_WAKE = "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>"

afterEach(() => {
  setSystemTime()
  releaseAllPromptAsyncReservationsForTesting()
})

function createNotifier(messages: () => readonly unknown[]): {
  readonly notifier: ParentWakeNotifier
  readonly promptAsyncCalls: PromptAsyncCall[]
  readonly promptAsyncCallTimes: number[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const promptAsyncCallTimes: number[] = []
  const client: ParentWakeNotifierClientForTest = {
    session: {
      messages: async () => ({ data: messages() }),
      status: async () => ({ data: {} }),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
        promptAsyncCallTimes.push(performance.now())
        return { data: {} }
      },
    },
  }
  const notifier = new ParentWakeNotifier(
    {
      client,
      directory: "/tmp/test-omo",
      enqueueNotificationForParent: async (_sessionID, operation) => {
        await operation()
      },
    },
    {
      pendingRetryMs: 1_000,
      acceptedMessageSkewMs: 100,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: 1,
      userMessageInProgressWindowMs: 0,
    },
  )
  return { notifier, promptAsyncCalls, promptAsyncCallTimes }
}

async function waitForTimer(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10)
  })
}

function releaseParentWakeHold(sessionID: string): void {
  releasePromptAsyncReservation(sessionID, "test:simulate-expired-parent-wake-hold", {
    reservedBy: "background-agent-parent-wake",
  })
}

function streamingAssistant(sessionID: string, createdAt: number): unknown[] {
  return storedMessagesToV1([{
    id: "native-assistant-streaming", type: "assistant", agent: "general",
    time: { created: createdAt },
    content: [],
  }], sessionID)
}

function answeredAssistant(sessionID: string, createdAt: number): unknown[] {
  return storedMessagesToV1([{
    id: "native-assistant-answer", type: "assistant", agent: "general", finish: "stop",
    time: { created: createdAt, completed: createdAt + 24_000 },
    content: [{ type: "text", text: "The wake arrived as General. Fetching the result:" }],
  }], sessionID)
}

describe("parent wake answered after a slow first token", () => {
  test("#given the wake turn has started but not streamed yet #when the recovery window elapses #then the wake stays dispatched instead of being requeued", async () => {
    // given
    let messages: readonly unknown[] = []
    const { notifier, promptAsyncCalls } = createNotifier(() => messages)
    const sessionID = "parent-slow-first-token"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "general" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      messages = streamingAssistant(sessionID, Date.now())

      // when
      await waitForTimer()

      // then
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(true)

      // when the first token finally arrives
      messages = answeredAssistant(sessionID, Date.now())
      await waitForTimer()

      // then it is acknowledged with no retry and no fallback notice
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
      expect(promptAsyncCalls).toHaveLength(1)
    } finally {
      notifier.shutdown()
    }
  })

  test("#given a wake was requeued before its answer streamed #when the parent answers the first dispatch #then the requeued wake is dropped instead of re-dispatched", async () => {
    // given
    let messages: readonly unknown[] = []
    const { notifier, promptAsyncCalls } = createNotifier(() => messages)
    const sessionID = "parent-answered-after-requeue"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "general" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      const firstDispatchAt = notifier.getDispatchedParentWakes().get(sessionID)?.dispatchedAt ?? 0
      await waitForTimer()
      expect(notifier.getPendingParentWakes().get(sessionID)?.noAssistantOutputRetryCount).toBe(1)

      // when
      messages = answeredAssistant(sessionID, firstDispatchAt + 41)
      releaseParentWakeHold(sessionID)
      await notifier.flushPendingParentWake(sessionID)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
    }
  })

  test("#given a requeued wake whose first dispatch was answered #when the delivery deadline passes #then no fallback notice is deposited", async () => {
    // given
    let messages: readonly unknown[] = []
    const { notifier, promptAsyncCalls } = createNotifier(() => messages)
    const sessionID = "parent-answered-before-deadline"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "general" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      const firstDispatchAt = notifier.getDispatchedParentWakes().get(sessionID)?.dispatchedAt ?? 0
      await waitForTimer()
      messages = answeredAssistant(sessionID, firstDispatchAt + 20_212)

      // when
      setSystemTime(new Date(Date.now() + 60_000))
      await notifier.flushPendingParentWake(sessionID)

      // then
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
    }
  })

  test("#given a requeued wake with new notifications merged in #when the parent answered the earlier dispatch #then the new notifications are still delivered", async () => {
    // given
    let messages: readonly unknown[] = []
    const { notifier, promptAsyncCalls } = createNotifier(() => messages)
    const sessionID = "parent-answered-new-notification"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "general" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      const firstDispatchAt = notifier.getDispatchedParentWakes().get(sessionID)?.dispatchedAt ?? 0
      await waitForTimer()
      messages = answeredAssistant(sessionID, firstDispatchAt + 41)
      notifier.queuePendingParentWake(sessionID, "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]\nsecond batch\n</system-reminder>", { agent: "general" }, true)

      // when
      releaseParentWakeHold(sessionID)
      await notifier.flushPendingParentWake(sessionID)

      // then
      expect(promptAsyncCalls).toHaveLength(2)
    } finally {
      notifier.shutdown()
    }
  })
})

describe("parent wake retry identity", () => {
  const SESSION_ID = "parent-retry-identity"
  const START_MS = new Date("2026-10-19T22:08:14.357Z").getTime()

  function createClient(calls: unknown[]): PromptDispatchClient {
    return unsafeTestValue<PromptDispatchClient>({
      session: {
        status: async () => ({ data: { [SESSION_ID]: { type: "idle" } } }),
        messages: async () => ({ data: [] }),
        promptAsync: async (input: unknown) => { calls.push(input); return {} },
      },
    })
  }

  async function dispatchAt(nowMs: number, client: PromptDispatchClient, wake: PendingParentWake, forceNoReply: boolean): Promise<void> {
    setSystemTime(new Date(nowMs))
    await sendParentWakePrompt({
      client,
      directory: "/tmp",
      sessionID: SESSION_ID,
      latestWake: wake,
      forceNoReply,
      retainPendingWake: forceNoReply,
      emptyAssistantTurnRetry: false,
      toolWaitDecision: { defer: false, skipPromptGateToolStateCheck: true },
      getDispatchedWake: () => undefined,
      hasRecordedPromptAfterDispatch: async () => false,
      trackDispatchedWake: () => {},
      requeueWake: () => {},
      scheduleFlush: () => {},
    })
  }

  test("#given a retry was admitted as noReply #when the reply dispatch of the same retry follows inside the semantic hold #then it reaches the host instead of coalescing", async () => {
    // given
    const calls: unknown[] = []
    const client = createClient(calls)
    const wake: PendingParentWake = {
      notifications: [FINAL_WAKE],
      promptContext: { agent: "general" },
      shouldReply: true,
      queuedAt: START_MS,
      noAssistantOutputRetryCount: 1,
    }
    await dispatchAt(START_MS, client, wake, true)
    expect(calls).toHaveLength(1)

    // when (the log showed the reply 4.8 s later, after the 2 s hold expired)
    await dispatchAt(START_MS + 4_844, client, wake, false)

    // then
    expect(calls).toHaveLength(2)
    const reply = unsafeTestValue<{ body: { noReply: boolean } }>(calls[1])
    expect(reply.body.noReply).toBe(false)
  })
})

describe("first parent wake dispatch latency", () => {
  test("#given an idle parent and a fresh completion #when the wake flushes #then promptAsync is called promptly without a gate hold or coalesce", async () => {
    // given
    const { notifier, promptAsyncCalls, promptAsyncCallTimes } = createNotifier(() => [])
    const sessionID = "parent-first-wake-latency"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "general" }, true, 60_000)

    try {
      // when
      const startedAt = performance.now()
      await notifier.flushPendingParentWake(sessionID)

      // then: only the 150 ms idle settle stands between flush and dispatch
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
      expect((promptAsyncCallTimes[0] ?? Infinity) - startedAt).toBeLessThan(1_000)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.replyDispatchedAt).toBeDefined()
    } finally {
      notifier.shutdown()
    }
  })
})
