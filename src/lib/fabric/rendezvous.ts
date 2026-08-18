/**
 * Control-plane TurboFabric NAT rendezvous: collect kernel-observed endpoints,
 * classify easy/hard NAT, and probe both sides in the same window.
 */

import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  generateDeliveryId,
  generateRequestId,
  MAX_DAEMON_WS_FABRIC_PATH_CANDIDATES,
  MAX_DAEMON_WS_FABRIC_PATH_ENTRIES,
  type DaemonOutboundEnvelope,
  type FabricPathWireCandidate,
} from '../../daemon/cell/protocol.ts'
import { cellTrace } from '../../logger.ts'
import { loadServerStatusRecords } from '../../client/servers/update-status.ts'
import type { FabricPeerHealth } from '../commands/schemas.ts'
import {
  fabricPairCacheKey,
  type FabricPathSummaryEntry,
  type RelayPathKind,
  type RelayRecord,
  stampRelayPathSummary,
} from '../db/fabric-records.ts'
import {
  type FabricPathPolicy,
  type FabricPathState,
  initialFabricPathState,
  nextFabricPathState,
} from './path-state.ts'

const FABRIC_PATHS_TIMEOUT_MS = 20_000
const FABRIC_PATHS_PROBE_MS = 3_000
const FABRIC_PATHS_CONCURRENCY = 8
const DIRECT_HEALTHY_KINDS = new Set<RelayPathKind>([
  'direct_lan',
  'direct_public',
])

/** Process-local strike counters keyed by fabric id then pair. */
const pathStateCacheByFabric = new Map<string, Map<string, FabricPathState>>()

export type CollectFabricPathObservationsParams = {
  db: Db
  registry: DaemonCellRegistry
  relays: readonly RelayRecord[]
  fabricId: string
  candidatesByServerId?: Map<string, FabricPathWireCandidate[]>
  probeMs?: number
}

type CollectFabricPathObservationsFn = (
  params: CollectFabricPathObservationsParams,
) => Promise<Map<string, ObservedPeerPath[]>>

let collectFabricPathObservationsOverride:
  | CollectFabricPathObservationsFn
  | null = null

export function setCollectFabricPathObservationsForTests(
  fn: CollectFabricPathObservationsFn | null,
): void {
  collectFabricPathObservationsOverride = fn
}

export function resetFabricPathStateCacheForTests(): void {
  pathStateCacheByFabric.clear()
}

export type ObservedPeerPath = {
  publicKey: string
  endpoint?: string
  lastHandshakeAt?: string
  health: FabricPeerHealth
  latencyMs?: number
}

export type NatClass = 'easy' | 'hard' | 'unknown'

export type FabricPathRequestPayload = {
  fabricId: string
  probeMs: number
  candidates: FabricPathWireCandidate[]
}

export type FabricRendezvousRoundResult = {
  observations: Map<string, ObservedPeerPath[]>
  natClassByServerId: Map<string, NatClass>
  natEndpointByPair: Map<string, string>
  failedPathKindsByPair: Map<string, Set<RelayPathKind>>
  pathStates: Map<string, FabricPathState>
  summariesByServerId: Map<string, FabricPathSummaryEntry[]>
  natCandidates: number
  degradedPeers: number
}

function endpointPort(endpoint: string): string | undefined {
  const colon = endpoint.lastIndexOf(':')
  if (colon <= 0) return undefined
  return endpoint.slice(colon + 1)
}

function parseObservedPeerPath(row: unknown): ObservedPeerPath | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const record = row as Record<string, unknown>
  if (typeof record.publicKey !== 'string') return null
  if (
    record.health !== 'healthy' && record.health !== 'stale' &&
    record.health !== 'never'
  ) {
    return null
  }
  const path: ObservedPeerPath = {
    publicKey: record.publicKey,
    health: record.health,
  }
  if (typeof record.endpoint === 'string') path.endpoint = record.endpoint
  if (typeof record.lastHandshakeAt === 'string') {
    path.lastHandshakeAt = record.lastHandshakeAt
  }
  if (typeof record.latencyMs === 'number') path.latencyMs = record.latencyMs
  return path
}

