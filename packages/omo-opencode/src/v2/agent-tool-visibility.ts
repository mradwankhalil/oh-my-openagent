import { AGENT_DISPLAY_NAMES, getAgentConfigKey } from "../shared/agent-display-names"

/**
 * Native delegation tool. OMO agents delegate through tools.task instead, and the
 * OMO delegation routing rule already forbids native subagent for them — this deny
 * makes the configured surface match that rule.
 */
export const NATIVE_SUBAGENT_TOOL = "subagent"

const NATIVE_AGENT_IDS = new Set(["general", "build", "plan"])
const OMO_DELEGATION_TOOLS = new Set(["task", "call_omo_agent"])

type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

export type AgentDraftLike = {
  id: string
  permissions?: PermissionRule[]
}

/**
 * Structural view of the V2 AgentEditor. Generic over the draft so the host's
 * DeepMutable<Agent.Info> fits directly — its branded Agent.ID is not assignable
 * to plain string under the project typecheck, so id stays unknown here and is
 * stringified at the ownership check (runtime values are always strings).
 */
export type AgentEditorLike<D extends { id: unknown; permissions?: PermissionRule[] } = AgentDraftLike> = {
  list(): readonly D[]
  update(id: string, update: (agent: D) => void): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Scope delegation only: grep/glob/edit/skill can replace native utilities. */
export function collectOmoToolIDs(tools: unknown): string[] {
  const ids: string[] = []
  if (isRecord(tools)) {
    for (const [name, value] of Object.entries(tools)) {
      if (OMO_DELEGATION_TOOLS.has(name) && isRecord(value) && typeof value.execute === "function") ids.push(name)
    }
  }
  return ids
}

/**
 * Ownership mirror of createOmoDelegationRouting: only explicit OMO definitions
 * establish ownership. Registered agent IDs may be config keys ("sisyphus"),
 * display names ("Sisyphus - ultraworker"), or nested ("oh-my-openagent/sisyphus");
 * general/build/plan and custom agents are never OMO-owned.
 */
export function isOmoOwnedAgentID(agentID: string, additionalOwnedIDs: readonly string[] = []): boolean {
  const id = agentID.startsWith("oh-my-openagent/") ? agentID.slice("oh-my-openagent/".length) : agentID
  if (NATIVE_AGENT_IDS.has(id.toLowerCase())) return false
  if (Object.hasOwn(AGENT_DISPLAY_NAMES, getAgentConfigKey(id))) return true
  return additionalOwnedIDs.some((owned) => owned.toLowerCase() === id.toLowerCase())
}

function mentionsAction(rules: readonly PermissionRule[], action: string): boolean {
  // Preserve action-specific overrides. Core inserts a wildcard allow into
  // EVERY Agent.Info.default, so treating it as an exemption defeats scoping.
  return rules.some((rule) => rule.action === action)
}

function denyOnce(draft: { permissions?: PermissionRule[] }, action: string): void {
  const rules = (draft.permissions ??= [])
  if (mentionsAction(rules, action)) return
  rules.push({ action, resource: "*", effect: "deny" })
}

/**
 * Core snapshots already use the selected agent's current permissions. Scope
 * the competing delegation entry points there, before both direct definitions
 * and the Code Mode catalog are built; never delete from the shared registry.
 * Native general's own subagent deny is intentionally preserved.
 * Replays are idempotent; action-specific user overrides remain authoritative.
 */
export function scopeAgentToolVisibility<D extends { id: unknown; permissions?: PermissionRule[] }>(
  editor: AgentEditorLike<D>,
  omoToolIDs: readonly string[],
  additionalOwnedIDs: readonly string[] = [],
): void {
  for (const agent of editor.list()) {
    const id = String(agent.id)
    if (isOmoOwnedAgentID(id, additionalOwnedIDs)) {
      editor.update(id, (draft) => denyOnce(draft, NATIVE_SUBAGENT_TOOL))
      continue
    }
    editor.update(id, (draft) => {
      for (const tool of omoToolIDs) denyOnce(draft, tool)
    })
  }
}
