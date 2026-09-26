import { log } from "@oh-my-opencode/utils"

import { markRecordLostForReconciliation, type TaskRecord } from "../state"
import { delay, nowIso, type LifecycleContext } from "./context"
import { destroyResidentTask } from "./destroy"
import type { ReconcileDeferredReason, ReconcileOutcome } from "./types"

/**
 * What a revival does when it CANNOT proceed. Three answers, and only three: terminate the previous
 * child-process child so the replacement never races it, hand the claim back so the record stays
 * revivable (deferred), or - when the record can never be revived again - mark it lost. The
 * daemon-hosted path only ever reaches the first two: a session has no pid, and a parked session
 * always has a transcript to reopen.
 */

export type SuspendedResidency = "persisted_only" | "rpc_detached"

export function deferred(taskId: string, reason: ReconcileDeferredReason): ReconcileOutcome {
  return { task_id: taskId, kind: "deferred", reason }
}

export async function terminateOldRpc(context: LifecycleContext, record: TaskRecord): Promise<boolean> {
  const pid = record.pid
  if (pid === undefined || !context.signaller.isAlive(pid)) return true
  context.signaller.signal(pid, "SIGTERM")
  context.store.appendEvent(record.task_id, { type: "reconcile_terminated", payload: { pid, signal: "SIGTERM" } })
  await delay(context.orphanKillDelayMs)
  if (context.signaller.isAlive(pid)) {
    context.signaller.signal(pid, "SIGKILL")
    context.store.appendEvent(record.task_id, { type: "reconcile_terminated", payload: { pid, signal: "SIGKILL" } })
  }
  return !context.signaller.isAlive(pid)
}

export function rollbackOrDeferred(
  context: LifecycleContext,
  taskId: string,
  residency: SuspendedResidency,
  successReason: ReconcileDeferredReason,
): ReconcileOutcome {
  return rollbackClaim(context, taskId, residency)
    ? deferred(taskId, successReason)
    : deferred(taskId, "rollback_failed")
}

function rollbackClaim(context: LifecycleContext, taskId: string, residency: SuspendedResidency): boolean {
  try {
    context.store.mutate(taskId, (fresh) => {
      if (fresh.host_pid !== context.hostPid || fresh.residency_state !== "resident") return fresh
      const { host_pid: _hostPid, ...withoutHost } = fresh
      if (residency === "rpc_detached") {
        return { ...withoutHost, residency_state: residency, updated_at: nowIso(context) }
      }
      const { pid: _pid, ...withoutPid } = withoutHost
      return { ...withoutPid, residency_state: residency, updated_at: nowIso(context) }
    })
    return true
  } catch (error) {
    log("senpi-task reconcile ownership rollback failed", {
      taskId,
      residency,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export async function markLost(context: LifecycleContext, record: TaskRecord, message: string): Promise<void> {
  let applied = false
  context.store.mutate(record.task_id, (fresh) => {
    if (fresh.host_pid !== context.hostPid || fresh.residency_state !== "resident") return fresh
    const result = markRecordLostForReconciliation(fresh, {
      timestamp: nowIso(context),
      error_message: message,
      updateReason: fresh.status === "lost",
    })
    if (!result.applied) return fresh
    applied = true
    return result.record
  })
  if (!applied) return
  context.store.appendEvent(record.task_id, { type: "reconcile_lost", payload: { reason: message } })
  await destroyResidentTask(context, record.task_id, "reconcile_lost")
}