function extractPaths(result: unknown): ObservedPeerPath[] | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return null
  }
  const paths = (result as Record<string, unknown>).paths
  if (!Array.isArray(paths)) return null
  const out: ObservedPeerPath[] = []
  for (const row of paths) {
    const path = parseObservedPeerPath(row)
    if (path) out.push(path)
  }
  return out
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item)
    }
  }))
  return results
}

/**
 * Correlated cell round-trip for fabric path observation / probing.
 */
export async function requestFabricPaths(
  registry: DaemonCellRegistry,
  serverId: string,
  payload: FabricPathRequestPayload,
  timeoutMs = FABRIC_PATHS_TIMEOUT_MS,
): Promise<
  | { ok: true; paths: ObservedPeerPath[] }
  | { ok: false; error: string; status: 'expired' | 'failed' | 'malformed' }
> {
  const requestId = generateRequestId()
  const candidates = payload.candidates
    .slice(0, MAX_DAEMON_WS_FABRIC_PATH_ENTRIES)
    .map((candidate) => ({
      publicKey: candidate.publicKey,
      endpoints: candidate.endpoints.slice(0, MAX_DAEMON_WS_FABRIC_PATH_CANDIDATES),
    }))
  const envelope: DaemonOutboundEnvelope = {
    kind: 'fabric-paths-request',
    deliveryId: generateDeliveryId(),
    requestId,
    fabricId: payload.fabricId,
    probeMs: payload.probeMs,
    candidates,
    at: new Date().toISOString(),
  }

  cellTrace('request-start', {
    requestId,
    serverId,
    kind: 'fabric-paths-request',
  })

  try {
    const record = await registry.getCell(serverId).createRequestAndWait(
      envelope,
      timeoutMs,
    )

    if (record.status === 'expired') {
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'fabric-paths-request',
        pendingStatus: record.status,
        resultStatus: 'timeout',
      })
      return { ok: false, error: 'timeout waiting for fabric paths', status: 'expired' }
    }

    if (record.status === 'failed') {
      const error = record.error ?? 'failed to collect fabric paths'
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'fabric-paths-request',
        pendingStatus: record.status,
        resultStatus: 'failed',
        error,
      })
      return { ok: false, error, status: 'failed' }
    }

    const paths = extractPaths(record.result)
    if (paths === null) {
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'fabric-paths-request',
        pendingStatus: record.status,
        resultStatus: 'malformed',
      })
      return { ok: false, error: 'invalid fabric paths result', status: 'malformed' }
    }

    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'fabric-paths-request',
      pendingStatus: record.status,
      resultStatus: 'done',
    })
    return { ok: true, paths }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'fabric-paths-request',
      resultStatus: 'error',
      error: message,
    })
    return { ok: false, error: message, status: 'failed' }
  }
}

export async function collectFabricPathObservations(params: {
  db: Db
  registry: DaemonCellRegistry
  relays: readonly RelayRecord[]
  fabricId: string
  candidatesByServerId?: Map<string, FabricPathWireCandidate[]>
  probeMs?: number
}): Promise<Map<string, ObservedPeerPath[]>> {
  if (collectFabricPathObservationsOverride) {
    return await collectFabricPathObservationsOverride(params)
  }
  const keyed = params.relays.filter((row) => row.publicKey)
  if (keyed.length === 0) return new Map()

  const records = await loadServerStatusRecords(
    params.db,
    params.registry,
    keyed.map((row) => row.serverId),
  )
  const online = new Set(
    records.filter((row) => row.connected).map((row) => row.serverId),
  )
  const liveRelays = keyed.filter((row) => online.has(row.serverId))
  const observations = new Map<string, ObservedPeerPath[]>()
  if (liveRelays.length === 0) return observations

  const probeMs = params.probeMs ?? 0
  await mapPool(liveRelays, FABRIC_PATHS_CONCURRENCY, async (relay) => {
    const result = await requestFabricPaths(params.registry, relay.serverId, {
      fabricId: params.fabricId,
      probeMs,
      candidates: params.candidatesByServerId?.get(relay.serverId) ?? [],
    })
    if (result.ok) observations.set(relay.serverId, result.paths)
  })
  return observations
}

