/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import { MIN_IDLE_TIME_MS } from "./constants"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

const SESSION_ID = "ses-final-message-child"

// A background child whose last turn IS its answer (an escalation, a blocker
// report): the session is idle, the terminal assistant message is non-empty,
// and the todo list still has open items. The todo-continuation-enforcer only
// drives parent sessions, so gating completion on todos deadlocks this child
// until the 45 min stale deadline. The grace window bounds that wait: while
// the child could still be resumed the manager waits; once the session has
// been continuously idle past the grace, the final response completes the
// task (manager/child-handle.ts:195 parity: complete on non-empty
// finalResponse) and the parent is notified.

type SessionStatus = { type: string }

function createPluginContext(client: object): PluginInput {
  const directory = tmpdir()
  return {
    project: {
      id: "test-project",
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    serverUrl: new URL("http://localhost:4096"),
    $: {} as PluginInput["$"],
    client: client as PluginInput["client"],
  }
}

function createManager(args: {
  status?: () => Promise<{ data: Record<string, SessionStatus> }>
  assistantText?: string
  todoContinuationGraceMs?: number
}): { manager: BackgroundManager; notified: string[] } {
  const client = {
    session: {
      status: args.status ?? (async () => ({ data: { [SESSION_ID]: { type: "idle" } } })),
      get: async () => ({ data: { id: SESSION_ID } }),
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      todo: async () => ({
        data: [
          { content: "inspect the lane", status: "in_progress", priority: "high" },
          { content: "implement the fix", status: "pending", priority: "high" },
        ],
      }),
      messages: async () => ({
        data: [
          { info: { role: "user", id: "msg-1" }, parts: [{ type: "text", text: "fix it" }] },
          {
            info: { role: "assistant", finish: "end_turn", id: "msg-2" },
            parts: [{ type: "text", text: args.assistantText ?? "ESCALATE: deep-high\n\nThe fix depends on a decision only the owner can make." }],
          },
        ],
      }),
    },
  }
  const manager = new BackgroundManager({
    pluginContext: createPluginContext(client),
    enableParentSessionNotifications: false,
    ...(args.todoContinuationGraceMs === undefined ? {} : { todoContinuationGraceMs: args.todoContinuationGraceMs }),
  })
  const notified: string[] = []
  ;(manager as unknown as { notifyParentSession: (task: BackgroundTask) => Promise<void> }).notifyParentSession = async (task) => {
    notified.push(task.id)
  }
  return { manager, notified }
}

function createRunningTask(): BackgroundTask {
  return {
    id: "bg_final_message_child",
    sessionId: SESSION_ID,
    parentSessionId: "parent-session",
    parentMessageId: "parent-msg",
    description: "child that ends on its final answer",
    prompt: "fix it",
    agent: "sisyphus-junior",
    status: "running",
    startedAt: new Date(Date.now() - (MIN_IDLE_TIME_MS + 10)),
    progress: { toolCalls: 3, lastUpdate: new Date() },
  }
}

describe("BackgroundManager todo-continuation grace (hook enabled)", () => {
  test("#given an idle child with open todos #when the grace has not elapsed #then it keeps waiting", async () => {
    //#given
    const { manager, notified } = createManager({})
    const task = createRunningTask()
    manager["tasks"].set(task.id, task)

    //#when a first poll stamps the continuous-idle window
    await manager["pollRunningTasks"]()
    manager.shutdown()

    //#then
    expect(task.status).toBe("running")
    expect(notified).toEqual([])
  })

  test("#given an idle child with a final response #when the grace expires #then it completes and notifies the parent", async () => {
    //#given
    const { manager, notified } = createManager({ todoContinuationGraceMs: 0 })
    const task = createRunningTask()
    manager["tasks"].set(task.id, task)

    //#when
    await manager["pollRunningTasks"]()
    manager.shutdown()

    //#then
    expect(task.status).toBe("completed")
    expect(notified).toEqual([task.id])
  })

  test("#given the child goes busy again #then the continuous-idle window restarts", async () => {
    //#given a session that idles, goes busy, then idles again
    let status: SessionStatus = { type: "idle" }
    const { manager, notified } = createManager({
      status: async () => ({ data: { [SESSION_ID]: status } }),
      todoContinuationGraceMs: 60_000,
    })
    const task = createRunningTask()
    manager["tasks"].set(task.id, task)

    //#when the first poll stamps the window
    await manager["pollRunningTasks"]()
    const stamped = task.idleBlockedSince
    expect(stamped).toBeDefined()

    //#and the session goes busy (todo-continuation resumed it)
    status = { type: "busy" }
    await manager["pollRunningTasks"]()

    //#then the stamp is cleared
    expect(task.idleBlockedSince).toBeUndefined()
    expect(task.status).toBe("running")

    //#and when it idles again the window restarts instead of completing on the old stamp
    status = { type: "idle" }
    // Date.now() has 1 ms resolution; wait so the restart stamp must be strictly later.
    await new Promise((resolve) => setTimeout(resolve, 2))
    await manager["pollRunningTasks"]()
    manager.shutdown()
    expect(task.idleBlockedSince?.getTime()).toBeGreaterThan(stamped!.getTime())
    expect(task.status).toBe("running")
    expect(notified).toEqual([])
  })

  test("#given the grace expired without any final response #then it keeps waiting", async () => {
    //#given an idle child whose last assistant turn has no text (a bare tool stop)
    const { manager, notified } = createManager({ assistantText: "   ", todoContinuationGraceMs: 0 })
    const task = createRunningTask()
    manager["tasks"].set(task.id, task)

    //#when
    await manager["pollRunningTasks"]()
    manager.shutdown()

    //#then there is no final response to complete on
    expect(task.status).toBe("running")
    expect(notified).toEqual([])
  })
})
