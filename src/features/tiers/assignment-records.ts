/**
 * The managers' assignment, read and written: `server.assigned_tier_id`.
 *
 * `assignment.ts` reads the assignment against what was bought; this is the
 * I/O around it. The column is written in these places, and nowhere else:
 *
 *   - {@link assignServerTier}, behind the manager route
 *     (`PUT /servers/:id/license-tier`): a manager gives one server a
 *     license at a tier with a free seat, or releases it. No other server is
 *     touched.
 *   - {@link moveNamedServerTier}, behind an owner's upgrade or downgrade
 *     that names one server (`/billing/upgrade`, `/billing/downgrade` with
 *     `serverId`): once the bought change has landed, that server — and no
 *     other — moves from the old tier to the new one.
 *   - {@link applyAddServerTierAtEnroll}, once, when a server first enrolls
 *     with a registration key that carries the tier a manager chose in Add
 *     Server (`license.tier_id`). The key held that seat from the moment it
 *     was minted, so the server takes exactly that seat; it is never a
 *     different tier, and a key with no tier assigns nothing.
 *   - {@link fillSelfHostedGrantTier}, self-hosted only: every server there
 *     runs on the top tier (`SX`, the grant in `self-hosted-grant.ts`), so a
 *     licensed server with no tier yet gets the grant's tier. It only fills
 *     an empty column and is never called on the hosted runtime.
 *
 * A hardware report, an enroll without a chosen tier, a reconnect, a session,
 * a seat or subscription change and a server delete never assign, move or
 * release a license. A server that
 * measures bigger than its tier keeps its tier and is flagged
 * (`over-plan-flag.ts`, the reconcile sweep, the notice sweep).
 *
 * Workers-bundleable: nothing at module load.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  isEndedStatus,
  listSeatsForOrganization,
  type OrganizationBillingState,
} from '../billing/billing-records.ts'
import { license, organization, server } from '../../db/schema.ts'
import { parseServerHostResources, type ServerHostResources } from '../servers/server-metadata.ts'
import {
  type AssignableServer,
  freeAtTier,
  readAssignment,
  type TierAssignment,
  type TierQuantity,
} from './assignment.ts'
import { resolveRequiredTier, totalPhysicalCores } from './tier-placement.ts'
import { topologyRecordFromColumn } from '../servers/server-topology-records.ts'
import { parseTopologySnapshot, recommendedRankFromMetadata } from './topology-recommendation.ts'
import { selfHostedGrantRank } from './self-hosted-grant.ts'
import { countReservedLicenseTiers } from './tier-records.ts'
import { readSelfHostedGrant } from './self-hosted-grant-records.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Hardware is "known" once cores or bytes are reported; until then the entry rank is assumed. */
export function requiredRankFromResources(
  resources: ServerHostResources | undefined
): number | null {
  if (!resources) return null
  const known = totalPhysicalCores(resources) > 0 || (resources.memory?.totalBytes ?? 0) > 0
  return known ? resolveRequiredTier(resources).rank : null
}

export function requiredRankFromMetadata(metadata: unknown): number | null {
  const record = isRecord(metadata) ? metadata : undefined
  return requiredRankFromResources(parseServerHostResources(record?.resources))
}

/**
 * Entitled quantity per tier with the tier's rank — the input to
 * {@link readAssignment} and to every coverage gate.
 *
 * Two sources, added together. Projected provider seats read as zero once
 * the subscription ended, because entitlement follows the money. The
 * self-hosted grant (`self-hosted-grant.ts`) does not: it is not a
 * purchase, so no subscription status can end it, and a self-hosted
 * organization has no subscription at all. Both land at the tier they name,
 * so an organization holding a grant *and* provider seats at `SX` sums to
 * one quantity there rather than two entries.
 */
export function tierQuantitiesFromState(state: OrganizationBillingState): TierQuantity[] {
  const ended = !state.subscription || isEndedStatus(state.subscription.status)
  const out = new Map<string, TierQuantity>()
  const add = (tierId: string, rank: number, quantity: number) => {
    const existing = out.get(tierId)
    out.set(tierId, {
      tierId,
      rank,
      quantity: (existing?.quantity ?? 0) + quantity,
    })
  }
  for (const seat of state.seats) {
    add(seat.tierId, seat.tier.rank, ended ? 0 : seat.quantity)
  }
  if (state.grant) {
    add(state.grant.tierId, selfHostedGrantRank(), state.grant.quantity)
  }
  return [...out.values()]
}

