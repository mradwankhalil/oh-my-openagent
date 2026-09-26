import { describe, expect, test } from "bun:test"
import type { CustomEntry } from "@code-yeongyu/senpi"

import { Theme } from "../../../senpi-test-runtime"
import { renderKibitzerGateEntry, renderKibitzerNudgedEntry, renderKibitzerUnavailableEntry, type KibitzerGateRecord, type KibitzerUnavailableRecord } from "./notice"

const TEST_FG_COLORS = {
  accent: "#000000", bashMode: "#000000", border: "#000000", borderAccent: "#000000", borderMuted: "#000000",
  customMessageLabel: "#000000", customMessageText: "#000000", dim: "#000000", error: "#000000", mdCode: "#000000",
  mdCodeBlock: "#000000", mdCodeBlockBorder: "#000000", mdHeading: "#000000", mdHr: "#000000", mdLink: "#000000",
  mdLinkUrl: "#000000", mdListBullet: "#000000", mdQuote: "#000000", mdQuoteBorder: "#000000", muted: "#000000",
  success: "#000000", syntaxComment: "#000000", syntaxFunction: "#000000", syntaxKeyword: "#000000", syntaxNumber: "#000000",
  syntaxOperator: "#000000", syntaxPunctuation: "#000000", syntaxString: "#000000", syntaxType: "#000000", syntaxVariable: "#000000",
  text: "#000000", thinkingHigh: "#000000", thinkingLow: "#000000", thinkingMax: "#000000", thinkingMedium: "#000000",
  thinkingMinimal: "#000000", thinkingOff: "#000000", thinkingText: "#000000", thinkingXhigh: "#000000", toolDiffAdded: "#000000",
  toolDiffContext: "#000000", toolDiffRemoved: "#000000", toolOutput: "#000000", toolTitle: "#000000", userMessageText: "#000000",
  warning: "#000000",
} as const satisfies ConstructorParameters<typeof Theme>[0]
const TEST_BG_COLORS = {
  customMessageBg: "#000000", selectedBg: "#000000", toolErrorBg: "#000000", toolPendingBg: "#000000", toolSuccessBg: "#000000", userMessageBg: "#000000",
} as const satisfies ConstructorParameters<typeof Theme>[1]
const theme = new Theme(TEST_FG_COLORS, TEST_BG_COLORS, "truecolor")
function entry<T>(data: T): CustomEntry<T> {
  return { type: "custom", id: "entry-1", parentId: null, timestamp: new Date(0).toISOString(), customType: "test", data }
}

