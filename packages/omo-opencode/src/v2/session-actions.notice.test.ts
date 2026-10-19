/// <reference types="bun-types" />
import { expect, test } from "bun:test"
import { sendPrompt } from "./session-actions"

for (const notice of [true, false]) test(`background completion notice=${notice} controls no-turn admission without changing ordinary prompts`, async () => {
  const calls: { text: string; resume?: boolean }[] = []
  const api = {
    get: async () => ({}), context: async () => [], create: async () => ({}), interrupt: async () => ({}),
    switchAgent: async () => {}, switchModel: async () => {}, update: async () => {}, synthetic: async () => {},
    prompt: async (input: { text: string; resume?: boolean }) => { calls.push(input) },
  }
  await sendPrompt(api, { path: { id: "ses_notice" }, body: {
    ...(notice ? { noReply: true, metadata: { omoBackgroundTaskNotice: true } } : {}),
    parts: [{ type: "text", text: "[ALL BACKGROUND TASKS COMPLETE]\nbg_completed" }],
  } })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.text).toBe("[ALL BACKGROUND TASKS COMPLETE]\nbg_completed")
  expect(calls[0]?.resume).toBe(notice ? false : undefined)
})
