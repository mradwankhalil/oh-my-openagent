import type { HostSessionIdentity, HostSessionPort } from "./handle-port"
import { recoverLostTransport, type HostShardEvents } from "./handle-reattach"
import { isTransportLossError, type HostSessionReattach, type HostSessionReattached } from "./reattach"
import type { HostParkReason, HostSessionCommand } from "./session-client"

export interface HandleRecoveryHost {
  readonly taskId: string
  readonly reattach: HostSessionReattach | undefined
  readonly events: HostShardEvents | undefined
  port(): HostSessionPort
  identity(): HostSessionIdentity
  alive(): boolean
  turnSettled(): boolean
  adopt(next: HostSessionReattached): void
  turnResumed(): void
  endLost(): void
  park(reason: HostParkReason): void
  /** The continuation that re-drives the in-flight turn after a reattach was not delivered. */
  continuationFailed(error: unknown): void
}

export interface HandleRecovery {
  issue(command: HostSessionCommand): Promise<void>
  onTransportGone(lost: HostSessionPort): void
  settled(): Promise<void>
  currentPort(): Promise<HostSessionPort>
}

/**
 * The handle's transport recovery. A command never fails on a transport the child can recover from:
 * while a reattach is in flight it waits for the new port, and one that met the loss first lets
 * recovery start and is retried once on the port recovery produced. A command still being delivered
 * when the loss hits is NOT a turn the host lost - its retry is the delivery - so recovery's in-flight
 * verdict ignores turns while a delivery is pending, whichever reaction runs first.
 */
export function createHandleRecovery(host: HandleRecoveryHost): HandleRecovery {
  let reattaching: Promise<void> | undefined
  let deliveries = 0

  const issue = async (command: HostSessionCommand): Promise<void> => {
    await reattaching
    const live = host.port()
    deliveries += 1
    try {
      await live.send(command)
    } catch (error) {
      if (!isTransportLossError(error) || host.reattach === undefined || !host.alive()) throw error
      await live.transportGone
      await reattaching
      if (!host.alive()) throw error
      await host.port().send(command)
    } finally {
      deliveries -= 1
    }
  }

  // A lost transport is recoverable while this child still owns a running session and the runner
  // gave it a way back (omo#8563).
  const onTransportGone = (lost: HostSessionPort): void => {
    if (host.port() !== lost) return
    const reattach = host.reattach
    if (reattach === undefined) return host.endLost()
    if (!host.alive()) {
      // A child that already left still settles its place in a crash episode it was counted into.
      host.events?.onReattachOutcome?.({ taskId: host.taskId, socket: lost.socketPath, outcome: "cancelled" })
      return host.endLost()
    }
    reattaching = recoverLostTransport(
      {
        taskId: host.taskId,
        onTransportLost: (info) => host.events?.onTransportLost?.(info),
        onReattachOutcome: (info) => host.events?.onReattachOutcome?.(info),
        session: () => ({ socket: host.port().socketPath, ...host.identity() }),
        alive: host.alive,
        turnInFlight: () => !host.turnSettled() && deliveries === 0,
        adopt: host.adopt,
        turnResumed: host.turnResumed,
        continueTurn: (prompt) => host.port().send({ type: "prompt", message: prompt, streamingBehavior: "steer" }),
        // A refused reattach parks (the endpoint answered, but may not host this session); exhaustion ends.
        giveUp: (reason) => (reason === undefined ? host.endLost() : host.park(reason)),
      },
      reattach,
    )
      .catch((error: unknown) => host.continuationFailed(error))
      .finally(() => {
        reattaching = undefined
      })
  }

  return {
    issue,
    onTransportGone,
    settled: async () => await reattaching,
    currentPort: async () => {
      await reattaching
      return host.port()
    },
  }
}
