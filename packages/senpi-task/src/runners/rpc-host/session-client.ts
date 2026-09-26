import type { RpcSessionState, RpcTransportGoneError } from "@code-yeongyu/senpi"
import { log } from "@oh-my-opencode/utils"

import type { SenpiHostProtocolInfo } from "../../lazy/senpi-barrel"
import { buildAutoUiResponse, type AutoAnswerableUiRequest } from "../rpc/ui-auto-answer"
import type { ChildEventListener, RpcEntriesResult, RpcSwitchSessionResult } from "../types"
import {
  assertHostUsable,
  createSenpiRpcClient,
  probeWithEngine,
  toWireOpen,
  type HostProtocolProbe,
  type HostRpcClient,
  type HostRpcClientFactory,
  type HostSessionOpenInput,
} from "./session-transport"
import {
  HostSessionDetachedError,
  isAgentSessionEvent,
  isRoutedTo,
  parseControlRecord,
  toOpenFailure,
  type HostControlRecord,
} from "./session-wire"

export type { HostSessionOpenInput } from "./session-transport"
export { HostSessionDetachedError, HostSessionOpenError, isRoutedTo, SessionHeldElsewhereError } from "./session-wire"

export interface OpenedHostSession {
  /** Routing handle of this session on this connection - ephemeral, never a durable identity. */
  readonly sessionId: string
  /** The host answered `attached`: this open re-joined a session that was still live. */
  readonly attached: boolean
  readonly instanceId: string
  readonly engineVersion: string
}

/** The turn-delivery seam: the commands a child handle issues on its session. */
export type HostSessionCommand =
  | { readonly type: "prompt"; readonly message: string; readonly streamingBehavior?: "steer" | "followUp" }
  | { readonly type: "steer"; readonly message: string }
  | { readonly type: "followUp"; readonly message: string }
  | { readonly type: "abort" }

export interface HostSessionParked {
  readonly sessionId: string
  readonly sessionPath: string
}

export interface HostSessionClosed {
  readonly sessionId: string
  readonly reason: string | undefined
}

export interface HostSessionClientPorts {
  readonly createClient?: HostRpcClientFactory
  readonly probeProtocolInfo?: HostProtocolProbe
}

export interface HostSessionClientOptions {
  readonly socketPath: string
  readonly ports?: HostSessionClientPorts
}

/**
 * ONE senpi `RpcClient` per child, over the machine-wide daemon's public socket. The client probes
 * the daemon per child (never a cached answer), opens the child's session, filters every frame down
 * to that session's routing handle, auto-answers extension UI requests so a headless child never
 * blocks on a human, and surfaces park/close/transport-loss as typed signals. It never retries a
 * held session path and never signals a process - a daemon session has no pid of its own.
 *
 * The engine's `RpcClient` exposes no raw-command seam, so the protocol probe rides its own
 * short-lived connection to the same socket; `instanceId` is informational (records key liveness on
 * the session path, never on the instance).
 */
export class HostSessionClient {
  readonly socketPath: string
  readonly transportGone: Promise<RpcTransportGoneError>
  private readonly createClient: HostRpcClientFactory
  private readonly probeProtocolInfo: HostProtocolProbe
  private readonly transportLoss = Promise.withResolvers<RpcTransportGoneError>()
  private readonly eventListeners = new Set<ChildEventListener>()
  private readonly parkedListeners = new Set<(event: HostSessionParked) => void>()
  private readonly closedListeners = new Set<(event: HostSessionClosed) => void>()
  private client: HostRpcClient | undefined
  private routingId: string | undefined
  private identity: SenpiHostProtocolInfo | undefined
  private reattached = false

  constructor(options: HostSessionClientOptions) {
    this.socketPath = options.socketPath
    this.createClient = options.ports?.createClient ?? createSenpiRpcClient
    this.probeProtocolInfo = options.ports?.probeProtocolInfo ?? probeWithEngine
    this.transportGone = this.transportLoss.promise
  }

  /** The live routing handle, or undefined once the session was parked, closed or dropped. */
  get sessionId(): string | undefined {
    return this.routingId
  }

  /** Whether the last successful open re-joined a session that was still live on the host. */
  get attached(): boolean {
    return this.reattached
  }

  get instanceId(): string | undefined {
    return this.identity?.instanceId
  }

  get engineVersion(): string | undefined {
    return this.identity?.engineVersion
  }

