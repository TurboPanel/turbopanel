/**
 * Store a daemon's `fabric-peers-report`: every `tp0` peer as its 60 s
 * refresh read it (feature `fabric-peer-report-v1`). The daemon sends one
 * when a peer's health class changes and at most every 5 minutes otherwise;
 * this stamps it into `relay.metadata.observed` of the reporting server's
 * relays, at most once per {@link FABRIC_PEER_REPORT_MIN_INTERVAL_MS} per
 * server, so the tunnel health the address ladder reads never goes stale
 * between reconciles.
 *
 * Only the reporter's own relays are written (the server id comes from the
 * authenticated socket). Only known peer fields are kept, and a reading time
 * ahead of ours is clamped to the receive time. `appliedPayloadHash` is never
 * touched.
 */

import type { Db } from '../../db/connection.ts'
import type { FabricReconcileObservedPeer } from '../../contracts/commands/schemas.ts'
import { type RelayObservedPeer, stampRelayObservedPeers } from './fabric-records.ts'

/** Shortest gap between two stamps for one server. */
export const FABRIC_PEER_REPORT_MIN_INTERVAL_MS = 60_000

/** Upper bound on servers one in-memory throttle remembers (Deno process). */
const THROTTLE_MAX_SERVERS = 10_000

/**
 * In-memory "once per 60 s per server" gate, checked before any database
 * client opens so a throttled frame costs nothing. The Durable Object keeps
 * one per cell (one server); the Deno socket handler keeps one per process.
 */
export class FabricPeerReportThrottle {
  readonly #lastMs = new Map<string, number>()
  readonly #minIntervalMs: number

  constructor(minIntervalMs = FABRIC_PEER_REPORT_MIN_INTERVAL_MS) {
    this.#minIntervalMs = minIntervalMs
  }

  /** True (and remembered) when `serverId` may stamp now. */
  take(serverId: string, nowMs: number): boolean {
    const last = this.#lastMs.get(serverId)
    if (last !== undefined && nowMs - last < this.#minIntervalMs) return false
    this.#lastMs.delete(serverId)
    if (this.#lastMs.size >= THROTTLE_MAX_SERVERS) {
      const oldest = this.#lastMs.keys().next().value
      if (oldest !== undefined) this.#lastMs.delete(oldest)
    }
    this.#lastMs.set(serverId, nowMs)
    return true
  }
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
