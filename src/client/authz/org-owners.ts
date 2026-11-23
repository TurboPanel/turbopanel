import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { grant, team, teammate, user } from '../../db/schema.ts'

export const LAST_ORG_OWNER_MESSAGE = 'Cannot remove the last owner of an organization'

/** What a change would take away from the organization's owners. */
export type OrganizationOwnerChange =
  /** A person leaves: their team rows and grants in the organization go. */
  | { userId: string }
  /** One grant row is revoked. */
  | { grantId: string }

/**
 * Active people who own the organization: an `organization:own` grant held by
 * the user, by a team they belong to, or by the organization itself while they
 * sit on one of its teams. This is the same reading `can()` gives for
 * `organization:own`, minus the platform-admin bypass (an administrator does
 * not hold the organization), and it skips disabled accounts. Counting grant
 * rows is wrong: an empty team or the organization actor holds a row but is
 * nobody.
 */
export async function listOrganizationOwnerIds(
  db: Db,
  organizationId: string,
  exceptGrantId?: string
): Promise<string[]> {
  const skipGrant = exceptGrantId ? sql`AND g.id <> ${exceptGrantId}::uuid` : sql``
  const rows = (await db.execute(sql`
    SELECT u.id AS id
    FROM ${user} u
    WHERE u.is_disabled = false
      AND EXISTS (
        SELECT 1
        FROM ${grant} g
        WHERE g.entity_type = 'organization'
          AND g.entity_id = ${organizationId}::uuid
          AND g.permission = 'organization:own'
          ${skipGrant}
          AND (
            (g.actor_type = 'user' AND g.actor_id = u.id)
            OR (
              g.actor_type = 'team'
              AND EXISTS (
                SELECT 1 FROM ${teammate} tm
                WHERE tm.team_id = g.actor_id AND tm.user_id = u.id
              )
            )
            OR (
              g.actor_type = 'organization'
              AND EXISTS (
                SELECT 1 FROM ${teammate} tm
                JOIN ${team} t ON t.id = tm.team_id
                WHERE tm.user_id = u.id AND t.organization_id = g.actor_id
              )
            )
          )
      )
  `)) as unknown as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * True when the change would leave an organization that has an owner today
 * without one. Run it inside the transaction that makes the change, after
 * locking the organization's owner grant rows (`lockOrganizationOwnerGrants`).
 */
export async function organizationWouldLoseAllOwners(
  db: Db,
  organizationId: string,
  change: OrganizationOwnerChange
): Promise<boolean> {
  if ('grantId' in change) {
    const before = await listOrganizationOwnerIds(db, organizationId)
    if (before.length === 0) return false
    return (await listOrganizationOwnerIds(db, organizationId, change.grantId)).length === 0
  }
  const before = await listOrganizationOwnerIds(db, organizationId)
  return before.length > 0 && before.every((id) => id === change.userId)
}

/** Serialise concurrent owner changes on one organization (row locks until commit). */
export async function lockOrganizationOwnerGrants(db: Db, organizationId: string): Promise<void> {
  await db.execute(sql`
    SELECT g.id FROM ${grant} g
    WHERE g.entity_type = 'organization'
      AND g.entity_id = ${organizationId}::uuid
      AND g.permission = 'organization:own'
    FOR UPDATE
  `)
}

export async function assertNotLastOrgOwner(
  db: Db,
  organizationId: string,
  change: OrganizationOwnerChange
): Promise<void> {
  if (await organizationWouldLoseAllOwners(db, organizationId, change)) {
    throw new Error(LAST_ORG_OWNER_MESSAGE)
  }
}
