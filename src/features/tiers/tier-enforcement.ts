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
import {
  resolveRecommendedTier,
  resolveRequiredTier,
  type TierBandLabel,
  totalPhysicalCores,
} from './tier-placement.ts'

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
  /** The tier a manager assigned; null when none was assigned. */
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
  }
): Promise<Map<string, TierPlacementDto<TierUnwatchedIds>>>
export async function loadTierPlacementsForServers(
  db: Db,
  serverIds: readonly string[],
  opts: {
    deployment: MetricsDeploymentKind
    unwatched: 'counts'
  }
): Promise<Map<string, TierPlacementDto<TierUnwatchedCounts>>>
export async function loadTierPlacementsForServers(
  db: Db,
  serverIds: readonly string[],
  opts: {
    deployment: MetricsDeploymentKind
    unwatched: 'ids' | 'counts'
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
      tierPickNotice: addServerTierPickNotice(row),
    })
  }
  return result
}

/**
 * A pick with no tier held happens only when the tier a manager chose in Add
 * Server had no free seat left when the server enrolled
 * (`applyAddServerTierAtEnroll`): every other write sets both columns.
 */
export function addServerTierPickNotice(
  row: Pick<ServerLicenseTierJoinRow, 'assignedTierId' | 'preferredTierLabel'>
): string | null {
  if (row.assignedTierId || !row.preferredTierLabel) return null
  const label = row.preferredTierLabel
  return `${label} was chosen when this server was added, but no ${label} license was free when it connected. Free or buy one, then put this server on ${label}.`
}

export { placementFromJoinRow }