/**
 * A target whose mapped UDP port is identical at ≥2 distinct observation
 * points is `easy`; a differing port is `hard`.
 */
export function classifyNatMapping(
  observationsByObserver: ReadonlyMap<string, readonly ObservedPeerPath[]>,
  targetPublicKey: string,
): NatClass {
  const ports: string[] = []
  const observers = new Set<string>()
  for (const [observerId, paths] of observationsByObserver) {
    const match = paths.find((row) =>
      row.publicKey === targetPublicKey && row.endpoint
    )
    if (!match?.endpoint) continue
    const port = endpointPort(match.endpoint)
    if (!port) continue
    observers.add(observerId)
    ports.push(port)
  }
  if (observers.size < 2) return 'unknown'
  const first = ports[0]
  if (first !== undefined && ports.every((port) => port === first)) return 'easy'
  return 'hard'
}

function observedEndpointForKey(
  observations: ReadonlyMap<string, readonly ObservedPeerPath[]>,
  publicKey: string,
  excludeObserverId?: string,
): string | undefined {
  const counts = new Map<string, number>()
  for (const [observerId, paths] of observations) {
    if (observerId === excludeObserverId) continue
    for (const path of paths) {
      if (path.publicKey !== publicKey || !path.endpoint) continue
      counts.set(path.endpoint, (counts.get(path.endpoint) ?? 0) + 1)
    }
  }
  let best: string | undefined
  let bestCount = 0
  for (const [endpoint, count] of counts) {
    if (count > bestCount) {
      best = endpoint
      bestCount = count
    }
  }
  return best
}

function pathStateForPair(
  pathStates: ReadonlyMap<string, FabricPathState>,
  fromServerId: string,
  toServerId: string,
): FabricPathState | undefined {
  return pathStates.get(fabricPairCacheKey(fromServerId, toServerId))
}

function pairAlreadyHealthyDirect(
  pathStates: ReadonlyMap<string, FabricPathState>,
  fromServerId: string,
  toServerId: string,
): boolean {
  const state = pathStateForPair(pathStates, fromServerId, toServerId)
  if (!state || state.degraded) return false
  return DIRECT_HEALTHY_KINDS.has(state.selected)
}

/**
 * For each pair with no healthy direct path, hand each side the endpoint
 * observers recorded for the other. Skip both-hard pairs and healthy
 * `direct_lan` / `direct_public`.
 */
type KeyedPeer = { serverId: string; publicKey: string }

function addNatCandidate(
  byServerId: Map<string, FabricPathWireCandidate[]>,
  serverId: string,
  candidate: FabricPathWireCandidate,
): void {
  const list = byServerId.get(serverId) ?? []
  const existing = list.find((row) => row.publicKey === candidate.publicKey)
  if (existing) {
    for (const endpoint of candidate.endpoints) {
      if (!existing.endpoints.includes(endpoint)) existing.endpoints.push(endpoint)
    }
    return
  }
  list.push(candidate)
  byServerId.set(serverId, list)
}

function shouldExchangeNatCandidates(
  left: KeyedPeer,
  right: KeyedPeer,
  natClass: ReadonlyMap<string, NatClass>,
  pathStates: ReadonlyMap<string, FabricPathState>,
): boolean {
  const leftClass = natClass.get(left.serverId) ?? 'unknown'
  const rightClass = natClass.get(right.serverId) ?? 'unknown'
  if (leftClass === 'hard' && rightClass === 'hard') return false
  return !(
    pairAlreadyHealthyDirect(pathStates, left.serverId, right.serverId) &&
    pairAlreadyHealthyDirect(pathStates, right.serverId, left.serverId)
  )
}

