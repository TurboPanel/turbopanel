import { and, eq, gt } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  InvitationGrantValidationError,
  materializeInvitationGrants,
  resolveInvitationGrants,
} from '../authn/invitation-grants.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import {
  mapGrantRows,
  revokeAccessGrant,
} from '../authz/access-grants.ts'
import { createAccessGrant, isAccessGrantEntityType } from '../authz/create-access-grant.ts'
import {
  resolveEntityById,
  resolveEntityByKindAndItemId,
} from '../authz/entity-resolver.ts'
import {
  assertNotLastOrgOwner,
  assertNotLastTeamOwner,
  assertOrgOwnerOr403,
  can,
  canManageOrganization,
} from '../authz/index.ts'
import { getPermissionCatalog } from '../authz/catalog.ts'
import type { Db } from '../../db.ts'
import { getDb } from '../../db.ts'
import { grant, invitation, team, teammate } from '../../lib/db/schema.ts'
import { getOrgId } from '../shared.ts'
import {
  invitationAcceptErrorPayload,
  invitationEmailsMatch,
  organizationResourceIdMismatch,
  ownerRemovalConflictMessage,
  parseCreateAccessBody as parseCreateAccessBodyRecord,
  type CreateAccessInput,
  validateAccessCheckQuery,
  validateAccessListQuery,
  validateAccessResourceIdQuery,
} from './routes-helpers.ts'

async function assertRevocableAllowGrant(
  db: Db,
  accessRow: {
    entityType: string
    entityId: string
    permission: string
    actorId: string
  },
): Promise<void> {
  if (
    accessRow.entityType === 'organization' &&
    accessRow.permission === 'organization:own'
  ) {
    await assertNotLastOrgOwner(db, accessRow.entityId, accessRow.actorId)
    return
  }
  if (accessRow.entityType === 'team' && accessRow.permission === 'team:own') {
    await assertNotLastTeamOwner(db, accessRow.entityId, accessRow.actorId)
  }
}

// Listing, creating, and revoking access grants are owner-only operations.
// An organization *manager* must not be able to reach them, so this uses the
// exact owner-only guard (`organization:own`) rather than a broad org-access
// check.
async function assertCanManageAccessOr403(
  c: Context,
  db: Db,
  resourceId: string,
): Promise<Response | null> {
  const entity = await resolveEntityById(db, resourceId)
  if (!entity) {
    return c.json({ error: 'Not found' }, 404)
  }

  return assertOrgOwnerOr403(c, entity.entityType, entity.entityId)
}

async function parseCreateAccessBody(
  c: Context,
): Promise<CreateAccessInput | { response: Response }> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return { response: c.json({ error: 'Invalid request' }, 400) }
  }

  const parsed = parseCreateAccessBodyRecord(body)
  if ('ok' in parsed) {
    return { response: c.json({ error: parsed.error }, parsed.status) }
  }

  return parsed
}

