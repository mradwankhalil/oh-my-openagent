/// <reference types="bun-types" />
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectV1Surface } from "./project-config"
import {
  collectOmoToolIDs,
  isOmoOwnedAgentID,
  NATIVE_SUBAGENT_TOOL,
  scopeAgentToolVisibility,
  type AgentDraftLike,
} from "./agent-tool-visibility"

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

function editorOf(agents: AgentDraftLike[]) {
  return {
    list: () => agents,
    update(id: string, fn: (agent: AgentDraftLike) => void) {
      const agent = agents.find((a) => a.id === id)
      if (agent) fn(agent)
    },
  }
}

const OMO_TOOLS = ["task", "call_omo_agent"]

function denyRule(action: string): Rule {
  return { action, resource: "*", effect: "deny" }
}

test("collectOmoToolIDs scopes delegation without hiding shared native utilities", () => {
  const tools = {
    task: { description: "d", execute: async () => "" },
    call_omo_agent: { execute: async () => "" },
    grep: { execute: async () => "" },
    glob: { execute: async () => "" },
    skill: { execute: async () => "" },
    edit: { execute: async () => "" },
    todowrite: { execute: async () => "" },
    broken: { description: "no execute" },
    "not-a-record": "nope",
  }
  expect(collectOmoToolIDs(tools)).toEqual(["task", "call_omo_agent"])
  expect(collectOmoToolIDs(undefined)).toEqual([])
})

test("ownership mirrors the delegation routing rule", () => {
  for (const owned of ["sisyphus", "Sisyphus - ultraworker", "Sisyphus-Junior", "oh-my-openagent/oracle", "explore", "librarian"]) {
    expect(isOmoOwnedAgentID(owned), owned).toBe(true)
  }
  for (const native of ["general", "build", "plan", "custom", "oh-my-openagent/custom", "oracle-custom"]) {
    expect(isOmoOwnedAgentID(native), native).toBe(false)
  }
  expect(isOmoOwnedAgentID("Localized Name", ["localized name"])).toBe(true)
  // Native primaries stay native even if a caller passes them as owned.
  expect(isOmoOwnedAgentID("build", ["build"])).toBe(false)
})

test("native and custom agents lose every OMO-owned tool", () => {
  const build: AgentDraftLike = { id: "build" }
  const general: AgentDraftLike = { id: "general", permissions: [denyRule("question"), denyRule("subagent")] }
  const custom: AgentDraftLike = { id: "my-custom-agent", permissions: [] }
  scopeAgentToolVisibility(editorOf([build, general, custom]), OMO_TOOLS)

  for (const agent of [build, general, custom]) {
    for (const tool of OMO_TOOLS) {
      expect(agent.permissions, `${agent.id} denies ${tool}`).toContainEqual(denyRule(tool))
    }
  }
  // Native agents keep their native delegation tool and their own rules.
  expect(build.permissions!.some((r) => r.action === NATIVE_SUBAGENT_TOOL)).toBe(false)
  expect(general.permissions!.slice(0, 2)).toEqual([denyRule("question"), denyRule("subagent")])
})

test("OMO-owned agents lose native subagent, keep OMO tools", () => {
  const sisyphus: AgentDraftLike = {
    id: "Sisyphus - ultraworker",
    permissions: [{ action: "task", resource: "*", effect: "allow" }],
  }
  const nested: AgentDraftLike = { id: "oh-my-openagent/oracle" }
  scopeAgentToolVisibility(editorOf([sisyphus, nested]), OMO_TOOLS)

  expect(sisyphus.permissions).toContainEqual(denyRule(NATIVE_SUBAGENT_TOOL))
  expect(nested.permissions).toEqual([denyRule(NATIVE_SUBAGENT_TOOL)])
  for (const tool of OMO_TOOLS) {
    expect(sisyphus.permissions!.some((r) => r.action === tool && r.effect === "deny"), tool).toBe(false)
  }
  // The explicit task allow stays untouched.
  expect(sisyphus.permissions).toContainEqual({ action: "task", resource: "*", effect: "allow" })
})

