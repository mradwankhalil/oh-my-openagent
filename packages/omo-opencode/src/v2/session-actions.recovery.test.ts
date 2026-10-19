/// <reference path="../../../../bun-test.d.ts" />
import { expect, it } from "bun:test"
import { sendPrompt } from "./session-actions"

function fixture() {
  const calls: string[] = []
  const promptInputs: { text: string; resume?: boolean }[] = []
  const session: Record<string, unknown> = { agent: "compaction" }
  const api = {
    get: async () => session, context: async () => [], create: async () => ({}), interrupt: async () => ({}),
    switchAgent: async ({ agent }: { agent: string }) => { calls.push("agent"); session.agent = agent },
    switchModel: async ({ model }: { model: unknown }) => { calls.push("model"); session.model = model },
    update: async () => { calls.push("permissions") },
    synthetic: async ({ text, resume }: { text: string; resume?: boolean }) => { expect(resume).toBe(false); calls.push(`synthetic:${text}`) },
    prompt: async (input: { text: string; resume?: boolean }) => { promptInputs.push(input); calls.push(`prompt:${input.text}`) },
  }
  return { api, calls, promptInputs }
}

it("restores internal noReply config through control APIs without a user prompt or tool-result payload", async () => {
  const { api, calls } = fixture()
  await sendPrompt(api, { path: { id: "ses_recovery" }, body: {
    noReply: true, agent: "atlas", model: { providerID: "claude-code", modelID: "claude-opus-5-5" }, tools: { bash: false },
    parts: [{ type: "text", synthetic: true, text: "[restore checkpointed session agent configuration after compaction]\n<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_INTERNAL_NOREPLY -->" }],
  } })
  expect(calls).toEqual(["agent", "model", "permissions"])
})

it("keeps general noReply context synthetic and ordinary user prompts reply-producing", async () => {
  const { api, calls } = fixture()
  await sendPrompt(api, { path: { id: "ses_context" }, body: { noReply: true, parts: [{ type: "text", text: "additional context" }] } })
  await sendPrompt(api, { path: { id: "ses_context" }, body: { parts: [{ type: "text", text: "user request" }] } })
  expect(calls).toEqual(["synthetic:additional context", "prompt:user request"])
})

it("persists a visible background completion notice without scheduling a model turn", async () => {
  const { api, calls, promptInputs } = fixture()
  await sendPrompt(api, { path: { id: "ses_notice" }, body: {
    noReply: true,
    metadata: { omoBackgroundTaskNotice: true },
    parts: [{ type: "text", text: "[ALL BACKGROUND TASKS COMPLETE]\nbg_completed" }],
  } })
  expect(calls).toEqual(["prompt:[ALL BACKGROUND TASKS COMPLETE]\nbg_completed"])
  expect(promptInputs[0]?.resume).toBe(false)
})
