/**
 * Store a daemon's `fabric-peers-report`: every `tp0` peer as its 60 s
 * refresh read it (feature `fabric-peer-report-v1`). The daemon sends one
 * when a peer's health class changes and at most every 5 minutes otherwise;
 * this stamps it into `relay.metadata.observed` of the reporting server's
 * relays, at most once per {@link FABRIC_PEER_REPORT_MIN_INTERVAL_MS} per
 * server while every peer keeps its health class, so the tunnel health the
 * address ladder reads never goes stale between reconciles. A report that
 * changes any peer's class is never throttled.
 *
 * Only the reporter's own relays are written (the server id comes from the
 * authenticated socket). Only known peer fields are kept, and a reading time
 * ahead of ours is clamped to the receive time. `appliedPayloadHash` is never
 * touched.
 */

import type { Db } from '../../db/connection.ts'
import type { FabricReconcileObservedPeer } from '../../contracts/commands/schemas.ts'
import { type RelayObservedPeer, stampRelayObservedPeers } from './fabric-records.ts'
import { fabricPeerHealthClasses } from './peer-health.ts'

/** Shortest gap between two stamps for one server. */
export const FABRIC_PEER_REPORT_MIN_INTERVAL_MS = 60_000

/** Upper bound on servers one in-memory throttle remembers (Deno process). */
const THROTTLE_MAX_SERVERS = 10_000

/**
 * In-memory "once per 60 s per server, unless a peer's health class changed"
 * gate, checked before any database client opens so a throttled frame costs
 * nothing. It remembers the classes it last let through for each server. The
 * Durable Object keeps one per cell (one server); the Deno socket handler
 * keeps one per process.
 */
export class FabricPeerReportThrottle {
  readonly #last = new Map<string, { ms: number; classes: string }>()
  readonly #minIntervalMs: number

  constructor(minIntervalMs = FABRIC_PEER_REPORT_MIN_INTERVAL_MS) {
    this.#minIntervalMs = minIntervalMs
  }

  /**
   * True (and remembered) when `serverId` may stamp now: the first report,
   * one whose `classes` differ from the last let through, or one at least
   * the minimum interval after it.
   */
  take(serverId: string, nowMs: number, classes = ''): boolean {
    const last = this.#last.get(serverId)
    if (last && last.classes === classes && nowMs - last.ms < this.#minIntervalMs) return false
    this.#last.delete(serverId)
    if (this.#last.size >= THROTTLE_MAX_SERVERS) {
      const oldest = this.#last.keys().next().value
      if (oldest !== undefined) this.#last.delete(oldest)
    }
    this.#last.set(serverId, { ms: nowMs, classes })
    return true
  }
}

/**
 * The in-memory gate both socket paths run on a `fabric-peers-report` before
 * opening a database client: true when the frame should be stamped.
 */
export function takeFabricPeersReport(
  throttle: FabricPeerReportThrottle,
  serverId: string,
  frame: { peers: readonly FabricReconcileObservedPeer[]; observedAt: string },
  nowMs: number
): boolean {
  const classes = fabricPeerHealthClasses({ at: frame.observedAt, peers: [...frame.peers] })
  return throttle.take(serverId, nowMs, classes)
}

const KNOWN_PEER_FIELDS = [
  'lastHandshakeAt',
  'transferRx',
  'transferTx',
  'endpoint',
  'health',
  'interface',
] as const

/** Copy only the fields this control plane knows (unknown extras are dropped). */
export function normalizeReportedPeer(peer: FabricReconcileObservedPeer): RelayObservedPeer {
  const out: Record<string, unknown> = { publicKey: peer.publicKey }
  for (const field of KNOWN_PEER_FIELDS) {
    if (peer[field] !== undefined) out[field] = peer[field]
  }
  return out as RelayObservedPeer
}

/** A daemon clock ahead of ours must not make a reading look newer than it is. */
export function clampObservedAt(observedAt: string, receivedAtMs: number): string {
  const observedMs = Date.parse(observedAt)
  if (!Number.isFinite(observedMs) || observedMs > receivedAtMs) {
    return new Date(receivedAtMs).toISOString()
  }
  return new Date(observedMs).toISOString()
}

export async function handleFabricPeersReport(
  db: Db,
  params: {
    reporterServerId: string
    peers: readonly FabricReconcileObservedPeer[]
    observedAt: string
    nowMs?: number
  }
): Promise<{ stamped: number }> {
  const nowMs = params.nowMs ?? Date.now()
  const stamped = await stampRelayObservedPeers(db, {
    serverId: params.reporterServerId,
    observed: {
      at: clampObservedAt(params.observedAt, nowMs),
      peers: params.peers.map(normalizeReportedPeer),
    },
    nowMs,
    minIntervalMs: FABRIC_PEER_REPORT_MIN_INTERVAL_MS,
  })
  return { stamped }
}