test("existing explicit rules are never overridden", () => {
  // A user custom agent that explicitly allows an OMO tool keeps that allow:
  // whollyDisabled applies the LAST matching rule, so an appended deny would
  // silently win — the scoper must not append one.
  const custom: AgentDraftLike = {
    id: "custom",
    permissions: [{ action: "task", resource: "*", effect: "allow" }],
  }
  scopeAgentToolVisibility(editorOf([custom]), ["task", "call_omo_agent"])
  expect(custom.permissions).toEqual([
    { action: "task", resource: "*", effect: "allow" },
    denyRule("call_omo_agent"),
  ])
})

test("core default wildcard allow does not make agent scoping a no-op", () => {
  const defaults: Rule[] = [{ action: "*", resource: "*", effect: "allow" }]
  const build: AgentDraftLike = { id: "build", permissions: structuredClone(defaults) }
  const sisyphus: AgentDraftLike = { id: "sisyphus", permissions: structuredClone(defaults) }
  scopeAgentToolVisibility(editorOf([build, sisyphus]), OMO_TOOLS)
  expect(build.permissions).toEqual([...defaults, ...OMO_TOOLS.map(denyRule)])
  expect(sisyphus.permissions).toEqual([...defaults, denyRule("subagent")])
})

test("replayed transforms are idempotent (config reload path)", () => {
  const build: AgentDraftLike = { id: "build" }
  const sisyphus: AgentDraftLike = { id: "sisyphus" }
  const editor = editorOf([build, sisyphus])
  scopeAgentToolVisibility(editor, OMO_TOOLS)
  const firstBuild = structuredClone(build.permissions)
  const firstSisyphus = structuredClone(sisyphus.permissions)
  scopeAgentToolVisibility(editor, OMO_TOOLS)
  scopeAgentToolVisibility(editor, OMO_TOOLS)
  expect(build.permissions).toEqual(firstBuild)
  expect(sisyphus.permissions).toEqual(firstSisyphus)
})

test("projectV1Surface installs scoped delegation rules and replays after host config reload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omo-tool-scope-"))
  try {
    // Mirror Agent.Info.default, including the wildcard allow omitted by the
    // original empty-editor tests. Core's real registry is exercised separately.
    const initial: AgentDraftLike[] = ["build", "general", "sisyphus"].map((id) => ({
      id, permissions: [{ action: "*", resource: "*", effect: "allow" }],
    }))
    initial[1].permissions!.push(denyRule("subagent"))
    let agents = structuredClone(initial)
    const transforms: Array<(editor: ReturnType<typeof editorOf>) => void> = []
    const registered: string[] = []
    const ctx = {
      agent: { transform: async (fn: typeof transforms[number]) => {
        transforms.push(fn)
        fn(editorOf(agents))
      } },
      tool: { transform: async (fn: (editor: object) => void) => fn({
        add: (tool: { name: string }) => registered.push(tool.name),
      }) },
      command: { transform: async () => {} },
      mcp: { transform: async () => {} },
    } as unknown as Parameters<typeof projectV1Surface>[0]["ctx"]
    await projectV1Surface({ ctx, directory, agentDirectory: join(directory, "agents"), config: {},
      tools: { task: { execute: async () => "" }, call_omo_agent: { execute: async () => "" },
        grep: { execute: async () => "" } },
    })
    for (const agent of agents.slice(0, 2)) {
      expect(agent.permissions).toContainEqual(denyRule("task"))
      expect(agent.permissions).toContainEqual(denyRule("call_omo_agent"))
      expect(agent.permissions!.some((rule) => rule.action === "grep")).toBe(false)
    }
    expect(agents[2].permissions).toContainEqual(denyRule("subagent"))
    expect(agents[2].permissions!.some((rule) => rule.action === "task")).toBe(false)
    expect(registered.sort()).toEqual(["call_omo_agent", "grep", "task"])
    const first = structuredClone(agents)
    agents = structuredClone(initial)
    for (const transform of transforms) transform(editorOf(agents))
    expect(agents).toEqual(first)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