describe("kibitzer gate notice", () => {
  test("#given a dropped deadline gate record #when rendered #then nothing is drawn", () => {
    const record: KibitzerGateRecord = { version: 1, status: "dropped", cause: "deadline", candidateCount: 2 }
    expect(renderKibitzerGateEntry(entry(record), { expanded: false }, theme)).toBeUndefined()
  })

  test("#given a skipped gate record #when rendered #then the why line names recalled memory candidates", () => {
    const record: KibitzerGateRecord = { version: 1, status: "skipped", cause: "quick_category_unavailable", candidateCount: 2, consecutiveFailures: 3 }
    const component = renderKibitzerGateEntry(entry(record), { expanded: false }, theme)
    expect(component?.render(120).join("\n")).toContain("Kibitzer could not judge the recalled memory candidates for the previous turn.")
  })

  test("#given a failed gate record #when rendered #then the why line names recalled memory candidates", () => {
    const record: KibitzerGateRecord = { version: 1, status: "failed", cause: "child_failed", candidateCount: 2, consecutiveFailures: 3 }
    const component = renderKibitzerGateEntry(entry(record), { expanded: false }, theme)
    expect(component?.render(120).join("\n")).toContain("Kibitzer failed while judging the recalled memory candidates for the previous turn.")
  })

  test("#given a persistent failed gate record #when rendered #then the notice gives an actionable settings hint", () => {
    const record: KibitzerGateRecord = {
      version: 1,
      status: "failed",
      cause: "child_failed",
      candidateCount: 2,
      consecutiveFailures: 3,
    }
    const component = renderKibitzerGateEntry(entry(record), { expanded: false }, theme)
    expect(component?.render(120).join("\n")).toContain("check Kibitzer model/provider settings")
  })

  test("#given a resident sidecar gate record (wake number, no runId) #when rendered #then it draws the actionable notice without a run line", () => {
    const record: KibitzerGateRecord = {
      version: 1,
      status: "failed",
      cause: "child_failed_upstream",
      model: "omo-mock/mock-1",
      candidateCount: 2,
      reason: "503 overloaded",
      consecutiveFailures: 3,
      wake: 7,
    }
    const rendered = renderKibitzerGateEntry(entry(record), { expanded: false }, theme)?.render(120).join("\n")
    expect(rendered).toContain("Kibitzer gate failed")
    expect(rendered).toContain("503 overloaded")
    expect(rendered).toContain("after 3 consecutive failures; check Kibitzer model/provider settings")
    expect(rendered).not.toContain("run ")
  })

  test("#given a stored one-shot gate record carrying a runId #when rendered by the resident renderer #then the run line still shows", () => {
    const legacy = { version: 1, status: "failed", cause: "child_failed", candidateCount: 1, reason: "broken", runId: "run-3", consecutiveFailures: 3 }
    const rendered = renderKibitzerGateEntry(entry(legacy as KibitzerGateRecord), { expanded: false }, theme)?.render(120).join("\n")
    expect(rendered).toContain("run run-3")
    expect(rendered).toContain("after 3 consecutive failures")
  })

  test("#given a failed record below the notice threshold (an isolated failure) #when rendered #then nothing is drawn", () => {
    const record: KibitzerGateRecord = { version: 1, status: "failed", cause: "child_failed", candidateCount: 2, wake: 1 }
    expect(renderKibitzerGateEntry(entry(record), { expanded: false }, theme)).toBeUndefined()
  })
})

describe("kibitzer nudged recollection", () => {
  test("#given a nudged record #when rendered #then the title is the single Kibitzer", () => {
    const component = renderKibitzerNudgedEntry(entry({ version: 1, nudges: [{ path: "a.md", hint: "Use it." }], via: "steer" }), { expanded: false }, theme)
    const rendered = component?.render(120).join("\n")
    expect(rendered).toContain("✦ Kibitzer !")
    expect(rendered).toContain("recalled memory: Use it.")
    expect(rendered).toContain("a.md")
  })

  test("#given a nudged record from an opener-era producer #when rendered #then the stored opener is ignored for the unified title", () => {
    const component = renderKibitzerNudgedEntry(
      entry({ version: 1, nudges: [{ path: "a.md", hint: "Use it." }], via: "steer", opener: "Come to think of it —" }),
      { expanded: false },
      theme,
    )
    const rendered = component?.render(120).join("\n")
    expect(rendered).toContain("✦ Kibitzer !")
    expect(rendered).not.toContain("Come to think of it")
    expect(rendered).toContain("recalled memory: Use it.")
  })

  test("#given an invalid stored opener #when rendered #then the notice still draws the unified title", () => {
    for (const opener of ["x".repeat(41), "Oh,\u001b[31m right —", "two\nlines —", 7, ""]) {
      const component = renderKibitzerNudgedEntry(entry({ version: 1, nudges: [{ path: "a.md", hint: "Use it." }], opener }), { expanded: false }, theme)
      const rendered = component?.render(120).join("\n")
      expect(rendered).toContain("✦ Kibitzer !")
      expect(rendered).toContain("recalled memory: Use it.")
    }
  })

  test("#given a second nudge #when rendered #then the extra hint continues the recollection", () => {
    const component = renderKibitzerNudgedEntry(
      entry({ version: 1, nudges: [{ path: "a.md", hint: "Use it." }, { path: "b.md", hint: "Also this." }], via: "wake" }),
      { expanded: false },
      theme,
    )
    const rendered = component?.render(120).join("\n")
    expect(rendered).toContain("recalled memory: Use it.")
    expect(rendered).toContain("recalled memory: Also this.")
  })

  test("#given any provenance #when rendered #then no provenance line is shown", () => {
    for (const via of ["steer", "wake", "prompt", "bogus"]) {
      const component = renderKibitzerNudgedEntry(entry({ version: 1, nudges: [{ path: "a.md", hint: "Use it." }], via }), { expanded: false }, theme)
      expect(component?.render(120).join("\n")).not.toContain("via ")
    }
  })

  test("#given an expanded nudged record #when rendered #then the stored-memory caveat is available", () => {
    const record = { version: 1, nudges: [{ path: "a.md", hint: "Use it." }] }
    expect(renderKibitzerNudgedEntry(entry(record), { expanded: false }, theme)?.render(120).join("\n")).not.toContain("not current state")
    expect(renderKibitzerNudgedEntry(entry(record), { expanded: true }, theme)?.render(120).join("\n")).toContain(
      "it is a hint, not current state",
    )
  })
})