function exchangeNatCandidatesForPair(
  byServerId: Map<string, FabricPathWireCandidate[]>,
  observations: ReadonlyMap<string, readonly ObservedPeerPath[]>,
  left: KeyedPeer,
  right: KeyedPeer,
): void {
  const rightEndpoint = observedEndpointForKey(
    observations,
    right.publicKey,
    left.serverId,
  )
  const leftEndpoint = observedEndpointForKey(
    observations,
    left.publicKey,
    right.serverId,
  )
  if (rightEndpoint) {
    addNatCandidate(byServerId, left.serverId, {
      publicKey: right.publicKey,
      endpoints: [rightEndpoint],
    })
  }
  if (leftEndpoint) {
    addNatCandidate(byServerId, right.serverId, {
      publicKey: left.publicKey,
      endpoints: [leftEndpoint],
    })
  }
}

function keyedPeers(
  relays: readonly Pick<RelayRecord, 'serverId' | 'publicKey'>[],
): KeyedPeer[] {
  const out: KeyedPeer[] = []
  for (const row of relays) {
    if (!row.publicKey) continue
    out.push({ serverId: row.serverId, publicKey: row.publicKey })
  }
  return out
}

export function buildNatCandidateExchange(params: {
  relays: readonly Pick<RelayRecord, 'serverId' | 'publicKey'>[]
  observations: ReadonlyMap<string, readonly ObservedPeerPath[]>
  natClass: ReadonlyMap<string, NatClass>
  pathStates: ReadonlyMap<string, FabricPathState>
}): Map<string, FabricPathWireCandidate[]> {
  const keyed = keyedPeers(params.relays)
  const byServerId = new Map<string, FabricPathWireCandidate[]>()

  for (let i = 0; i < keyed.length; i += 1) {
    const left = keyed[i]
    if (!left) continue
    for (let j = i + 1; j < keyed.length; j += 1) {
      const right = keyed[j]
      if (!right) continue
      if (
        !shouldExchangeNatCandidates(
          left,
          right,
          params.natClass,
          params.pathStates,
        )
      ) {
        continue
      }
      exchangeNatCandidatesForPair(byServerId, params.observations, left, right)
    }
  }
  return byServerId
}

function observationForPeer(
  paths: readonly ObservedPeerPath[] | undefined,
  publicKey: string,
): ObservedPeerPath | undefined {
  return paths?.find((row) => row.publicKey === publicKey)
}

function probedNatEndpoint(
  seen: ObservedPeerPath | undefined,
  candidates: readonly FabricPathWireCandidate[] | undefined,
  otherPublicKey: string,
): string | undefined {
  if (seen?.health !== 'healthy' || !seen.endpoint) return undefined
  const match = candidates?.find((row) => row.publicKey === otherPublicKey)
  if (!match?.endpoints.includes(seen.endpoint)) return undefined
  return seen.endpoint
}

function isDirectPathKind(kind: RelayPathKind): boolean {
  return kind === 'direct_lan' || kind === 'direct_public' ||
    kind === 'direct_nat'
}

function summaryFromState(state: FabricPathState): FabricPathSummaryEntry {
  const entry: FabricPathSummaryEntry = {
    peerServerId: state.peerServerId,
    selected: state.selected,
    degraded: state.degraded,
  }
  if (state.endpoint) entry.endpoint = state.endpoint
  if (state.viaServerId) entry.viaServerId = state.viaServerId
  if (state.lastHandshakeAt) entry.lastHandshakeAt = state.lastHandshakeAt
  if (state.latencyMs !== undefined) entry.latencyMs = state.latencyMs
  return entry
}

function classifyRelayNatMappings(
  relays: readonly RelayRecord[],
  observations: ReadonlyMap<string, readonly ObservedPeerPath[]>,
): Map<string, NatClass> {
  const natClassByServerId = new Map<string, NatClass>()
  for (const row of relays) {
    if (!row.publicKey) continue
    natClassByServerId.set(
      row.serverId,
      classifyNatMapping(observations, row.publicKey),
    )
  }
  return natClassByServerId
}

