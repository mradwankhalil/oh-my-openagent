import { fetchAllTimeDownloads } from "../npm-downloads"
import { createOgCountSource } from "./live-count"

const downloads = createOgCountSource({
  key: "npm-downloads",
  label: "npm downloads",
  freshMs: 3_600_000,
  maxStaleMs: 86_400_000,
  load: () =>
    fetchAllTimeDownloads(new Date(Date.now()), {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    }),
})

export const getOgDownloads = downloads.get
export const resetOgDownloadsCacheForTests = downloads.reset

/** Floors to the shown precision so the `+` is always true; `null` withholds the figure. */
export function formatOgDownloads(count: number | null): string | null {
  if (count === null) return null
  if (count >= 1_000_000) {
    const millions = (Math.floor(count / 100_000) / 10).toFixed(1).replace(/\.0$/, "")
    return `${millions}M+ Downloads`
  }
  if (count >= 1_000) return `${Math.floor(count / 1_000)}K+ Downloads`
  return `${count} Downloads`
}
