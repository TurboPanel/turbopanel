/**
 * Tier floor and placement evaluation. Pure ranking plus the shared
 * `server → license → assigned tier` join ingest already uses — no HTTP,
 * no priced-offering vocabulary. Callers refuse, nag, or render from the
 * returned ranks. The tier a server sits on is `server.assigned_tier_id`,
 * derived from what the organization bought (`assignment-records.ts`);
 * nothing here chooses it.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Db } from '../../db/connection.ts'
import { license, organization, server, tier } from '../../db/schema.ts'
import { listSeatsForOrganization } from '../billing/billing-records.ts'
import { parseServerHostResources, type ServerHostResources } from '../servers/server-metadata.ts'
import type { MetricsDeploymentKind } from '../../contracts/capability-plan.ts'
import { getLatestTopologyGenerations } from '../servers/server-topology-records.ts'
import type { TopologyOverrides, TopologySnapshot } from '../../contracts/topology-types.ts'
import {
  discoveredDeviceIds,
  monitoredNicIds,
  parseTopologySnapshot,
  topologyOverridesFromMetadata,
} from './topology-recommendation.ts'
import { computeAssignment } from './assignment.ts'
import { loadAssignableServers, tierQuantitiesFromState } from './assignment-records.ts'
import { resolveTierPickNotice } from './server-preferred-tier.ts'
import {
  resolveRecommendedTier,
  resolveRequiredTier,
  type TierBandLabel,
  totalPhysicalCores,
} from './tier-placement.ts'

/**
 * Byte-for-byte daemon `classifyConnectFailure` message, sent only by the
 * enroll gate now; the daemon retries it slowly rather than giving up.
 */
export const LICENSE_TIER_BELOW_REQUIRED_ERROR = 'License tier below required'

/**
 * Byte-for-byte daemon `classifyConnectFailure` message, sent only by the
 * enroll gate; the daemon retries it slowly rather than giving up.
 */
export const LICENSE_TIER_UNASSIGNED_ERROR = 'License tier not assigned'

export type ServerLicenseTierJoinRow = {
  serverId: string
  organizationId: string
  serverName: string | null
  organizationName: string | null
  serverOptions: unknown
  orgOptions: unknown
  serverMetadata: unknown
  machineClass: unknown
  licenseId: string | null
  /** The derived tier; null when unlicensed or uncovered. */
  assignedTierId: string | null
  tierRank: number | null
  tierLabel: string | null
  preferredTierId: string | null
  preferredTierLabel: string | null
}

export type TierFloorEvaluation = {
  requiredRank: number
  requiredLabel: TierBandLabel
  satisfied: boolean
}

export type TierUnwatchedIds = {
  nics: string[]
  drives: string[]
  gpus: string[]
}

export type TierUnwatchedCounts = {
  nics: number
  drives: number
  gpus: number
}

export type TierPlacementEvaluation = {
  requiredRank: number
  requiredLabel: TierBandLabel
  recommendedRank: number
  recommendedLabel: TierBandLabel
  licenseRank: number | null
  licenseLabel: string | null
  unwatched: TierUnwatchedIds
  satisfied: boolean
}

export type TierFreeCount = Readonly<{
  tierId: string
  label: string
  free: number
}>

export type TierPlacementDto<U extends TierUnwatchedIds | TierUnwatchedCounts = TierUnwatchedIds> =
  {
    licenseTier: string | null
    requiredTier: string
    recommendedTier: string
    unwatched: U
    pickedTier: string | null
    tierPickNotice: string | null
    tiersFree?: readonly TierFreeCount[]
  }

const assignedTier = tier
const preferredTier = alias(tier, 'preferred_tier')