function resolvePathKindHint(
  natProbeSucceeded: boolean,
  health: FabricPeerHealth,
  previousSelected: RelayPathKind,
): RelayPathKind | undefined {
  if (natProbeSucceeded) return 'direct_nat'
  if (health === 'healthy') return previousSelected
  return undefined
}

function hasAlternateGateway(
  relays: readonly RelayRecord[],
  selfServerId: string,
  peerServerId: string,
): boolean {
  return relays.some((row) =>
    row.role === 'gateway' && row.serverId !== selfServerId &&
    row.serverId !== peerServerId && Boolean(row.publicKey)
  )
}

type RendezvousPairContext = {
  keyed: readonly RelayRecord[]
  merged: ReadonlyMap<string, readonly ObservedPeerPath[]>
  candidatesByServerId: ReadonlyMap<string, FabricPathWireCandidate[]>
  orgAllowRelay: boolean
}

type PairPathOutcome = { next: FabricPathState; health: FabricPeerHealth }

type RendezvousAccumulator = {
  pathStates: Map<string, FabricPathState>
  natEndpointByPair: Map<string, string>
  failedPathKindsByPair: Map<string, Set<RelayPathKind>>
  summariesByServerId: Map<string, FabricPathSummaryEntry[]>
  natCandidates: number
  degradedPeers: number
}

function computePairPathState(
  ctx: RendezvousPairContext,
  policy: FabricPathPolicy,
  selfServerId: string,
  other: KeyedPeer,
  previous: FabricPathState,
): PairPathOutcome {
  const seen = observationForPeer(ctx.merged.get(selfServerId), other.publicKey)
  const health = seen?.health ?? 'never'
  const natEndpoint = probedNatEndpoint(
    seen,
    ctx.candidatesByServerId.get(selfServerId),
    other.publicKey,
  )
  const natProbeSucceeded = natEndpoint !== undefined
  const next = nextFabricPathState(previous, {
    health,
    kind: resolvePathKindHint(natProbeSucceeded, health, previous.selected),
    endpoint: natProbeSucceeded ? natEndpoint : seen?.endpoint,
    lastHandshakeAt: seen?.lastHandshakeAt,
    latencyMs: seen?.latencyMs,
    ...(natProbeSucceeded ? { natEndpoint, natProbeSucceeded: true } : {}),
    gatewayAvailable: hasAlternateGateway(
      ctx.keyed,
      selfServerId,
      other.serverId,
    ),
  }, policy)
  return { next, health }
}

/** A direct path counts as failed when it went unhealthy or was replaced. */
function directPathFailed(
  previous: FabricPathState,
  next: FabricPathState,
  health: FabricPeerHealth,
): boolean {
  if (!isDirectPathKind(previous.selected)) return false
  return health !== 'healthy' || previous.selected !== next.selected
}

function applyPairOutcome(
  acc: RendezvousAccumulator,
  entries: FabricPathSummaryEntry[],
  pairKey: string,
  previous: FabricPathState,
  outcome: PairPathOutcome,
): void {
  const { next, health } = outcome
  acc.pathStates.set(pairKey, next)
  entries.push(summaryFromState(next))
  if (next.degraded) acc.degradedPeers += 1
  if (next.selected === 'direct_nat' && next.endpoint) {
    acc.natEndpointByPair.set(pairKey, next.endpoint)
    acc.natCandidates += 1
  }
  if (directPathFailed(previous, next, health)) {
    recordFailedKind(acc.failedPathKindsByPair, pairKey, previous.selected)
  }
}

