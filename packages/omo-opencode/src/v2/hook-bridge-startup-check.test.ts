/// <reference types="bun-types" />
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { PROCESS_STARTUP_CHECK_HOOK, registerV1Hooks, resetProcessStartupCheckHandoffForTests } from "./hook-bridge"
import { createAutoUpdateCheckerHook } from "../hooks/auto-update-checker/hook"

// fix 73: probes A/B/C from the isolated core reproduction, against the real
// auto-update-checker hook and the real fix-50 ownership guard.
//   A  first root session in a folder with no plugin instance (warm instance elsewhere)
//   B  a second root session in that same folder
//   C  control: a root session in the warm instance's own folder

const WARM = "C:/chats/warm"
const NEW = "C:/chats/2026-10-25/session-new"
const DEFERRED_MS = 5000

type Raw = { type: string; data: Record<string, unknown> }

function eventStream() {
  const queue: Raw[] = []
  let wake: (() => void) | undefined
  return {
    push(raw: Raw) {
      queue.push(raw)
      wake?.()
    },
    subscribe({ signal }: { signal: AbortSignal }) {
      return (async function* () {
        while (!signal.aborted) {
          if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }) })
          while (queue.length) yield queue.shift()!
        }
      })()
    },
  }
}

function setup() {
  const directories = new Map<string, { directory: string; parentID?: string }>()
  const stream = eventStream()
  const ctx = {
    location: { directory: WARM },
    session: {
      hook: async () => {},
      get: async ({ sessionID }: { sessionID: string }) => {
        const info = directories.get(sessionID)
        return info ? { id: sessionID, ...info } : undefined
      },
    },
    event: { subscribe: stream.subscribe },
  } as unknown as Plugin.Context

  const refreshes = { capabilities: 0, connectedProviders: 0 }
  const perSessionEvents: Array<{ type: string; sessionID?: string }> = []
  const checker = createAutoUpdateCheckerHook({ directory: WARM } as never, { showStartupToast: false }, {
    getCachedVersion: () => null,
    getLocalDevVersion: () => "0.0.0-test",
    showConfigErrorsIfAny: async () => {},
    updateAndShowConnectedProvidersCacheStatus: async () => { refreshes.connectedProviders++ },
    refreshModelCapabilitiesOnStartup: async () => { refreshes.capabilities++ },
    showModelCacheWarningIfNeeded: async () => {},
    showLocalDevToast: async () => {},
    showVersionToast: async () => {},
    runBackgroundUpdateCheck: async () => {},
    log: () => {},
  })
  const hooks = {
    // Production composition: the dispatcher runs the checker first, then the per-session hooks.
    event: async (input: { event: { type: string; properties: Record<string, unknown> } }) => {
      checker.event(input)
      perSessionEvents.push({ type: input.event.type, sessionID: input.event.properties.sessionID as string | undefined })
    },
    [PROCESS_STARTUP_CHECK_HOOK]: checker.event,
  }
  const created = (sessionID: string, directory: string, parentID?: string) => {
    directories.set(sessionID, { directory, ...(parentID ? { parentID } : {}) })
    stream.push({ type: "session.created", data: { sessionID, ...(parentID ? { parentID } : {}) } })
  }
  return { ctx, hooks, stream, created, refreshes, perSessionEvents, directories }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => resetProcessStartupCheckHandoffForTests())
afterEach(() => resetProcessStartupCheckHandoffForTests())

test("A/B: a new chat folder's root session runs the process startup check once, without the per-session hooks", async () => {
  const t = setup()
  const dispose = await registerV1Hooks(t.ctx, t.hooks)
  try {
    t.created("ses_a", NEW)
    await sleep(DEFERRED_MS + 400)
    expect(t.refreshes).toEqual({ capabilities: 1, connectedProviders: 1 })
    expect(t.perSessionEvents).toEqual([])

    t.created("ses_b", NEW)
    await sleep(300)
    expect(t.refreshes).toEqual({ capabilities: 1, connectedProviders: 1 })
    expect(t.perSessionEvents).toEqual([])
  } finally {
    dispose()
  }
}, 15000)

test("C (control): a root session in the warm folder runs the check through the owned path", async () => {
  const t = setup()
  const dispose = await registerV1Hooks(t.ctx, t.hooks)
  try {
    t.created("ses_c", WARM)
    await sleep(DEFERRED_MS + 400)
    expect(t.refreshes).toEqual({ capabilities: 1, connectedProviders: 1 })
    expect(t.perSessionEvents).toEqual([{ type: "session.created", sessionID: "ses_c" }])
  } finally {
    dispose()
  }
}, 15000)

test("unowned child sessions and other unowned session events reach nothing (fix 50 unchanged)", async () => {
  const t = setup()
  const dispose = await registerV1Hooks(t.ctx, t.hooks)
  try {
    t.directories.set("ses_parent", { directory: NEW })
    t.created("ses_child", NEW, "ses_parent")
    t.stream.push({ type: "session.execution.failed", data: { sessionID: "ses_parent", error: { message: "x" } } })
    await sleep(DEFERRED_MS + 400)
    expect(t.refreshes).toEqual({ capabilities: 0, connectedProviders: 0 })
    expect(t.perSessionEvents).toEqual([])
  } finally {
    dispose()
  }
}, 15000)
