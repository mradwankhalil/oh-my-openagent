/// <reference types="bun-types" />
import { expect, test } from "bun:test"
import { storedMessagesToV1 } from "./message-shape"

test("preserves stored timestamps used to acknowledge parent wakes without mutating the host message", () => {
  const stored = { type: "assistant", id: "msg_time", time: { created: 123, completed: 456 }, content: [{ type: "text", text: "result" }] }
  const view = storedMessagesToV1([stored], "ses_time")
  expect(view[0]?.info.time).toEqual({ created: 123, completed: 456 })
  expect(view[0]?.info.time).not.toBe(stored.time)
})