function summarizeRelayPaths(
  ctx: RendezvousPairContext,
  acc: RendezvousAccumulator,
  self: RelayRecord,
): void {
  const entries: FabricPathSummaryEntry[] = []
  const policy: FabricPathPolicy = {
    orgAllowRelay: ctx.orgAllowRelay,
    relayAllowRelay: self.allowRelay,
  }
  for (const other of ctx.keyed) {
    if (other.serverId === self.serverId || !other.publicKey) continue
    const pairKey = fabricPairCacheKey(self.serverId, other.serverId)
    const previous = acc.pathStates.get(pairKey) ??
      initialFabricPathState(other.serverId)
    const outcome = computePairPathState(
      ctx,
      policy,
      self.serverId,
      { serverId: other.serverId, publicKey: other.publicKey },
      previous,
    )
    applyPairOutcome(acc, entries, pairKey, previous, outcome)
  }
  acc.summariesByServerId.set(self.serverId, entries)
}

export async function runFabricRendezvousRound(params: {
  db: Db
  registry: DaemonCellRegistry
  fabricId: string
  relays: readonly RelayRecord[]
  pathStates?: Map<string, FabricPathState>
  orgAllowRelay: boolean
}): Promise<FabricRendezvousRoundResult | null> {
  const keyed = params.relays.filter((row) => row.publicKey)
  if (keyed.length < 2) return null

  const observations = await collectFabricPathObservations({
    db: params.db,
    registry: params.registry,
    relays: keyed,
    fabricId: params.fabricId,
  })
  if (observations.size === 0) return null

  const natClassByServerId = classifyRelayNatMappings(keyed, observations)

  const pathStates = params.pathStates ?? new Map<string, FabricPathState>()
  const candidatesByServerId = buildNatCandidateExchange({
    relays: keyed,
    observations,
    natClass: natClassByServerId,
    pathStates,
  })

  const probed = candidatesByServerId.size === 0
    ? observations
    : await collectFabricPathObservations({
      db: params.db,
      registry: params.registry,
      relays: keyed,
      fabricId: params.fabricId,
      candidatesByServerId,
      probeMs: FABRIC_PATHS_PROBE_MS,
    })

  const merged = new Map(observations)
  for (const [serverId, paths] of probed) merged.set(serverId, paths)

  const ctx: RendezvousPairContext = {
    keyed,
    merged,
    candidatesByServerId,
    orgAllowRelay: params.orgAllowRelay,
  }
  const acc: RendezvousAccumulator = {
    pathStates,
    natEndpointByPair: new Map(),
    failedPathKindsByPair: new Map(),
    summariesByServerId: new Map(),
    natCandidates: 0,
    degradedPeers: 0,
  }

  for (const self of keyed) {
    if (!self.publicKey) continue
    summarizeRelayPaths(ctx, acc, self)
  }

  for (const [serverId, entries] of acc.summariesByServerId) {
    await stampRelayPathSummary(params.db, {
      fabricId: params.fabricId,
      serverId,
      entries,
    })
  }

  rememberFabricPathStates(params.fabricId, pathStates)

  return {
    observations: merged,
    natClassByServerId,
    natEndpointByPair: acc.natEndpointByPair,
    failedPathKindsByPair: acc.failedPathKindsByPair,
    pathStates,
    summariesByServerId: acc.summariesByServerId,
    natCandidates: acc.natCandidates,
    degradedPeers: acc.degradedPeers,
  }
}

function recordFailedKind(
  failedPathKindsByPair: Map<string, Set<RelayPathKind>>,
  pairKey: string,
  kind: RelayPathKind,
): void {
  const failed = failedPathKindsByPair.get(pairKey) ?? new Set()
  failed.add(kind)
  failedPathKindsByPair.set(pairKey, failed)
}

export function fabricNeedsRendezvous(relays: readonly RelayRecord[]): boolean {
  const keyed = relays.filter((row) => row.publicKey)
  if (keyed.length < 2) return false
  for (const row of keyed) {
    const paths = row.metadata.paths
    if (!paths) return true
    for (const entry of paths.entries) {
      if (entry.selected === 'unreachable') return true
      if (!DIRECT_HEALTHY_KINDS.has(entry.selected)) return true
      if (entry.degraded) return true
    }
  }
  return false
}

