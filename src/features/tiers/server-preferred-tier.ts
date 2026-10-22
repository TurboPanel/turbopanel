/**
 * A manager's choice of a server's license tier (`PUT /servers/:id/license-tier`).
 * The only hosted path that writes `server.assigned_tier_id`: the server
 * takes a free seat at the tier the manager picked, or gives its license back
 * (`null`). Nothing is bought, and no other server moves. A manager may keep a
 * server on a smaller tier than it measures; it is then flagged, not moved.
 * `preferred_tier_id` is written in step so the console's "picked" label stays.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tier } from '../../db/schema.ts'
import { assignServerTier, peekOrganizationAssignment } from './assignment-records.ts'
import { listActiveTiers } from './tier-records.ts'

export type SetServerPreferredTierResult =
  | Readonly<{
      ok: true
      assignedTierId: string | null
      assignedTierLabel: string | null
      preferredTierId: string | null
      preferredTierLabel: string | null
      tiersFree: readonly { tierId: string; label: string; free: number }[]
    }>
  | Readonly<{ ok: false; code: 'no_free_seat' | 'tier_not_found' | 'server_not_licensed' }>

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
  let label: string | null = null
  if (tierId) {
    const [tierRow] = await db
      .select({ id: tier.id, label: tier.label, isActive: tier.isActive })
      .from(tier)
      .where(eq(tier.id, tierId))
      .limit(1)
    if (!tierRow?.isActive) return { ok: false, code: 'tier_not_found' }
    label = tierRow.label
  }

  const result = await assignServerTier(db, organizationId, serverId, tierId)
  if (!result.ok) return result

  const catalog = await listActiveTiers(db)
  return {
    ok: true,
    assignedTierId: result.assignedTierId,
    assignedTierLabel: label,
    preferredTierId: tierId,
    preferredTierLabel: label,
    tiersFree: spareCountsFromAssignment(result.assignment.spare, catalog),
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
