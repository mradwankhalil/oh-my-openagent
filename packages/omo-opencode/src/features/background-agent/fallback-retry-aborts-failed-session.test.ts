import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { tryFallbackRetry } from "./fallback-retry-handler"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { BackgroundTask } from "./types"
import type { ConcurrencyManager } from "./concurrency"
import type { OpencodeClient, QueueItem } from "./constants"

const sharedLogMock = mock(() => {})
const readConnectedProvidersCacheMock = mock(() => null)
const readProviderModelsCacheMock = mock(() => null)
const shouldRetryErrorMock = mock(() => true)
const getNextFallbackMock = mock((chain: FallbackEntry[], attempt: number) => chain[attempt])
const hasMoreFallbacksMock = mock((chain: FallbackEntry[], attempt: number) => attempt < chain.length)
const selectFallbackProviderMock = mock((providers: string[]) => providers[0])
const transformModelForProviderMock = mock((_provider: string, model: string) => model)

const retryHandlerDeps = {
  log: sharedLogMock,
  readConnectedProvidersCache: readConnectedProvidersCacheMock,
  readProviderModelsCache: readProviderModelsCacheMock,
  shouldRetryError: shouldRetryErrorMock,
  getNextFallback: getNextFallbackMock,
  hasMoreFallbacks: hasMoreFallbacksMock,
  selectFallbackProvider: selectFallbackProviderMock,
  transformModelForProvider: transformModelForProviderMock,
}

function createMockTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "test-task-1",
    description: "test task",
    prompt: "test prompt",
    agent: "sisyphus-junior",
    status: "error",
    parentSessionId: "parent-session-1",
    parentMessageId: "parent-message-1",
    fallbackChain: [{ model: "fallback-model-1", providers: ["provider-a"], variant: undefined }],
    attemptCount: 0,
    concurrencyKey: "provider-a/original-model",
    model: { providerID: "provider-a", modelID: "original-model" },
    ...overrides,
  }
}

function createMockConcurrencyManager(): ConcurrencyManager {
  return {
    release: mock(() => {}),
    acquire: mock(async () => {}),
    getConcurrencyKey: mock((model: string) => model),
    getQueueLength: mock(() => 0),
    getActiveCount: mock(() => 0),
  } as never
}

function createDefaultArgs(taskOverrides: Partial<BackgroundTask> = {}) {
  const processKeyFn = mock(() => {})
  const queuesByKey = new Map<string, QueueItem[]>()
  const idleDeferralTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const concurrencyManager = createMockConcurrencyManager()
  const abortMock = mock(async (): Promise<unknown> => ({}))
  const client = { session: { abort: abortMock } } as never as OpencodeClient
  const task = createMockTask(taskOverrides)

  return {
    task,
    errorInfo: { name: "OverloadedError", message: "model overloaded" },
    source: "polling",
    concurrencyManager,
    client,
    abortMock,
    idleDeferralTimers,
    queuesByKey,
    processKey: processKeyFn,
    deps: retryHandlerDeps,
  }
}

describe("tryFallbackRetry — exactly one live session per task", () => {
  afterAll(() => {
    mock.restore()
  })

  beforeEach(() => {
    shouldRetryErrorMock.mockImplementation(() => true)
    selectFallbackProviderMock.mockImplementation((providers: string[]) => providers[0])
    readProviderModelsCacheMock.mockReturnValue(null)
    readConnectedProvidersCacheMock.mockReturnValue(null)
    getNextFallbackMock.mockImplementation((chain: FallbackEntry[], attempt: number) => chain[attempt])
    hasMoreFallbacksMock.mockImplementation((chain: FallbackEntry[], attempt: number) => attempt < chain.length)
    transformModelForProviderMock.mockImplementation((_provider: string, model: string) => model)
  })

  test("aborts the failed original session before scheduling its retry", async () => {
    const args = createDefaultArgs({ sessionId: "failed-session-1" })

    const result = await tryFallbackRetry(args)

    expect(result).toBe(true)
    expect(args.abortMock).toHaveBeenCalledTimes(1)
    expect(args.abortMock.mock.calls[0]?.[0]).toEqual({ path: { id: "failed-session-1" } })
  })

  test("retries the abort once when the first abort does not confirm", async () => {
    const args = createDefaultArgs({ sessionId: "failed-session-2" })
    args.abortMock
      .mockImplementationOnce(async () => ({ error: { message: "abort failed" } }))
      .mockImplementationOnce(async () => ({}))

    const result = await tryFallbackRetry(args)

    expect(result).toBe(true)
    expect(args.abortMock).toHaveBeenCalledTimes(2)
    expect(args.abortMock.mock.calls[0]?.[0]).toEqual({ path: { id: "failed-session-2" } })
    expect(args.abortMock.mock.calls[1]?.[0]).toEqual({ path: { id: "failed-session-2" } })
  })

  test("does not abort when the task has no session", async () => {
    const args = createDefaultArgs({ sessionId: undefined })

    const result = await tryFallbackRetry(args)

    expect(result).toBe(true)
    expect(args.abortMock).not.toHaveBeenCalled()
  })
})