export type AssignedServerRow = AssignableServer

/** Every server in the organization holding an active license, with its requirement and the tier it holds. */
export async function loadAssignableServers(
  db: Db,
  organizationId: string
): Promise<AssignedServerRow[]> {
  const rows = await db
    .select({
      serverId: server.id,
      createdAt: server.createdAt,
      metadata: server.metadata,
      hardware: server.hardware,
      assignedTierId: server.assignedTierId,
    })
    .from(server)
    .innerJoin(license, and(eq(license.serverId, server.id), isNull(license.revokedAt)))
    .where(eq(server.organizationId, organizationId))
  return rows.map((row) => ({
    serverId: row.serverId,
    boundAt: row.createdAt,
    requiredRank: requiredRankFromMetadata(row.metadata),
    recommendedRank: recommendedRankFromMetadata(
      row.metadata,
      parseTopologySnapshot(topologyRecordFromColumn(row.hardware)?.snapshot)
    ),
    assignedTierId: row.assignedTierId,
  }))
}

export type ReadAssignmentOpts = Readonly<{
  /** Already-loaded billing state, to skip the read. */
  state?: OrganizationBillingState
  /** Seats held by unused registration keys, taken out of `spare`. */
  reserved?: ReadonlyMap<string, number>
}>

/** Read-only: the organization's assignment against its purchases (spare counts, uncovered servers). Never writes. */
export async function peekOrganizationAssignment(
  db: Db,
  organizationId: string,
  opts: ReadAssignmentOpts = {}
): Promise<TierAssignment> {
  const state = opts.state ?? (await listSeatsForOrganization(db, organizationId))
  const servers = await loadAssignableServers(db, organizationId)
  return readAssignment(tierQuantitiesFromState(state), servers, opts.reserved)
}

export type AssignServerTierResult =
  | Readonly<{ ok: true; assignment: TierAssignment; assignedTierId: string | null }>
  | Readonly<{ ok: false; code: 'server_not_licensed' | 'no_free_seat' }>

/**
 * A manager's assignment: put one licensed server on `tierId` (a seat there
 * must be free — nothing is bought here) or release its license (`null`).
 * Only this server's row is written; no other server moves. Runs under the
 * organization row lock so two managers cannot both take the last seat.
 */
export async function assignServerTier(
  db: Db,
  organizationId: string,
  serverId: string,
  tierId: string | null,
  now: string = new Date().toISOString()
): Promise<AssignServerTierResult> {
  return await db.transaction(async (tx) => {
    await lockOrganizationRow(tx, organizationId)
    const state = await listSeatsForOrganization(tx, organizationId)
    const servers = await loadAssignableServers(tx, organizationId)
    const reserved = await countReservedLicenseTiers(tx, organizationId)
    const mine = servers.find((entry) => entry.serverId === serverId)
    if (!mine) return { ok: false, code: 'server_not_licensed' } as const
    const quantities = tierQuantitiesFromState(state)
    if (
      tierId !== null &&
      tierId !== mine.assignedTierId &&
      freeAtTier(quantities, servers, tierId, serverId, reserved) < 1
    ) {
      return { ok: false, code: 'no_free_seat' } as const
    }
    await tx
      .update(server)
      .set({ assignedTierId: tierId, preferredTierId: tierId, updatedAt: now })
      .where(eq(server.id, serverId))
    const next = servers.map((entry) =>
      entry.serverId === serverId ? { ...entry, assignedTierId: tierId } : entry
    )
    return {
      ok: true,
      assignment: readAssignment(quantities, next, reserved),
      assignedTierId: tierId,
    } as const
  })
}

/**
 * The organization row lock every seat-taking write runs under — a manager's
 * assignment, a mint that holds a seat for its key, and the enroll that turns
 * that held seat into the server's — so two of them cannot take the last seat.
 */
export async function lockOrganizationRow(tx: Db, organizationId: string): Promise<void> {
  await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .for('update')
    .limit(1)
}

export type AddServerTierAtEnroll = 'assigned' | 'no_free_seat' | 'already_set'

