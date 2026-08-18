/**
 * Ephemeral TurboFabric path selection with strike hysteresis.
 * Strike counters are process-local (see rendezvous cache) — never persisted
 * to Postgres.
 */

import type { FabricPeerHealth } from '../commands/schemas.ts'
import type { RelayPathKind } from '../db/fabric-records.ts'
import { resolveEffectiveAllowRelay } from './policy.ts'

/** Consecutive unhealthy rounds before leaving a direct path. */
export const FABRIC_PATH_DEMOTE_STRIKES = 3

/** Consecutive healthy rounds before returning to a direct path. */
export const FABRIC_PATH_PROMOTE_STRIKES = 2

export type FabricPathState = {
  peerServerId: string
  selected: RelayPathKind
  endpoint?: string
  viaServerId?: string
  lastHandshakeAt?: string
  latencyMs?: number
  degraded: boolean
  demoteStrikes: number
  promoteStrikes: number
}

export type FabricPathEvidence = {
  health: FabricPeerHealth
  kind?: RelayPathKind
  endpoint?: string
  viaServerId?: string
  lastHandshakeAt?: string
  latencyMs?: number
  gatewayAvailable?: boolean
  natEndpoint?: string
  /** True only when this peer's own probe handshook the NAT candidate. */
  natProbeSucceeded?: boolean
}

export type FabricPathPolicy = {
  orgAllowRelay: boolean
  relayAllowRelay: boolean | null
}

function isDirectKind(kind: RelayPathKind): boolean {
  return kind === 'direct_lan' || kind === 'direct_public' ||
    kind === 'direct_nat'
}

function withObservation(
  state: FabricPathState,
  evidence: FabricPathEvidence,
): FabricPathState {
  const next: FabricPathState = { ...state, degraded: state.degraded }
  if (evidence.endpoint) next.endpoint = evidence.endpoint
  else delete next.endpoint
  if (evidence.viaServerId) next.viaServerId = evidence.viaServerId
  else delete next.viaServerId
  if (evidence.lastHandshakeAt) next.lastHandshakeAt = evidence.lastHandshakeAt
  if (evidence.latencyMs !== undefined) next.latencyMs = evidence.latencyMs
  return next
}

function healthyDirectNatEvidence(evidence: FabricPathEvidence): boolean {
  if (evidence.natProbeSucceeded === true && evidence.natEndpoint) return true
  return evidence.health === 'healthy' && evidence.kind === 'direct_nat' &&
    Boolean(evidence.natEndpoint)
}

function isHealthyDirectKind(
  health: FabricPeerHealth,
  kind: RelayPathKind | undefined,
): kind is RelayPathKind {
  return health === 'healthy' && kind !== undefined && isDirectKind(kind)
}

function observeHealthyDirect(
  previous: FabricPathState,
  evidence: FabricPathEvidence,
  selected: RelayPathKind,
): FabricPathState {
  return withObservation({
    ...previous,
    selected,
    degraded: false,
    demoteStrikes: 0,
    promoteStrikes: 0,
  }, evidence)
}

function holdOrPromoteDirect(
  previous: FabricPathState,
  evidence: FabricPathEvidence,
  evidenceKind: RelayPathKind,
): FabricPathState {
  if (previous.selected === evidenceKind) {
    return observeHealthyDirect(previous, evidence, evidenceKind)
  }
  const promoteStrikes = previous.promoteStrikes + 1
  if (promoteStrikes >= FABRIC_PATH_PROMOTE_STRIKES) {
    return observeHealthyDirect(previous, evidence, evidenceKind)
  }
  if (isDirectKind(previous.selected)) {
    return withObservation({
      ...previous,
      degraded: true,
      promoteStrikes,
      demoteStrikes: 0,
    }, evidence)
  }
  return withObservation({
    ...previous,
    degraded: true,
    promoteStrikes,
  }, evidence)
}

function fallbackPath(
  previous: FabricPathState,
  evidence: FabricPathEvidence,
  policy: FabricPathPolicy,
): FabricPathState {
  if (healthyDirectNatEvidence(evidence) && evidence.natEndpoint) {
    return withObservation({
      ...previous,
      selected: 'direct_nat',
      endpoint: evidence.natEndpoint,
      degraded: false,
      demoteStrikes: 0,
      promoteStrikes: 0,
    }, { ...evidence, endpoint: evidence.natEndpoint, kind: 'direct_nat' })
  }
  if (evidence.gatewayAvailable) {
    const next: FabricPathState = {
      ...previous,
      selected: 'gateway',
      degraded: false,
      demoteStrikes: 0,
      promoteStrikes: 0,
    }
    delete next.endpoint
    if (evidence.viaServerId) next.viaServerId = evidence.viaServerId
    else delete next.viaServerId
    return next
  }
  const allowRelay = resolveEffectiveAllowRelay(
    policy.orgAllowRelay,
    policy.relayAllowRelay,
  )
  if (allowRelay) {
    return {
      ...previous,
      selected: 'unreachable',
      degraded: false,
      demoteStrikes: 0,
      promoteStrikes: 0,
    }
  }
  return {
    ...previous,
    selected: 'unreachable',
    degraded: false,
    demoteStrikes: 0,
    promoteStrikes: 0,
  }
}

function demoteOrFallback(
  previous: FabricPathState,
  evidence: FabricPathEvidence,
  policy: FabricPathPolicy,
): FabricPathState {
  if (!isDirectKind(previous.selected) || evidence.health === 'healthy') {
    return fallbackPath(previous, evidence, policy)
  }
  const demoteStrikes = previous.demoteStrikes + 1
  if (demoteStrikes < FABRIC_PATH_DEMOTE_STRIKES) {
    return withObservation({
      ...previous,
      degraded: true,
      demoteStrikes,
      promoteStrikes: 0,
    }, evidence)
  }
  return fallbackPath({
    ...previous,
    demoteStrikes: 0,
    promoteStrikes: 0,
  }, evidence, policy)
}

/**
 * Pure path-state transition. Direct healthy stays; direct failed waits for
 * demote strikes then tries `direct_nat`, then a healthy gateway. Relay
 * transport is out of scope — `allowRelay` with no relay still yields
 * `unreachable`.
 */
export function nextFabricPathState(
  previous: FabricPathState,
  evidence: FabricPathEvidence,
  policy: FabricPathPolicy,
): FabricPathState {
  if (isHealthyDirectKind(evidence.health, evidence.kind)) {
    return holdOrPromoteDirect(previous, evidence, evidence.kind)
  }
  return demoteOrFallback(previous, evidence, policy)
}

export function initialFabricPathState(peerServerId: string): FabricPathState {
  return {
    peerServerId,
    selected: 'unreachable',
    degraded: false,
    demoteStrikes: 0,
    promoteStrikes: 0,
  }
}
