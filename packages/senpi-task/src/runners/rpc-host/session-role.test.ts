import { describe, expect, test } from "bun:test"

import { buildChildContext } from "./session-context"
import { readMemberSessionIdentity, readSessionRole } from "./session-role"
import type { RpcSpawnSpec } from "../rpc/spawn"

const NO_ENV: NodeJS.ProcessEnv = {}

function memberSpec(): RpcSpawnSpec {
  return {
    task_id: "st_00000001",
    cwd: "/tmp/dh-project",
    state_dir: "/tmp/dh-state",
    prompt: "work",
    memberEnv: {
      SENPI_TASK_MEMBER: "3f2504e0-4f89-41d3-9a0c-0305e82c3301::builder",
      SENPI_TASK_MEMBER_TASK_ID: "st_00000001",
      SENPI_TASK_TEAM_CONFIG: '{"stateDir":"/tmp/dh-state","members":["builder"]}',
    },
  }
}

describe("readSessionRole", () => {
  test("#given an interactive session #when the role is read #then no role is reported", () => {
    // given / when / then
    expect(readSessionRole({ sessionContext: {} }, NO_ENV)).toBeUndefined()
    expect(readSessionRole({}, NO_ENV)).toBeUndefined()
  })

  test("#given a session opened with each omo role #when read #then the role comes from the session, not the process", () => {
    // given / when / then
    expect(readSessionRole({ sessionContext: { role: "child" } }, NO_ENV)).toBe("child")
    expect(readSessionRole({ sessionContext: { role: "dag_child" } }, NO_ENV)).toBe("dag_child")
    expect(readSessionRole({ sessionContext: { role: "member" } }, NO_ENV)).toBe("member")
  })

  test("#given a role this build does not know #when read #then it still reads as omo-spawned child work", () => {
    // given / when / then
    expect(readSessionRole({ sessionContext: { role: "dream_child" } }, NO_ENV)).toBe("child")
  })

  test("#given no session context but the per-child process env #when read #then the env answers for that process", () => {
    // given / when / then
    expect(readSessionRole({}, { OMO_SENPI_TASK_RPC_CHILD: "1" })).toBe("child")
    expect(readSessionRole({}, { SENPI_TASK_MEMBER: "run::builder" })).toBe("member")
  })

  test("#given a host session whose opener labelled it #when the process env says otherwise #then the session wins", () => {
    // given / when / then
    expect(readSessionRole({ sessionContext: { role: "dag_child" } }, { OMO_SENPI_TASK_RPC_CHILD: "1" })).toBe("dag_child")
  })
})

describe("readMemberSessionIdentity", () => {
  test("#given the context a member child is opened with #when read back #then the writer's keys round-trip", () => {
    // given
    const { context } = buildChildContext(memberSpec())

    // when
    const identity = readMemberSessionIdentity({ sessionContext: context })

    // then
    expect(identity).toEqual({
      teamRunId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      memberName: "builder",
      teamConfig: '{"stateDir":"/tmp/dh-state","members":["builder"]}',
      taskId: "st_00000001",
      stateDir: "/tmp/dh-state",
    })
  })

  test("#given a non-member session or a half-filled member context #when read #then no identity is reported", () => {
    // given / when / then
    expect(readMemberSessionIdentity({ sessionContext: { role: "child", task_id: "st_1", state_dir: "/s" } })).toBeUndefined()
    expect(readMemberSessionIdentity({ sessionContext: { role: "member", team_run_id: "r", member_name: "b" } })).toBeUndefined()
    expect(readMemberSessionIdentity({})).toBeUndefined()
  })
})
