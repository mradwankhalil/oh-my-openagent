import { describe, expect, test } from "bun:test"

import {
  AUTO_HOST_CAPABILITIES,
  createExecutionModeGate,
  resolveAutoExecutionMode,
  resolveExecutionMode,
} from "./execution-mode"

describe("resolveExecutionMode", () => {
  test("#given a spec mode #when resolved #then the spec mode wins over every other source", () => {
    // given
    const sources = { specMode: "process" as const, agentMode: "in-process" as const, configMode: "in-process" as const }

    // when
    const mode = resolveExecutionMode(sources)

    // then
    expect(mode).toBe("process")
  })

  test("#given no spec mode but an agent mode #when resolved #then the agent mode wins over config", () => {
    // given
    const sources = { agentMode: "process" as const, configMode: "in-process" as const }

    // when
    const mode = resolveExecutionMode(sources)

    // then
    expect(mode).toBe("process")
  })

  test("#given only a config mode #when resolved #then the config mode is used", () => {
    // given
    const sources = { configMode: "process" as const }

    // when
    const mode = resolveExecutionMode(sources)

    // then
    expect(mode).toBe("process")
  })

  test("#given no source at all #when resolved #then it falls back to in-process", () => {
    // given
    const sources = {}

    // when
    const mode = resolveExecutionMode(sources)

    // then
    expect(mode).toBe("in-process")
  })
})

describe("resolveExecutionMode with a configured auto mode", () => {
  test("#given config auto and a resolved auto mode #when resolved #then the resolved mode is used", () => {
    // given
    const sources = { configMode: "auto" as const, autoMode: "process" as const }

    // when / then
    expect(resolveExecutionMode(sources)).toBe("process")
  })

  test("#given config auto that has not resolved yet #when resolved #then it falls back to in-process", () => {
    // given / when / then
    expect(resolveExecutionMode({ configMode: "auto" })).toBe("in-process")
  })

  test("#given config auto and an explicit spec or agent mode #when resolved #then the explicit mode still wins", () => {
    // given / when / then
    expect(resolveExecutionMode({ configMode: "auto", autoMode: "process", specMode: "in-process" })).toBe("in-process")
    expect(resolveExecutionMode({ configMode: "auto", autoMode: "process", agentMode: "in-process" })).toBe("in-process")
  })

  test("#given an explicit config mode and a resolved auto mode #when resolved #then the auto mode is ignored", () => {
    // given / when / then
    expect(resolveExecutionMode({ configMode: "in-process", autoMode: "process" })).toBe("in-process")
  })
})

describe("resolveAutoExecutionMode", () => {
  const posixHost = { platform: "darwin" as const, processRunner: "host" as const }

  test("#given a posix host runner and a daemon advertising the session capabilities #when resolved #then children run as daemon sessions", () => {
    // given / when / then
    expect(resolveAutoExecutionMode({ ...posixHost, capabilities: [...AUTO_HOST_CAPABILITIES, "multi_session"] })).toBe("process")
  })

  test("#given a daemon without generation_handoff #when resolved #then children stay in-process", () => {
    // given / when / then
    expect(resolveAutoExecutionMode({ ...posixHost, capabilities: ["session_context", "session_kind"] })).toBe("in-process")
  })

  test("#given no daemon at all #when resolved #then children stay in-process", () => {
    // given / when / then
    expect(resolveAutoExecutionMode({ ...posixHost, capabilities: undefined })).toBe("in-process")
  })

  test("#given win32 or the child-process runner #when resolved #then children stay in-process even with every capability", () => {
    // given / when / then
    expect(resolveAutoExecutionMode({ platform: "win32", processRunner: "host", capabilities: AUTO_HOST_CAPABILITIES })).toBe("in-process")
    expect(resolveAutoExecutionMode({ platform: "darwin", processRunner: "child-process", capabilities: AUTO_HOST_CAPABILITIES })).toBe("in-process")
  })
})

describe("createExecutionModeGate", () => {
  test("#given a gate #when ensure runs twice #then the daemon is asked exactly once and the answer is stable", async () => {
    // given
    let calls = 0
    const gate = createExecutionModeGate(() => {
      calls += 1
      return Promise.resolve("process" as const)
    })

    // when
    const first = await gate.ensure()
    const second = await gate.ensure()

    // then
    expect([first, second]).toEqual(["process", "process"])
    expect(calls).toBe(1)
    expect(gate.current()).toBe("process")
  })

  test("#given a gate that resolved to process #when the daemon later goes down #then the parent session keeps the resolved mode", async () => {
    // given
    let daemonAlive = true
    const gate = createExecutionModeGate(() =>
      daemonAlive ? Promise.resolve("process" as const) : Promise.reject(new Error("daemon is gone")),
    )
    await gate.ensure()

    // when
    daemonAlive = false

    // then
    expect(await gate.ensure()).toBe("process")
    expect(gate.current()).toBe("process")
  })

  test("#given a resolution that throws #when ensure runs #then the gate settles on in-process instead of rejecting", async () => {
    // given
    const gate = createExecutionModeGate(() => Promise.reject(new Error("host unavailable (capability)")))

    // when
    const mode = await gate.ensure()

    // then
    expect(mode).toBe("in-process")
    expect(gate.current()).toBe("in-process")
  })

  test("#given a gate that has never been ensured #when current is read #then it is undefined", () => {
    // given / when / then
    expect(createExecutionModeGate(() => Promise.resolve("process" as const)).current()).toBeUndefined()
  })
})
