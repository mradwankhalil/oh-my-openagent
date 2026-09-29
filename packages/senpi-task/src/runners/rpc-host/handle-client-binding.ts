import type { ChildEventListener } from "../types"
import type { HostSessionPort } from "./handle-port"
import type { HostSessionClosed, HostSessionParked } from "./session-client"

export interface HandleClientBindingHost {
  currentPort(): HostSessionPort
  acceptsLifecycleEvent(): boolean
  onEvent(event: Parameters<ChildEventListener>[0]): void
  onParked(event: HostSessionParked): void
  onClosed(event: HostSessionClosed): void
  onTransportGone(port: HostSessionPort): void
}

/** Bind one transport generation while suppressing every event from a replaced port. */
export function bindHostSessionPort(port: HostSessionPort, host: HandleClientBindingHost): void {
  port.onEvent((event) => {
    if (host.currentPort() !== port) return
    host.onEvent(event)
  })
  port.onParked((event) => {
    if (host.currentPort() !== port || !host.acceptsLifecycleEvent()) return
    host.onParked(event)
  })
  port.onClosed((event) => {
    if (host.currentPort() === port) host.onClosed(event)
  })
  void port.transportGone.then(() => host.onTransportGone(port))
}