export function registerAccessRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for access routes')
  }
  const secrets = opts.secrets

  router.use('/invitations/:id/accept', createSessionMiddleware(secrets))

  router.post('/invitations/:id/accept', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session?.userId) return c.json({ error: 'Unauthorized' }, 401)

    const invitationId = c.req.param('id')
    const now = new Date().toISOString()

    const inviteRows = await db
      .select()
      .from(invitation)
      .where(eq(invitation.id, invitationId))
      .limit(1)

    const invitePreview = inviteRows[0]
    if (!invitePreview) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (!invitationEmailsMatch(invitePreview.email, session.email)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    type AcceptResult =
      | { ok: true; organizationId: string }
      | { error: 'gone' | 'invalid_grant' }

    const result: AcceptResult = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(invitation)
        .set({ status: 'accepted' })
        .where(
          and(
            eq(invitation.id, invitationId),
            eq(invitation.status, 'pending'),
            gt(invitation.expiresAt, now),
          ),
        )
        .returning()

      const invite = claimed[0]
      if (!invite) {
        return { error: 'gone' as const }
      }

      const teamRows = await tx
        .select({ organizationId: team.organizationId })
        .from(team)
        .where(eq(team.id, invite.teamId))
        .limit(1)

      const organizationId = teamRows[0]?.organizationId
      if (!organizationId) {
        return { error: 'gone' as const }
      }

      await tx
        .insert(teammate)
        .values({
          teamId: invite.teamId,
          userId: session.userId,
        })
        .onConflictDoNothing({
          target: [teammate.teamId, teammate.userId],
        })

      const grants = resolveInvitationGrants(
        invite.grants,
        organizationId,
      )

      try {
        await materializeInvitationGrants(
          tx,
          session.userId,
          grants,
          organizationId,
        )
      } catch (err) {
        if (err instanceof InvitationGrantValidationError) {
          return { error: 'invalid_grant' as const }
        }
        throw err
      }

      return { ok: true as const, organizationId }
    })

    if ('error' in result) {
      const payload = invitationAcceptErrorPayload(result.error)
      return c.json(payload.body, payload.status)
    }

    return c.json({ ok: true as const, organizationId: result.organizationId })
  })

  router.use('/permissions', createSessionMiddleware(secrets))
  router.use('/access/check', createSessionMiddleware(secrets))
  router.use('/access/resource-id', createSessionMiddleware(secrets))
  router.use('/access', createSessionMiddleware(secrets))
  router.use('/access/:id', createSessionMiddleware(secrets))

  router.get('/permissions', (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const permissions = getPermissionCatalog()
    return c.json({ permissions })
  })

  router.get('/access/check', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const resourceId = c.req.query('resourceId')?.trim()
    const permissionKey = c.req.query('permissionKey')?.trim()
    const validated = validateAccessCheckQuery(resourceId, permissionKey)
    if (!('ok' in validated) || validated.ok === false) {
      return c.json({ error: validated.error }, validated.status)
    }

    const entity = await resolveEntityById(db, validated.resourceId)
    if (!entity) {
      return c.json({ error: 'Not found' }, 404)
    }

    const allowed = await can(
      db,
      session.userId,
      validated.permissionKey,
      entity.entityType,
      entity.entityId,
    )

    return c.json({ allowed })
  })

  router.get('/access/resource-id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const kind = c.req.query('kind')?.trim()
    const itemId = c.req.query('itemId')?.trim()
    const validated = validateAccessResourceIdQuery(kind, itemId)
    if (!('ok' in validated) || validated.ok === false) {
      return c.json({ error: validated.error }, validated.status)
    }

    if (!isAccessGrantEntityType(validated.kind)) {
      return c.json({ error: 'Not found' }, 404)
    }

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const entity = await resolveEntityByKindAndItemId(
      db,
      validated.kind,
      validated.itemId,
    )
    if (entity?.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (organizationResourceIdMismatch(validated.kind, validated.itemId, organizationId)) {
      return c.json({ error: 'Not found' }, 404)
    }
    if (validated.kind === 'organization') {
      return c.json({
        resourceId: entity.entityId,
        kind: validated.kind,
        itemId: validated.itemId,
      })
    }

    const visible = await canManageOrganization(
      db,
      session.userId,
      organizationId,
    )

    if (!visible) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return c.json({
      resourceId: entity.entityId,
      kind: validated.kind,
      itemId: validated.itemId,
    })
  })

  router.get('/access', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const resourceId = c.req.query('resourceId')?.trim()
    const validated = validateAccessListQuery(resourceId)
    if (!('ok' in validated) || validated.ok === false) {
      return c.json({ error: validated.error }, validated.status)
    }

    const entity = await resolveEntityById(db, validated.resourceId)
    if (!entity) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (!isAccessGrantEntityType(entity.entityType)) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageAccessOr403(c, db, validated.resourceId)
    if (denied) return denied

    const rows = await db
      .select({
        id: grant.id,
        entityType: grant.entityType,
        entityId: grant.entityId,
        actorType: grant.actorType,
        actorId: grant.actorId,
        permission: grant.permission,
      })
      .from(grant)
      .where(
        and(
          eq(grant.entityType, entity.entityType),
          eq(grant.entityId, entity.entityId),
        ),
      )
      .orderBy(grant.createdAt)

    return c.json({ access: mapGrantRows(rows) })
  })

  router.post('/access', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const parsed = await parseCreateAccessBody(c)
    if ('response' in parsed) {
      return parsed.response
    }
    const { subjectKind, subjectId, resourceId, permissionKey } = parsed

    const entity = await resolveEntityById(db, resourceId)
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404)
    }

    if (!isAccessGrantEntityType(entity.entityType)) {
      return c.json({ error: 'Entity not found' }, 404)
    }

    const denied = await assertCanManageAccessOr403(c, db, resourceId)
    if (denied) return denied

    const result = await createAccessGrant(db, {
      entityType: entity.entityType,
      entityId: entity.entityId,
      actorType: subjectKind,
      actorId: subjectId,
      permissionKey,
    })

    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }

    return c.json({
      ok: true as const,
      id: result.ids[0]!,
      created: result.created,
    })
  })

  router.delete('/access/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const accessId = c.req.param('id')
    const accessRows = await db
      .select({
        entityType: grant.entityType,
        entityId: grant.entityId,
        permission: grant.permission,
        actorId: grant.actorId,
      })
      .from(grant)
      .where(eq(grant.id, accessId))
      .limit(1)

    const accessRow = accessRows[0]
    if (!accessRow) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageAccessOr403(c, db, accessRow.entityId)
    if (denied) return denied

    try {
      await assertRevocableAllowGrant(db, accessRow)
    } catch (err) {
      const conflict = ownerRemovalConflictMessage(err)
      if (conflict) {
        return c.json({ error: conflict }, 409)
      }
      throw err
    }

    const revoked = await revokeAccessGrant(db, accessId)
    if (!revoked) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json({ ok: true as const })
  })
}
