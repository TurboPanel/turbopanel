/**
 * Operator pick of `server.preferred_tier_id` and the assignment recompute that
 * follows. Hosted only — self-hosted has no purchasable tiers to pick.
 */

import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { license, organization, server, tier } from '../../db/schema.ts'
import {
  peekOrganizationAssignment,
  recomputeOrganizationAssignments,
  requiredRankFromMetadata,
} from './assignment-records.ts'
import { effectiveRequiredRank } from './assignment.ts'
import { listActiveTiers } from './tier-records.ts'

export type SetServerPreferredTierResult =
  | Readonly<{
      ok: true
      assignedTierId: string | null
      assignedTierLabel: string | null
      preferredTierId: string | null
      preferredTierLabel: string | null
      tierPickNotice: string | null
      tiersFree: readonly { tierId: string; label: string; free: number }[]
    }>
  | Readonly<{ ok: false; code: 'tier_below_required' | 'tier_not_found' | 'server_not_licensed' }>

function tierPickNotice(wantedLabel: string): string {
  return `${wantedLabel} wanted, none free`
}

/** Notice for one server from the assignment's post-swap `pickUnfulfilled` map. */
export function resolveTierPickNotice(
  serverId: string,
  pickUnfulfilled: ReadonlyMap<string, string>
): string | null {
  const label = pickUnfulfilled.get(serverId)
  return label ? tierPickNotice(label) : null
}

export function spareCountsFromAssignment(
  spare: ReadonlyMap<string, number>,
  tiers: readonly { id: string; label: string }[]
): { tierId: string; label: string; free: number }[] {
  const byId = new Map(tiers.map((row) => [row.id, row.label]))
  return [...spare.entries()]
    .filter(([, free]) => free > 0)
    .map(([tierId, free]) => ({
      tierId,
      label: byId.get(tierId) ?? tierId,
      free,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export async function setServerPreferredTier(
  db: Db,
  organizationId: string,
  serverId: string,
  tierId: string | null
): Promise<SetServerPreferredTierResult> {
  const [row] = await db
    .select({
      metadata: server.metadata,
      preferredTierId: server.preferredTierId,
    })
    .from(server)
    .innerJoin(license, and(eq(license.serverId, server.id), isNull(license.revokedAt)))
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  if (!row) return { ok: false, code: 'server_not_licensed' }

  let preferredLabel: string | null = null
  if (tierId) {
    const [tierRow] = await db
      .select({ id: tier.id, label: tier.label, rank: tier.rank, isActive: tier.isActive })
      .from(tier)
      .where(eq(tier.id, tierId))
      .limit(1)
    if (!tierRow?.isActive) return { ok: false, code: 'tier_not_found' }
    const need = effectiveRequiredRank({ requiredRank: requiredRankFromMetadata(row.metadata) })
    if (tierRow.rank < need) return { ok: false, code: 'tier_below_required' }
    preferredLabel = tierRow.label
  }

  const now = new Date().toISOString()
  const { assignment, assignedTierId } = await db.transaction(async (tx) => {
    await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .for('update')
      .limit(1)
    await tx
      .update(server)
      .set({ preferredTierId: tierId, updatedAt: now })
      .where(eq(server.id, serverId))
    const { assignment } = await recomputeOrganizationAssignments(tx, organizationId)
    const assignedTierId = assignment.byServer.get(serverId) ?? null
    return { assignment, assignedTierId }
  })

  const notice = tierId ? resolveTierPickNotice(serverId, assignment.pickUnfulfilled) : null

  let assignedTierLabel: string | null = null
  if (assignedTierId) {
    const [assigned] = await db
      .select({ label: tier.label })
      .from(tier)
      .where(eq(tier.id, assignedTierId))
      .limit(1)
    assignedTierLabel = assigned?.label ?? null
  }

  const catalog = await listActiveTiers(db)
  const tiersFree = spareCountsFromAssignment(assignment.spare, catalog)

  return {
    ok: true,
    assignedTierId,
    assignedTierLabel,
    preferredTierId: tierId,
    preferredTierLabel: preferredLabel,
    tierPickNotice: notice,
    tiersFree,
  }
}

export async function loadOrganizationTierSpare(
  db: Db,
  organizationId: string
): Promise<readonly { tierId: string; label: string; free: number }[]> {
  const assignment = await peekOrganizationAssignment(db, organizationId)
  const catalog = await listActiveTiers(db)
  return spareCountsFromAssignment(assignment.spare, catalog)
}

export async function tierPickNoticeForServer(
  db: Db,
  organizationId: string,
  serverId: string
): Promise<string | null> {
  const [row] = await db
    .select({ preferredTierId: server.preferredTierId })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  if (!row?.preferredTierId) return null
  const assignment = await peekOrganizationAssignment(db, organizationId)
  return resolveTierPickNotice(serverId, assignment.pickUnfulfilled)
}