  async open(input: HostSessionOpenInput): Promise<OpenedHostSession> {
    const identity = assertHostUsable(await this.probeProtocolInfo(this.socketPath))
    const client = await this.createClient({
      socketPath: this.socketPath,
      onDisconnect: (error) => this.handleTransportLoss(error),
    })
    client.onEvent((record) => this.ingest(record))
    await client.start()
    this.client = client
    const opened = await client.openSession(toWireOpen(input)).catch(async (error: unknown) => {
      this.client = undefined
      await client.stop()
      throw toOpenFailure(error, input.sessionPath)
    })
    this.identity = identity
    this.routingId = opened.sessionId
    this.reattached = opened.attached ?? false
    return {
      sessionId: opened.sessionId,
      attached: this.reattached,
      instanceId: identity.instanceId,
      engineVersion: identity.engineVersion,
    }
  }

  send(command: HostSessionCommand): Promise<void> {
    const client = this.connected(command.type)
    switch (command.type) {
      case "prompt":
        return client.prompt(
          command.message,
          command.streamingBehavior === undefined ? {} : { streamingBehavior: command.streamingBehavior },
        )
      case "steer":
        return client.steer(command.message)
      case "followUp":
        return client.followUp(command.message)
      case "abort":
        return client.abort()
      default:
        return unreachable(command)
    }
  }

  getState(): Promise<RpcSessionState> {
    return this.connected("get_state").getState()
  }

  getEntries(since?: string): Promise<RpcEntriesResult> {
    return this.connected("get_entries").getEntries(since)
  }

  switchSession(sessionPath: string): Promise<RpcSwitchSessionResult> {
    return this.connected("switch_session").switchSession(sessionPath)
  }

  onEvent(listener: ChildEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onParked(listener: (event: HostSessionParked) => void): () => void {
    this.parkedListeners.add(listener)
    return () => this.parkedListeners.delete(listener)
  }

  onClosed(listener: (event: HostSessionClosed) => void): () => void {
    this.closedListeners.add(listener)
    return () => this.closedListeners.delete(listener)
  }

  /** End the session on the host (`close_session`), then drop this child's connection. */
  async close(): Promise<void> {
    const client = this.client
    const routingId = this.routingId
    this.client = undefined
    this.routingId = undefined
    if (client === undefined) return
    if (routingId !== undefined) await client.closeSession(routingId)
    await client.stop()
  }

  /** Drop the connection and leave the session running on the daemon (retained, attachments 0). */
  async detach(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.routingId = undefined
    this.eventListeners.clear()
    await client?.stop()
  }

  private connected(operation: string): HostRpcClient {
    const client = this.client
    if (client === undefined) throw new HostSessionDetachedError(operation)
    return client
  }

  private ingest(record: unknown): void {
    if (!isRoutedTo(record, this.routingId)) return
    const control = parseControlRecord(record)
    if (control === undefined) {
      if (isAgentSessionEvent(record)) for (const listener of this.eventListeners) listener(record)
      return
    }
    this.handleControl(control)
  }

  private handleControl(control: HostControlRecord): void {
    switch (control.type) {
      case "extension_ui_request":
        return this.answerUi(control)
      case "session_parked": {
        const sessionId = this.routingId ?? control.sessionId
        this.routingId = undefined
        for (const listener of this.parkedListeners) listener({ sessionId, sessionPath: control.sessionPath })
        return
      }
      case "session_closed": {
        const sessionId = this.routingId ?? control.sessionId ?? ""
        this.routingId = undefined
        for (const listener of this.closedListeners) listener({ sessionId, reason: control.reason })
        return
      }
      default:
        return unreachable(control)
    }
  }

  // The child must never wait on a human: the deny/cancel answer is written and NOT awaited, so a
  // UI request cannot hold up the record stream or a command in flight.
  private answerUi(request: AutoAnswerableUiRequest): void {
    const answer = buildAutoUiResponse(request)
    if (answer === null) return
    void this.client?.sendExtensionUIResponse(answer).catch((error: unknown) => {
      log("senpi-task host session ui auto-answer failed", { socket: this.socketPath, error: String(error) })
    })
  }

  private handleTransportLoss(error: RpcTransportGoneError): void {
    this.routingId = undefined
    this.client = undefined
    this.transportLoss.resolve(error)
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled host session command: ${JSON.stringify(value)}`)
}
