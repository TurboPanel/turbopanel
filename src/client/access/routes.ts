import { and, eq, gt } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
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
import {
  getPermissionCatalog,
  isPermissionKey,
  PERMISSIONS,
  type PermissionKey,
} from '../authz/catalog.ts'
import type { Db } from '../../db.ts'
import { getDb } from '../../db.ts'
import { grant, invitation, membership, team, teammate } from '../../lib/db/schema.ts'
import { getOrgId } from '../shared.ts'
import { isUuid, ownerRemovalConflictMessage } from './routes-helpers.ts'

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

interface CreateAccessInput {
  subjectKind: 'user' | 'team' | 'organization'
  subjectId: string
  resourceId: string
  permissionKey: PermissionKey
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

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { response: c.json({ error: 'Invalid request' }, 400) }
  }

  const record = body as Record<string, unknown>
  const { subjectKind, subjectId, resourceId, effect, permissionKey } = record

  if (
    subjectKind !== 'user' &&
    subjectKind !== 'team' &&
    subjectKind !== 'organization'
  ) {
    return { response: c.json({ error: 'Invalid request' }, 400) }
  }
  if (typeof subjectId !== 'string' || typeof resourceId !== 'string') {
    return { response: c.json({ error: 'Invalid request' }, 400) }
  }
  // Grants are allow-only. Reject unknown `effect` values; only `'allow'`
  // (or omitted) is accepted for the stable client DTO.
  if (effect !== undefined && effect !== 'allow') {
    return { response: c.json({ error: 'Invalid request' }, 400) }
  }
  if (
    typeof permissionKey !== 'string' ||
    permissionKey.length === 0 ||
    !isPermissionKey(permissionKey)
  ) {
    return { response: c.json({ error: 'permissionKey is required' }, 400) }
  }
  if (!isUuid(resourceId) || !isUuid(subjectId)) {
    return { response: c.json({ error: 'Invalid request' }, 400) }
  }

  return { subjectKind, subjectId, resourceId, permissionKey }
}

export function registerAccessRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/invitations/:id/accept', createSessionMiddleware(opts.secrets))

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

    if (
      invitePreview.email.trim().toLowerCase() !==
      session.email.trim().toLowerCase()
    ) {
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
        .insert(membership)
        .values({
          organizationId,
          userId: session.userId,
        })
        .onConflictDoNothing({
          target: [membership.organizationId, membership.userId],
        })

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
      if (result.error === 'invalid_grant') {
        return c.json({ error: 'Invalid invitation grants' }, 400)
      }
      return c.json({ error: 'Invitation expired or already used' }, 410)
    }

    return c.json({ ok: true as const, organizationId: result.organizationId })
  })

  router.use('/permissions', createSessionMiddleware(opts.secrets))
  router.use('/access/check', createSessionMiddleware(opts.secrets))
  router.use('/access/resource-id', createSessionMiddleware(opts.secrets))
  router.use('/access', createSessionMiddleware(opts.secrets))
  router.use('/access/:id', createSessionMiddleware(opts.secrets))

  router.get('/permissions', async (c) => {
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
    if (!resourceId || !permissionKey) {
      return c.json(
        {
          error:
            'resourceId and permissionKey query parameters are required',
        },
        400,
      )
    }

    if (!isUuid(resourceId)) {
      return c.json({ error: 'Invalid resourceId' }, 400)
    }

    if (!PERMISSIONS.includes(permissionKey as PermissionKey)) {
      return c.json({ error: 'Invalid permissionKey' }, 400)
    }

    const entity = await resolveEntityById(db, resourceId)
    if (!entity) {
      return c.json({ error: 'Not found' }, 404)
    }

    const allowed = await can(
      db,
      session.userId,
      permissionKey as PermissionKey,
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
    if (!kind || !itemId) {
      return c.json(
        { error: 'kind and itemId query parameters are required' },
        400,
      )
    }

    if (!isAccessGrantEntityType(kind)) {
      return c.json({ error: 'Not found' }, 404)
    }

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const entity = await resolveEntityByKindAndItemId(db, kind, itemId)
    if (entity?.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (kind === 'organization') {
      if (itemId !== organizationId) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json({
        resourceId: entity.entityId,
        kind,
        itemId,
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
      kind,
      itemId,
    })
  })

  router.get('/access', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const resourceId = c.req.query('resourceId')?.trim()
    if (!resourceId) {
      return c.json({ error: 'resourceId query parameter is required' }, 400)
    }

    if (!isUuid(resourceId)) {
      return c.json({ error: 'Invalid resourceId' }, 400)
    }

    const entity = await resolveEntityById(db, resourceId)
    if (!entity) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (!isAccessGrantEntityType(entity.entityType)) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageAccessOr403(c, db, resourceId)
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
