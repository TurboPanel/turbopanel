/**
 * Outbound TCP reachability port, used by the firewall's outside check.
 *
 * Each composition root registers one implementation: the Deno server (a
 * self-hosted control plane) dials with `Deno.connect`; a Worker (the hosted
 * control plane) dials with `cloudflare:sockets`. Shared modules import this
 * port instead of either platform. Nothing registers one in tests unless a
 * test does, so the check is unavailable by default.
 */

import type { ProbeState } from '../../features/firewall/probe-decision.ts'

export type TcpProbeTarget = { address: string; port: number }

export type TcpProbeResult = {
  state: ProbeState
  /** Milliseconds to the completed handshake; null unless `open`. */
  ms: number | null
}

export type TcpProbe = {
  /**
   * Whether this control plane can reach private networks (RFC 1918, CGNAT,
   * IPv6 ULA). True for a self-hosted Deno server that may sit on the same LAN
   * as its servers; false for a Worker, which cannot dial them at all.
   */
  canReachPrivate: boolean
  /** One bounded handshake attempt. Never throws; connection data is never read. */
  connect: (target: TcpProbeTarget, timeoutMs: number) => Promise<TcpProbeResult>
}

let registered: TcpProbe | null = null

export function setTcpProbe(next: TcpProbe | null): void {
  registered = next
}

export function getTcpProbe(): TcpProbe | null {
  return registered
}
