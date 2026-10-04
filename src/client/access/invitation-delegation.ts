/**
 * Who may invite someone into a team.
 *
 * Joining a team confers every grant the team holds (the team is an actor in
 * `can()`), so an invitation hands out those grants just as surely as an
 * explicit `grants` list would. An inviter may therefore only invite into a team
 * whose grants they already hold themselves: a team manager cannot reach
 * organization-wide access by inviting a second address of their own into a
 * team that carries it.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { grant } from '../../db/schema.ts'
import { isPermissionKey } from '../authz/catalog.ts'
import { can } from '../authz/index.ts'

/** True when `inviterId` holds every grant that team `teamId` holds as an actor. */
export async function inviterHoldsTeamGrants(
  db: Db,
  inviterId: string,
  teamId: string
): Promise<boolean> {
  const conferred = await db
    .select({
      entityType: grant.entityType,
      entityId: grant.entityId,
      permission: grant.permission,
    })
    .from(grant)
    .where(and(eq(grant.actorType, 'team'), eq(grant.actorId, teamId)))
  const held = await Promise.all(
    conferred.map((row) =>
      isPermissionKey(row.permission)
        ? can(db, inviterId, row.permission, row.entityType, row.entityId)
        : Promise.resolve(false)
    )
  )
  return held.every(Boolean)
}