describe("kibitzer unavailable notice", () => {
  test("#given a dead-chain record #when rendered #then a non-error notice names the category, the unconnected providers and both fixes", () => {
    const record: KibitzerUnavailableRecord = {
      version: 1,
      category: "quick",
      cause: "category_unavailable",
      missingProviders: ["chatgpt-subscription", "openai"],
    }
    const rendered = renderKibitzerUnavailableEntry(entry(record), { expanded: false }, theme)?.render(120).join("\n")
    expect(rendered).toContain("⚠")
    expect(rendered).toContain("quick")
    expect(rendered).toContain("chatgpt-subscription")
    expect(rendered).toContain("/login")
    expect(rendered).toContain("memory.recall.category")
    expect(rendered).toContain("categories.quick.model")
    // Not a failure escalation: no gate framing, no streak language.
    expect(rendered).not.toContain("gate failed")
    expect(rendered).not.toContain("consecutive failures")
  })

  test("#given a beyond-category record #when rendered #then the notice explains the pinning refusal and points at the config fix", () => {
    const record: KibitzerUnavailableRecord = { version: 1, category: "quick", cause: "beyond_category" }
    const rendered = renderKibitzerUnavailableEntry(entry(record), { expanded: false }, theme)?.render(120).join("\n")
    expect(rendered).toContain("⚠")
    expect(rendered).toContain("quick")
    expect(rendered).toContain("memory.recall.category")
  })

  test("#given a beyond-category record carrying the chain's providers #when rendered #then the /login fix names them", () => {
    const record: KibitzerUnavailableRecord = { version: 1, category: "quick", cause: "beyond_category", missingProviders: ["kimi-coding", "chatgpt-subscription"] }
    const rendered = renderKibitzerUnavailableEntry(entry(record), { expanded: false }, theme)?.render(120).join("\n")
    expect(rendered).toContain("kimi-coding")
    expect(rendered).toContain("/login")
  })

  test("#given a malformed stored record #when rendered #then nothing is drawn", () => {
    for (const data of [
      undefined,
      null,
      "quick",
      { version: 2, category: "quick", cause: "category_unavailable" },
      { version: 1, cause: "category_unavailable" },
      { version: 1, category: "", cause: "category_unavailable" },
      { version: 1, category: "quick", cause: "start_failed" },
      { version: 1, category: "quick", cause: "category_unavailable", missingProviders: "openai" },
    ]) {
      expect(renderKibitzerUnavailableEntry(entry(data), { expanded: false }, theme)).toBeUndefined()
    }
  })

  test("#given a stored record with overlong fields #when rendered #then the fields are bounded", () => {
    const record = { version: 1, category: "x".repeat(200), cause: "category_unavailable", missingProviders: ["p".repeat(200)] }
    const rendered = renderKibitzerUnavailableEntry(entry(record), { expanded: false }, theme)?.render(120).join("\n")
    expect(rendered).toBeDefined()
    expect(rendered).not.toContain("x".repeat(200))
    expect(rendered).not.toContain("p".repeat(200))
  })
})
