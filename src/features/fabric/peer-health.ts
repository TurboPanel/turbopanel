/**
 * Is the tunnel between this relay and another peer up right now? Pure; read
 * from `relay.metadata.observed`, which the daemon refreshes every 60 s while
 * `tp0` exists (`fabric-peers-report`) and on every reconcile.
 */

import type { RelayMetadata } from './fabric-records.ts'

/**
 * A handshake this recent (relative to the reading) means the tunnel is up.
 * Daemon twin: `FABRIC_HANDSHAKE_HEALTHY_MS` in `turbopaneld`
 * `src/commands/fabric.ts` (a session dies after 180 s without a new
 * handshake; 15 s margin for the poll).
 */
export const FABRIC_HANDSHAKE_HEALTHY_MS = 195_000

/**
 * A reading older than this says nothing about now. The daemon re-sends at
 * least every 5 minutes while `tp0` exists; 2 minutes of margin on top.
 */
export const FABRIC_OBSERVATION_MAX_AGE_MS = 7 * 60_000

export type PairTunnelHealth = 'healthy' | 'down' | 'unknown'

/**
 * - `unknown`: no reading, a reading older than
 *   {@link FABRIC_OBSERVATION_MAX_AGE_MS} (or with an unreadable time), or no
 *   public key for the other peer yet.
 * - `healthy`: the other peer's last handshake is within
 *   {@link FABRIC_HANDSHAKE_HEALTHY_MS} of the reading time.
 * - `down`: anything else (peer missing from the reading, never handshaken,
 *   or an older handshake).
 */
export function pairTunnelHealth(
  observed: RelayMetadata['observed'] | undefined,
  otherPublicKey: string | null,
  nowMs: number
): PairTunnelHealth {
  if (!observed || !otherPublicKey) return 'unknown'
  const observedMs = Date.parse(observed.at)
  if (!Number.isFinite(observedMs) || nowMs - observedMs > FABRIC_OBSERVATION_MAX_AGE_MS) {
    return 'unknown'
  }
  const peer = observed.peers.find((entry) => entry.publicKey === otherPublicKey)
  const handshakeMs = peer?.lastHandshakeAt ? Date.parse(peer.lastHandshakeAt) : Number.NaN
  if (!Number.isFinite(handshakeMs)) return 'down'
  return observedMs - handshakeMs <= FABRIC_HANDSHAKE_HEALTHY_MS ? 'healthy' : 'down'
}

type ObservedPeer = NonNullable<RelayMetadata['observed']>['peers'][number]

/** The daemon's class for one peer, or the same rule applied to its handshake. */
function peerHealthClass(peer: ObservedPeer, observedMs: number): string {
  if (peer.health) return peer.health
  const handshakeMs = peer.lastHandshakeAt ? Date.parse(peer.lastHandshakeAt) : Number.NaN
  if (!Number.isFinite(handshakeMs)) return 'never'
  return observedMs - handshakeMs <= FABRIC_HANDSHAKE_HEALTHY_MS ? 'healthy' : 'stale'
}

/**
 * One string naming every peer and its health class, in key order. Two
 * readings with the same string tell the same story; a report whose string
 * differs from the stored one must never be throttled.
 */
export function fabricPeerHealthClasses(observed: RelayMetadata['observed'] | undefined): string {
  if (!observed) return ''
  const observedMs = Date.parse(observed.at)
  return observed.peers
    .map((peer) => `${peer.publicKey}=${peerHealthClass(peer, observedMs)}`)
    .sort((a, b) => a.localeCompare(b))
    .join(',')
}