/**
 * The Add Server choice, honoured at enroll: a server that first enrolled
 * with a registration key carrying `tierId` (the tier a manager chose in Add
 * Server) takes a seat at exactly that tier. The key held that seat since it
 * was minted, so the seat is normally there; only when it is gone after all
 * (seats removed in between) is the server left without a tier, with the
 * choice kept in `preferred_tier_id` so the console can say why. Never a
 * different tier, never another server's seat, and a tier already on the
 * server is left alone, so a repeat call changes nothing. Runs inside the
 * caller's transaction, the one that latches the key to a new server row
 * (`insertLicensedServer`), so the held seat is never free in between and a
 * reconnect never re-applies it over a manager's later change.
 */
export async function applyAddServerTierAtEnroll(
  tx: Db,
  organizationId: string,
  serverId: string,
  tierId: string,
  now: string = new Date().toISOString()
): Promise<AddServerTierAtEnroll> {
  await lockOrganizationRow(tx, organizationId)
  const [row] = await tx
    .select({ assignedTierId: server.assignedTierId, preferredTierId: server.preferredTierId })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  if (row?.assignedTierId !== null || row.preferredTierId !== null) {
    return 'already_set'
  }
  const state = await listSeatsForOrganization(tx, organizationId)
  const servers = await loadAssignableServers(tx, organizationId)
  // This server's key is consumed now, so its own held seat is no longer
  // in `reserved`: what is left is exactly the seat it may take.
  const reserved = await countReservedLicenseTiers(tx, organizationId)
  const free = freeAtTier(tierQuantitiesFromState(state), servers, tierId, serverId, reserved)
  const assigned = free >= 1
  await tx
    .update(server)
    .set({
      ...(assigned ? { assignedTierId: tierId } : {}),
      preferredTierId: tierId,
      updatedAt: now,
    })
    .where(and(eq(server.id, serverId), isNull(server.assignedTierId)))
  return assigned ? 'assigned' : 'no_free_seat'
}

/**
 * The one server an owner's upgrade or downgrade named moves from `fromTierId`
 * to `toTierId`. Only when it still holds `fromTierId` (compare-and-set), so
 * a manager's change in between wins. Returns whether it moved.
 */
export async function moveNamedServerTier(
  db: Db,
  serverId: string,
  fromTierId: string,
  toTierId: string,
  now: string = new Date().toISOString()
): Promise<boolean> {
  const moved = await db
    .update(server)
    .set({ assignedTierId: toTierId, preferredTierId: toTierId, updatedAt: now })
    .where(and(eq(server.id, serverId), eq(server.assignedTierId, fromTierId)))
    .returning({ id: server.id })
  return moved.length > 0
}

/**
 * THE ONE AUTOMATIC ASSIGNMENT, SELF-HOSTED ONLY. A self-hosted control plane
 * has nothing to buy, so a licensed server with no size yet gets the grant's
 * top size (`SX`). It is never called on the hosted runtime, where only a
 * manager assigns a size. It fills an empty column only: a size a manager
 * already gave a server is never overwritten, and no server is ever moved.
 */
export async function fillSelfHostedGrantTier(db: Db, organizationId: string): Promise<void> {
  const grant = await readSelfHostedGrant(db, organizationId)
  if (!grant || grant.quantity <= 0) return
  const empty = await db
    .select({ serverId: server.id })
    .from(server)
    .innerJoin(license, and(eq(license.serverId, server.id), isNull(license.revokedAt)))
    .where(and(eq(server.organizationId, organizationId), isNull(server.assignedTierId)))
  if (empty.length === 0) return
  await db
    .update(server)
    .set({ assignedTierId: grant.tierId })
    .where(
      and(
        inArray(
          server.id,
          empty.map((row) => row.serverId)
        ),
        isNull(server.assignedTierId)
      )
    )
}

/**
 * {@link fillSelfHostedGrantTier} resolved from a server row; a server with no
 * organization is a no-op. Self-hosted callers only — never call this on the
 * hosted runtime.
 */
export async function fillSelfHostedGrantTierForServer(db: Db, serverId: string): Promise<void> {
  const [row] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!row?.organizationId) return
  await fillSelfHostedGrantTier(db, row.organizationId)
}
