/// <reference types="bun-types" />
import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../../hooks/shared/prompt-async-gate"
import { ParentWakeNotifier } from "./parent-wake-notifier"
import { storedMessagesToV1 } from "../../v2/message-shape"

type ParentWakeNotifierClientForTest = ConstructorParameters<typeof ParentWakeNotifier>[0]["client"]
type PromptAsyncCall = Parameters<ParentWakeNotifierClientForTest["session"]["promptAsync"]>[0]

type SessionMessageStub = {
  readonly info?: {
    readonly role?: string
    readonly finish?: string
    readonly time?: { readonly created?: number }
  }
  readonly parts?: readonly { readonly type?: string; readonly text?: string }[]
}

const FINAL_WAKE = "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]\n</system-reminder>"

afterEach(() => setSystemTime())

function createNotifier(options: {
  readonly onPendingWakeRequeued?: (sessionID: string) => void
  readonly messages?: () => readonly SessionMessageStub[]
} = {}): {
  readonly notifier: ParentWakeNotifier
  readonly promptAsyncCalls: readonly PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const sessionMessages: readonly SessionMessageStub[] = [
    {
      info: {
        role: "assistant",
        finish: "stop",
        time: { created: Date.now() - 10_000 },
      },
    },
  ]
  const client: ParentWakeNotifierClientForTest = {
    session: {
      messages: async () => ({ data: options.messages?.() ?? sessionMessages }),
      status: async () => ({ data: {} }),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
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
      ...(options.onPendingWakeRequeued ? { onPendingWakeRequeued: options.onPendingWakeRequeued } : {}),
    },
    {
      pendingRetryMs: 1_000,
      acceptedMessageSkewMs: 100,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: 1,
      userMessageInProgressWindowMs: 0,
    },
  )
  return { notifier, promptAsyncCalls }
}

async function waitForTimer(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10)
  })
}

function releaseParentWakeHold(sessionID: string): void {
  const released = releasePromptAsyncReservation(sessionID, "test:simulate-expired-parent-wake-hold", {
    reservedBy: "background-agent-parent-wake",
  })
  expect(released).toBe(true)
}

describe("ParentWakeNotifier dispatched wake recovery", () => {
  test("#given a parent wake is accepted but produces no assistant output #when the recovery window elapses #then the wake is requeued for another dispatch", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier()
    const sessionID = "parent-window-no-continuation"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.notifications).toEqual([FINAL_WAKE])
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)

      // when
      await waitForTimer()

      // then
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getPendingParentWakes().get(sessionID)?.notifications).toEqual([FINAL_WAKE])
      expect(notifier.getPendingParentWakeTimers().has(sessionID)).toBe(true)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given a parent wake is accepted but produces no assistant output #when recovery requeues it #then the manager callback fires before the retry timer settles", async () => {
    // given
    const requeuedSessionIDs: string[] = []
    const { notifier, promptAsyncCalls } = createNotifier({
      onPendingWakeRequeued: (sessionID) => {
        requeuedSessionIDs.push(sessionID)
      },
    })
    const sessionID = "parent-window-requeue-callback"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)

      // when
      await waitForTimer()

      // then
      expect(requeuedSessionIDs).toEqual([sessionID])
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(true)
      expect(notifier.getPendingParentWakeTimers().has(sessionID)).toBe(true)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given a requeued parent wake still produces no assistant output #when its deadline elapses #then a visible no-turn fallback replaces further retries", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier()
    const sessionID = "parent-window-no-continuation-retry-budget"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      await waitForTimer()
      expect(notifier.getPendingParentWakes().get(sessionID)?.noAssistantOutputRetryCount).toBe(1)

      releaseParentWakeHold(sessionID)
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(2)

      // when
      setSystemTime(new Date(Date.now() + 60_000))
      await waitForTimer()

      // then
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getPendingParentWakeTimers().has(sessionID)).toBe(false)
      expect(promptAsyncCalls).toHaveLength(3)
      expect(promptAsyncCalls[2]?.body.noReply).toBe(true)
      const text = promptAsyncCalls[2]?.body.parts[0]?.text ?? ""
      expect(text.startsWith("<system-reminder>")).toBe(false)
      expect(text.includes("<!-- OMO_INTERNAL_")).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given a dispatched wake produces assistant output #when the recovery window elapses #then it is acknowledged without a retry or fallback", async () => {
    let messages: readonly SessionMessageStub[] = []
    const { notifier, promptAsyncCalls } = createNotifier({ messages: () => messages })
    const sessionID = "parent-window-output-acknowledged"
    notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)
    try {
      await notifier.flushPendingParentWake(sessionID)
      messages = [{ info: { role: "assistant", finish: "stop", time: { created: Date.now() } }, parts: [{ type: "text", text: "Result received" }] }]
      await waitForTimer()
      expect(promptAsyncCalls).toHaveLength(1)
      expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  for (const output of ["", "Native host result"]) {
    test(`#given V2 stored assistant content is ${output ? "nonempty" : "empty"} #when the wake recovery reads the real bridge #then acknowledgement matches output`, async () => {
      let messages: readonly SessionMessageStub[] = []
      const { notifier, promptAsyncCalls } = createNotifier({ messages: () => messages })
      const sessionID = `parent-native-output-${output.length}`
      notifier.queuePendingParentWake(sessionID, FINAL_WAKE, { agent: "sisyphus" }, true)
      try {
        await notifier.flushPendingParentWake(sessionID)
        messages = storedMessagesToV1([{
          id: "native-assistant", type: "assistant", finish: "stop",
          time: { created: Date.now(), completed: Date.now() },
          content: output ? [{ type: "text", text: output }] : [],
        }], sessionID)
        await waitForTimer()
        expect(promptAsyncCalls).toHaveLength(1)
        expect(notifier.getPendingParentWakes().has(sessionID)).toBe(output.length === 0)
        expect(notifier.getDispatchedParentWakes().has(sessionID)).toBe(false)
      } finally {
        notifier.shutdown()
        releaseAllPromptAsyncReservationsForTesting()
      }
    })
  }
})
