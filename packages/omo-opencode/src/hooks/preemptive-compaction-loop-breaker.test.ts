import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCompactionLoopBreaker } from "./preemptive-compaction-loop-breaker"

function makeClient(toasts: string[]) {
  return {
    tui: {
      showToast: async (input: { body: { title: string; message: string } }) => {
        toasts.push(`${input.body.title}: ${input.body.message}`)
      },
    },
    session: {
      messages: async () => ({
        info: [
          { agent: "compaction", parts: [{ type: "text", text: "SUMMARY-TEXT-FOR-HANDOFF" }] },
        ],
      }),
    },
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loop-breaker-"))
})

describe("compaction-loop-breaker", () => {
  test("two ineffective compactions break the loop and write a handoff note", async () => {
    const toasts: string[] = []
    const breaker = createCompactionLoopBreaker({ client: makeClient(toasts), directory: dir })

    // Round 1: baseline 780K, post-compaction still 782K -> ineffective strike 1
    breaker.onSessionCompacted("ses_a", { input: 1000, cache: { read: 779_000 } })
    let broke = breaker.onPostCompactionUsage("ses_a", { input: 1107, cache: { read: 781_000 } })
    expect(broke).toBe(false)
    expect(breaker.isBroken("ses_a")).toBe(false)

    // Round 2: still no reduction -> strike 2 -> broken
    breaker.onSessionCompacted("ses_a", { input: 1107, cache: { read: 781_000 } })
    broke = breaker.onPostCompactionUsage("ses_a", { input: 594, cache: { read: 786_000 } })
    expect(broke).toBe(true)
    expect(breaker.isBroken("ses_a")).toBe(true)

    // handoff note + toast land (async fire-and-forget)
    await new Promise((r) => setTimeout(r, 150))
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain("Compaction loop detected")
    const handoffDir = join(dir, ".omo", "handoffs")
    expect(existsSync(handoffDir)).toBe(true)
    const notes = readdirSync(handoffDir).filter((f) => f.startsWith("handoff-compaction-loop-ses_a"))
    expect(notes.length).toBe(1)
    const note = readFileSync(join(handoffDir, notes[0]), "utf8")
    expect(note).toContain("compaction loop broken")
    expect(note).toContain("SUMMARY-TEXT-FOR-HANDOFF")
    expect(note).toContain("ses_a")

    // further compaction reports are ignored once broken
    expect(breaker.onPostCompactionUsage("ses_a", { input: 500, cache: { read: 800_000 } })).toBe(false)
  })

  test("an effective compaction resets the streak", () => {
    const breaker = createCompactionLoopBreaker({ client: makeClient([]), directory: dir })

    // strike 1: no reduction
    breaker.onSessionCompacted("ses_b", { input: 0, cache: { read: 780_000 } })
    breaker.onPostCompactionUsage("ses_b", { input: 0, cache: { read: 785_000 } })
    expect(breaker.isBroken("ses_b")).toBe(false)

    // next round compaction WORKS (drops to 30K) -> streak reset
    breaker.onSessionCompacted("ses_b", { input: 0, cache: { read: 785_000 } })
    breaker.onPostCompactionUsage("ses_b", { input: 5_000, cache: { read: 25_000 } })
    expect(breaker.isBroken("ses_b")).toBe(false)

    // one more ineffective round is strike 1 again, not 2 -> not broken
    breaker.onSessionCompacted("ses_b", { input: 0, cache: { read: 25_000 } })
    breaker.onPostCompactionUsage("ses_b", { input: 0, cache: { read: 26_000 } })
    expect(breaker.isBroken("ses_b")).toBe(false)
  })

  test("post-usage without a compaction baseline is ignored", () => {
    const breaker = createCompactionLoopBreaker({ client: makeClient([]), directory: dir })
    // no onSessionCompacted happened (e.g. plugin restarted mid-flight)
    expect(breaker.onPostCompactionUsage("ses_c", { input: 999, cache: { read: 999_000 } })).toBe(false)
    expect(breaker.isBroken("ses_c")).toBe(false)
  })

  test("zero-usage compaction events never arm the baseline", () => {
    const breaker = createCompactionLoopBreaker({ client: makeClient([]), directory: dir })
    breaker.onSessionCompacted("ses_d", undefined)
    expect(breaker.onPostCompactionUsage("ses_d", { input: 1, cache: { read: 1 } })).toBe(false)
    expect(breaker.isBroken("ses_d")).toBe(false)
  })

  test("clear() forgets a broken session (session.deleted)", () => {
    const breaker = createCompactionLoopBreaker({ client: makeClient([]), directory: dir })
    breaker.onSessionCompacted("ses_e", { input: 0, cache: { read: 780_000 } })
    breaker.onPostCompactionUsage("ses_e", { input: 0, cache: { read: 785_000 } })
    breaker.onSessionCompacted("ses_e", { input: 0, cache: { read: 785_000 } })
    breaker.onPostCompactionUsage("ses_e", { input: 0, cache: { read: 786_000 } })
    expect(breaker.isBroken("ses_e")).toBe(true)
    breaker.clear("ses_e")
    expect(breaker.isBroken("ses_e")).toBe(false)
  })

  test("trigger early-out: a broken session never re-triggers", () => {
    const breaker = createCompactionLoopBreaker({ client: makeClient([]), directory: dir })
    breaker.onSessionCompacted("ses_f", { input: 0, cache: { read: 780_000 } })
    breaker.onPostCompactionUsage("ses_f", { input: 0, cache: { read: 785_000 } })
    breaker.onSessionCompacted("ses_f", { input: 0, cache: { read: 785_000 } })
    breaker.onPostCompactionUsage("ses_f", { input: 0, cache: { read: 786_000 } })
    // the trigger consults the same predicate the breaker exposes
    expect(breaker.isBroken("ses_f")).toBe(true)
  })
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})
