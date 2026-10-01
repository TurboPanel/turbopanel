/**
 * Removing a person from an organization (`DELETE /organizations/:id/members/:memberId`).
 *
 * Membership is not one row: a person is "in" an organization through a
 * `teammate` row on any of its teams, through grants on the organization or on
 * things inside it, or both. Revoking a single grant leaves the rest, which is
 * why this route removes all of it in one transaction.
 *
 * Sessions are not touched on purpose. A session belongs to the account, not to
 * an organization, and the person may belong to other organizations; every read
 * re-checks membership per request, so the removed person is refused at once.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { getDb } from '../../db/connection.ts'
import { grant, team, teammate } from '../../db/schema.ts'
import { recordAuditAndNotify } from '../../features/notifications/audit-bridge.ts'
import { isUuid } from '../access/routes-helpers.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { canManageOrganization, canOwnOrganization } from '../authz/index.ts'
import { canAccessOrganization } from '../org-context.ts'

const LAST_OWNER_MESSAGE = 'Cannot remove the last owner of an organization'

type MemberFootprint = {
  isMember: boolean
  isOwner: boolean
  /** Every grant this person holds on the organization or anything inside it. */
  grantIds: string[]
}

type RemovalOutcome =
  { status: 'removed'; grantsRemoved: number; teamsLeft: number } | { status: 'last_owner' }

async function inOrganizationTeams(db: Db, userId: string, organizationId: string) {
  return await db
    .select({ id: teammate.id })
    .from(teammate)
    .innerJoin(team, eq(teammate.teamId, team.id))
    .where(and(eq(teammate.userId, userId), eq(team.organizationId, organizationId)))
}

/** What ties `userId` to the organization today. */
async function loadFootprint(
  db: Db,
  organizationId: string,
  userId: string
): Promise<MemberFootprint> {
  const [teamRows, userGrants] = await Promise.all([
    inOrganizationTeams(db, userId, organizationId),
    db
      .select({
        id: grant.id,
        entityType: grant.entityType,
        entityId: grant.entityId,
        permission: grant.permission,
      })
      .from(grant)
      .where(and(eq(grant.actorType, 'user'), eq(grant.actorId, userId))),
  ])
  const owners = await Promise.all(
    userGrants.map((g) => resolveEntityOrganizationId(db, g.entityType, g.entityId))
  )
  const inOrg = userGrants.filter((_, i) => owners[i] === organizationId)
  return {
    isMember: teamRows.length > 0 || inOrg.length > 0,
    isOwner: inOrg.some(
      (g) =>
        g.permission === 'organization:own' &&
        g.entityType === 'organization' &&
        g.entityId === organizationId
    ),
    grantIds: inOrg.map((g) => g.id),
  }
}

/**
 * Delete the person's team memberships and grants inside the organization.
 * Owner grants are row-locked first so two owners removing each other at the
 * same time cannot leave the organization with none.
 */
async function removeMemberRows(
  db: Db,
  organizationId: string,
  userId: string,
  grantIds: string[]
): Promise<RemovalOutcome> {
  return await db.transaction(async (tx) => {
    const owners = await tx
      .select({ actorId: grant.actorId })
      .from(grant)
      .where(
        and(
          eq(grant.entityType, 'organization'),
          eq(grant.entityId, organizationId),
          eq(grant.permission, 'organization:own')
        )
      )
      .for('update')
    if (owners.length === 1 && owners[0]?.actorId === userId) {
      return { status: 'last_owner' as const }
    }
    const left = await tx
      .delete(teammate)
      .where(
        and(
          eq(teammate.userId, userId),
          inArray(
            teammate.teamId,
            sql`(select ${team.id} from ${team} where ${team.organizationId} = ${organizationId})`
          )
        )
      )
      .returning({ id: teammate.id })
    const revoked =
      grantIds.length === 0
        ? []
        : await tx
            .delete(grant)
            .where(and(inArray(grant.id, grantIds), eq(grant.actorId, userId)))
            .returning({ id: grant.id })
    return { status: 'removed' as const, grantsRemoved: revoked.length, teamsLeft: left.length }
  })
}

type Denial = { status: 403; error: string }

/** Who may remove whom. Leaving is always allowed; removing someone needs owner/manager, and only an owner may remove an owner. */
async function removalDenial(
  db: Db,
  organizationId: string,
  callerId: string,
  target: { userId: string; isOwner: boolean }
): Promise<Denial | null> {
  if (callerId === target.userId) return null
  if (!(await canManageOrganization(db, callerId, organizationId))) {
    return { status: 403, error: 'Forbidden' }
  }
  if (target.isOwner && !(await canOwnOrganization(db, callerId, organizationId))) {
    return { status: 403, error: 'Only an owner can remove an owner' }
  }
  return null
}

export function registerOrganizationMemberRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization member routes')
  }
  router.use('/organizations/:id/members/:memberId', createSessionMiddleware(opts.secrets))

  router.delete('/organizations/:id/members/:memberId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const organizationId = c.req.param('id')
    const memberId = c.req.param('memberId')
    if (!isUuid(organizationId) || !isUuid(memberId)) return c.json({ error: 'Not found' }, 404)
    if (!(await canAccessOrganization(db, session.userId, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const footprint = await loadFootprint(db, organizationId, memberId)
    if (!footprint.isMember) return c.json({ error: 'Not found' }, 404)

    const denial = await removalDenial(db, organizationId, session.userId, {
      userId: memberId,
      isOwner: footprint.isOwner,
    })
    if (denial) return c.json({ error: denial.error }, denial.status)

    const outcome = await removeMemberRows(db, organizationId, memberId, footprint.grantIds)
    if (outcome.status === 'last_owner') {
      return c.json({ error: LAST_OWNER_MESSAGE }, 409)
    }

    await recordAuditAndNotify(
      c,
      {
        organizationId,
        actorUserId: session.userId,
        actorEmail: session.email,
        action: 'member.remove',
        targetType: 'organization',
        targetId: organizationId,
        context: {
          memberId,
          left: session.userId === memberId,
          grantsRemoved: outcome.grantsRemoved,
          teamsLeft: outcome.teamsLeft,
        },
      },
      { permissionKey: 'organization membership', subjectKind: 'user', subjectId: memberId }
    )
    return c.json({ ok: true as const })
  })
}