export function pathStatesFromRelayMetadata(
  relays: readonly RelayRecord[],
): Map<string, FabricPathState> {
  const states = new Map<string, FabricPathState>()
  for (const row of relays) {
    const entries = row.metadata.paths?.entries ?? []
    for (const entry of entries) {
      const state: FabricPathState = {
        peerServerId: entry.peerServerId,
        selected: entry.selected,
        degraded: entry.degraded,
        demoteStrikes: 0,
        promoteStrikes: 0,
      }
      if (entry.endpoint) state.endpoint = entry.endpoint
      if (entry.viaServerId) state.viaServerId = entry.viaServerId
      if (entry.lastHandshakeAt) state.lastHandshakeAt = entry.lastHandshakeAt
      if (entry.latencyMs !== undefined) state.latencyMs = entry.latencyMs
      states.set(fabricPairCacheKey(row.serverId, entry.peerServerId), state)
    }
  }
  return states
}

function pairServersLive(
  pairKey: string,
  live: ReadonlySet<string>,
): boolean {
  const sep = pairKey.indexOf('>')
  if (sep <= 0) return false
  return live.has(pairKey.slice(0, sep)) && live.has(pairKey.slice(sep + 1))
}

function overlayMetadataOnCache(
  cached: FabricPathState,
  fromMeta: FabricPathState,
): FabricPathState {
  const next: FabricPathState = {
    ...cached,
    peerServerId: fromMeta.peerServerId,
    selected: fromMeta.selected,
    degraded: fromMeta.degraded,
    demoteStrikes: cached.demoteStrikes,
    promoteStrikes: cached.promoteStrikes,
  }
  if (fromMeta.endpoint) next.endpoint = fromMeta.endpoint
  else delete next.endpoint
  if (fromMeta.viaServerId) next.viaServerId = fromMeta.viaServerId
  else delete next.viaServerId
  if (fromMeta.lastHandshakeAt) next.lastHandshakeAt = fromMeta.lastHandshakeAt
  else delete next.lastHandshakeAt
  if (fromMeta.latencyMs !== undefined) next.latencyMs = fromMeta.latencyMs
  else delete next.latencyMs
  return next
}

export function rememberFabricPathStates(
  fabricId: string,
  pathStates: ReadonlyMap<string, FabricPathState>,
): void {
  pathStateCacheByFabric.set(fabricId, new Map(pathStates))
}

/**
 * Merge diagnostics `relay.metadata.paths` with in-process strike counters.
 * NAT candidates stay out of desired state; counters survive across rounds.
 */
function pruneCachedPathStates(
  fabricId: string,
  live: ReadonlySet<string>,
): Map<string, FabricPathState> | undefined {
  const cached = pathStateCacheByFabric.get(fabricId)
  if (!cached) return undefined
  const pruned = new Map<string, FabricPathState>()
  for (const [pairKey, state] of cached) {
    if (pairServersLive(pairKey, live)) pruned.set(pairKey, state)
  }
  pathStateCacheByFabric.set(fabricId, pruned)
  return pruned
}

function mergeHydratedPathState(
  meta: FabricPathState | undefined,
  cache: FabricPathState | undefined,
): FabricPathState | undefined {
  if (meta && cache) return overlayMetadataOnCache(cache, meta)
  if (meta) return meta
  if (cache) return { ...cache }
  return undefined
}

export function hydrateFabricPathStates(
  fabricId: string,
  relays: readonly RelayRecord[],
): Map<string, FabricPathState> {
  const fromMeta = pathStatesFromRelayMetadata(relays)
  const live = new Set(
    relays.filter((row) => row.publicKey).map((row) => row.serverId),
  )
  const liveCache = pruneCachedPathStates(fabricId, live)
  const pairKeys = new Set<string>([
    ...fromMeta.keys(),
    ...(liveCache?.keys() ?? []),
  ])
  const hydrated = new Map<string, FabricPathState>()
  for (const pairKey of pairKeys) {
    if (!pairServersLive(pairKey, live)) continue
    const state = mergeHydratedPathState(
      fromMeta.get(pairKey),
      liveCache?.get(pairKey),
    )
    if (state) hydrated.set(pairKey, state)
  }
  return hydrated
}
