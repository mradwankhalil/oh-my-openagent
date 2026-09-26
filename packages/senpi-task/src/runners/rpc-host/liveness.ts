import { log } from "@oh-my-opencode/utils"

import { probeWithEngine, createSenpiRpcClient, type HostRpcClient } from "./session-transport"

/**
 * The two questions the lifecycle asks a daemon once per pass: "are you there?" (`get_protocol_info`
 * through the engine's own `probeHost`) and "which session paths do you still hold?"
 * (`list_sessions { include_workers: true }` - worker rows are hidden by default, and every task
 * child is a worker). Both answer conservatively on failure: an unreachable daemon holds nothing,
 * which makes the lifecycle reopen from JSONL rather than attach, and close nothing.
 */

export async function daemonReachable(socket: string): Promise<boolean> {
  try {
    return (await probeWithEngine(socket)) !== undefined
  } catch (error) {
    log("senpi-task daemon probe failed", { socket, error: String(error) })
    return false
  }
}

export async function liveSessionPaths(socket: string): Promise<readonly string[]> {
  let client: HostRpcClient | undefined
  try {
    client = await createSenpiRpcClient({ socketPath: socket, onDisconnect: () => undefined })
    const listSessions = client.listSessions
    if (listSessions === undefined) return []
    await client.start()
    const rows = await listSessions.call(client, { include_workers: true })
    return rows.flatMap((row) => (row.sessionPath === undefined ? [] : [row.sessionPath]))
  } catch (error) {
    log("senpi-task daemon session list failed", { socket, error: String(error) })
    return []
  } finally {
    await client?.stop().catch(() => undefined)
  }
}
