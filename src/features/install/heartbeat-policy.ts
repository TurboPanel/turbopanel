/**
 * Idle-ping cadence the control plane advises daemons on attach. Pure and
 * Workers-safe: no I/O, no Deno APIs.
 *
 * An edge in front of the panel closes a WebSocket after a stretch with no
 * traffic, so a panel hostname behind an edge needs a shorter ping. High Availability keeps
 * the 60-second ping (and its Durable Object cost): no edge mode exists there.
 */

/** Idle-ping cadence on High Availability and when no panel hostname sits behind an edge. */
export const HEARTBEAT_SECONDS_DEFAULT = 60
/** Idle-ping cadence when a panel hostname sits behind an edge that closes idle sockets. */
export const HEARTBEAT_SECONDS_EDGE = 25

/** Hostname modes served through an edge. Kept equal to the ingress capability table's edge set by a test. */
export const EDGE_MODES: readonly string[] = [
  'cloudflare-tunnel',
  'cloudflare-proxy',
  'bunny-proxy',
  'passthrough',
]

export type HeartbeatRuntime = 'deno' | 'workers'

export function heartbeatSecondsFor(modes: readonly string[], runtime: HeartbeatRuntime): number {
  if (runtime === 'workers') return HEARTBEAT_SECONDS_DEFAULT
  return modes.some((mode) => EDGE_MODES.includes(mode))
    ? HEARTBEAT_SECONDS_EDGE
    : HEARTBEAT_SECONDS_DEFAULT
}
