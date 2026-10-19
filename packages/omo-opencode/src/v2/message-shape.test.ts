import { describe, expect, test } from "bun:test"
import { hookMessagesToV1, storedMessagesToV1 } from "./message-shape"

describe("storedMessagesToV1", () => {
  // OpenCode 2 stores a tool call as { type: "tool", id, name, state } (seen in session_message rows
  // on 2.0.32); the v1 hook code reads part.tool and part.callID.
  test("aliases the stored tool part name and id to the v1 tool and callID fields", () => {
    const view = storedMessagesToV1(
      [
        {
          type: "assistant",
          id: "msg_1",
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude" },
          content: [
            { type: "reasoning", text: "Run it." },
            {
              type: "tool",
              id: "call_1",
              name: "execute",
              executed: true,
              state: { status: "completed", input: { code: "1" }, content: [], metadata: {} },
              time: { start: 1, end: 2 },
            },
          ],
        },
      ],
      "ses_1",
    )
    expect(view).toHaveLength(1)
    expect(view[0]?.parts[0]).toEqual({ type: "reasoning", text: "Run it." })
    expect(view[0]?.parts[1]).toMatchObject({
      type: "tool",
      id: "call_1",
      name: "execute",
      tool: "execute",
      callID: "call_1",
      state: { status: "completed", input: { code: "1" } },
    })
  })

  test("keeps an explicit v1 tool field and leaves non-tool parts untouched", () => {
    const view = storedMessagesToV1(
      [
        {
          type: "assistant",
          id: "msg_1",
          content: [
            { type: "tool", id: "call_1", name: "bash", tool: "Bash", callID: "call_legacy", state: { status: "completed", input: {} } },
            { type: "text", text: "done" },
          ],
        },
      ],
      "ses_1",
    )
    expect(view[0]?.parts[0]).toMatchObject({ tool: "Bash", callID: "call_legacy", name: "bash" })
    expect(view[0]?.parts[1]).toEqual({ type: "text", text: "done" })
  })

  test("does not add v1 aliases to the hook message view that is written back to the host", () => {
    const stored = { type: "assistant", id: "msg_1", content: [{ type: "tool", id: "call_1", name: "read", state: { status: "completed", input: {} } }] }
    const view = hookMessagesToV1([stored], "ses_1")
    expect(view[0]?.parts[0]).not.toHaveProperty("tool")
    expect(view[0]?.parts[0]).not.toHaveProperty("callID")
  })
})