const JOIN_COLUMNS = {
  serverId: server.id,
  organizationId: server.organizationId,
  serverName: server.name,
  organizationName: organization.name,
  serverOptions: server.options,
  orgOptions: organization.options,
  serverMetadata: server.metadata,
  machineClass: server.machineClass,
  licenseId: license.id,
  assignedTierId: server.assignedTierId,
  tierRank: assignedTier.rank,
  tierLabel: assignedTier.label,
  preferredTierId: server.preferredTierId,
  preferredTierLabel: preferredTier.label,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { parseTopologySnapshot }

function hasKnownHardware(resources: ServerHostResources | undefined): boolean {
  if (!resources) return false
  return totalPhysicalCores(resources) > 0 || (resources.memory?.totalBytes ?? 0) > 0
}

/**
 * Identical hosted join ingest uses: `server → organization`, active
 * `license` (`revoked_at IS NULL`), and the `tier` the server is assigned.
 * One query so ingest and enforcement cannot disagree on the entitlement.
 */
export async function loadServerLicenseTierJoin(
  db: Db,
  serverId: string
): Promise<ServerLicenseTierJoinRow | undefined> {
  const rows = await loadServerLicenseTierJoins(db, [serverId])
  return rows.get(serverId)
}

export async function loadServerLicenseTierJoins(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, ServerLicenseTierJoinRow>> {
  const byId = new Map<string, ServerLicenseTierJoinRow>()
  if (serverIds.length === 0) return byId

  const rows = await db
    .select(JOIN_COLUMNS)
    .from(server)
    .leftJoin(organization, eq(organization.id, server.organizationId))
    .leftJoin(license, and(eq(license.serverId, server.id), isNull(license.revokedAt)))
    .leftJoin(assignedTier, eq(assignedTier.id, server.assignedTierId))
    .leftJoin(preferredTier, eq(preferredTier.id, server.preferredTierId))
    .where(inArray(server.id, [...serverIds]))

  for (const row of rows) {
    // A server that belongs to no organization has no license to bind, no
    // tier to place against and no owners to notify: it has no placement.
    if (row.organizationId === null) continue
    byId.set(row.serverId, { ...row, organizationId: row.organizationId })
  }
  return byId
}

/**
 * Hosted enroll gate that must run before any durable latch/attach: would
 * the organization's purchased tiers still cover every licensed server
 * once this license binds one more? Hardware is unknown at enroll, so the
 * newcomer needs the entry rank; the incumbents are placed first
 * (`computeAssignment`), so the newcomer is the one refused when nothing
 * is free. Reads the license (and its already-bound server, on a
 * re-enroll) so a 400 refusal cannot consume `license.server_id` or
 * replace `server.daemon`.
 */
export async function evaluateHostedEnrollmentTier(
  db: Db,
  licenseId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [row] = await db
    .select({
      organizationId: license.organizationId,
      serverId: license.serverId,
    })
    .from(license)
    .where(and(eq(license.id, licenseId), isNull(license.revokedAt)))
    .limit(1)
  if (!row) return { ok: false, error: LICENSE_TIER_UNASSIGNED_ERROR }

  const state = await listSeatsForOrganization(db, row.organizationId)
  const servers = await loadAssignableServers(db, row.organizationId)
  const already = row.serverId
    ? servers.find((entry) => entry.serverId === row.serverId)
    : undefined
  const candidate = already ?? {
    serverId: `enrolling:${licenseId}`,
    requiredRank: null,
    // Newest: placed after every incumbent.
    boundAt: '9999-12-31T23:59:59.999Z',
  }
  const quantities = tierQuantitiesFromState(state)
  const assignment = computeAssignment(quantities, already ? servers : [...servers, candidate])
  const assigned = assignment.byServer.get(candidate.serverId) ?? null
  if (assigned === null) {
    return {
      ok: false,
      error: already ? LICENSE_TIER_BELOW_REQUIRED_ERROR : LICENSE_TIER_UNASSIGNED_ERROR,
    }
  }
  return { ok: true }
}

/**
 * Hard floor: required rank from CPU cores + RAM compared to `tier.rank`.
 * Unknown hardware (absent `resources`, or zero cores and zero bytes) never
 * blocks. Soft dimensions (NICs / drives / GPUs) are ignored.
 */
export function evaluateTierFloor(input: {
  resources: ServerHostResources | undefined
  tierRank: number
}): TierFloorEvaluation {
  const resources = input.resources ?? {}
  const required = resolveRequiredTier(resources)
  if (!hasKnownHardware(input.resources)) {
    return {
      requiredRank: required.rank,
      requiredLabel: required.label,
      satisfied: true,
    }
  }
  return {
    requiredRank: required.rank,
    requiredLabel: required.label,
    satisfied: input.tierRank >= required.rank,
  }
}

export function evaluateTierPlacement(input: {
  resources: ServerHostResources | undefined
  topologySnapshot: TopologySnapshot | undefined
  tierRank: number | null
  licenseLabel?: string | null
  topologyOverrides?: TopologyOverrides
}): TierPlacementEvaluation {
  const floor = evaluateTierFloor({
    resources: input.resources,
    tierRank: input.tierRank ?? 0,
  })
  const discovered = discoveredDeviceIds(input.topologySnapshot)
  // NICs recommend from what the operator monitors, not from every uplink
  // discovered — a six-port box watching one NIC needs no NIC-driven
  // upgrade. Drives and GPUs have no operator selection and use discovery.
  const monitoredNics = monitoredNicIds(input.topologySnapshot, input.topologyOverrides)
  const recommended = resolveRecommendedTier(
    input.resources ?? {},
    monitoredNics.length,
    discovered.drives.length,
    discovered.gpus.length
  )
  return {
    requiredRank: floor.requiredRank,
    requiredLabel: floor.requiredLabel,
    recommendedRank: recommended.rank,
    recommendedLabel: recommended.label,
    licenseRank: input.tierRank,
    licenseLabel: input.licenseLabel ?? null,
    // Ingest stores every device a server reports, whatever the plan, so only
    // the uplinks the operator is not monitoring are left out of a sample
    // (the daemon sends the monitored set). Drives and GPUs have no operator
    // selection: all of them are stored.
    unwatched: {
      nics: discovered.nics.filter((id) => !monitoredNics.includes(id)),
      drives: [],
      gpus: [],
    },
    satisfied: floor.satisfied,
  }
}

export function toTierPlacementDto(
  placement: TierPlacementEvaluation,
  unwatched: 'ids'
): TierPlacementDto<TierUnwatchedIds>
export function toTierPlacementDto(
  placement: TierPlacementEvaluation,
  unwatched: 'counts'
): TierPlacementDto<TierUnwatchedCounts>
export function toTierPlacementDto(
  placement: TierPlacementEvaluation,
  unwatched: 'ids' | 'counts'
): TierPlacementDto<TierUnwatchedIds | TierUnwatchedCounts> {
  const ids = placement.unwatched
  return {
    licenseTier: placement.licenseLabel,
    requiredTier: placement.requiredLabel,
    recommendedTier: placement.recommendedLabel,
    unwatched:
      unwatched === 'counts'
        ? {
            nics: ids.nics.length,
            drives: ids.drives.length,
            gpus: ids.gpus.length,
          }
        : ids,
    pickedTier: null,
    tierPickNotice: null,
  }
}

export function withTierPlacementExtras<U extends TierUnwatchedIds | TierUnwatchedCounts>(
  dto: TierPlacementDto<U>,
  extras: Readonly<{
    pickedTier: string | null
    tierPickNotice: string | null
    tiersFree?: readonly TierFreeCount[]
  }>
): TierPlacementDto<U> {
  return {
    ...dto,
    pickedTier: extras.pickedTier,
    tierPickNotice: extras.tierPickNotice,
    tiersFree: extras.tiersFree,
  }
}

function placementFromJoinRow(
  row: ServerLicenseTierJoinRow,
  snapshot: TopologySnapshot | undefined,
  deployment: MetricsDeploymentKind
): TierPlacementEvaluation {
  const metadata = isRecord(row.serverMetadata) ? row.serverMetadata : undefined
  const resources = parseServerHostResources(metadata?.resources)
  // Self-hosted has an assigned tier now — the licence grant places every
  // server on `SX` (`src/features/tiers/self-hosted-grant.ts`) — but placement is
  // a *priced* idea and self-hosted buys nothing. So the tier is dropped on
  // this path only: the grant stays what it is, an entitlement the assignment
  // reads.
  const selfHosted = deployment === 'self-hosted'
  return evaluateTierPlacement({
    resources,
    topologySnapshot: snapshot,
    tierRank: selfHosted ? null : row.tierRank,
    licenseLabel: selfHosted ? null : row.tierLabel,
    topologyOverrides: topologyOverridesFromMetadata(metadata),
  })
}

export async function loadTierPlacementsForServers(
  db: Db,
  serverIds: readonly string[],
  opts: {
    deployment: MetricsDeploymentKind
    unwatched: 'ids'
    pickUnfulfilled?: ReadonlyMap<string, string>
  }
): Promise<Map<string, TierPlacementDto<TierUnwatchedIds>>>
export async function loadTierPlacementsForServers(
  db: Db,
  serverIds: readonly string[],
  opts: {
    deployment: MetricsDeploymentKind
    unwatched: 'counts'
    pickUnfulfilled?: ReadonlyMap<string, string>
  }
): Promise<Map<string, TierPlacementDto<TierUnwatchedCounts>>>
export async function loadTierPlacementsForServers(
  db: Db,
  serverIds: readonly string[],
  opts: {
    deployment: MetricsDeploymentKind
    unwatched: 'ids' | 'counts'
    pickUnfulfilled?: ReadonlyMap<string, string>
  }
): Promise<Map<string, TierPlacementDto<TierUnwatchedIds | TierUnwatchedCounts>>> {
  const result = new Map<string, TierPlacementDto<TierUnwatchedIds | TierUnwatchedCounts>>()
  if (serverIds.length === 0) return result

  const [joins, topologyByServer] = await Promise.all([
    loadServerLicenseTierJoins(db, serverIds),
    getLatestTopologyGenerations(db, serverIds),
  ])

  for (const serverId of serverIds) {
    const row = joins.get(serverId)
    if (!row) continue
    const snapshot = parseTopologySnapshot(topologyByServer.get(serverId)?.snapshot)
    const placement = placementFromJoinRow(row, snapshot, opts.deployment)
    const base =
      opts.unwatched === 'ids'
        ? toTierPlacementDto(placement, 'ids')
        : toTierPlacementDto(placement, 'counts')
    result.set(serverId, {
      ...base,
      pickedTier: row.preferredTierLabel ?? null,
      tierPickNotice: opts.pickUnfulfilled
        ? resolveTierPickNotice(serverId, opts.pickUnfulfilled)
        : null,
    })
  }
  return result
}

export { placementFromJoinRow }
