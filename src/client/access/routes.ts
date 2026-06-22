import { and, eq, gt } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  InvitationGrantValidationError,
  materializeInvitationGrants,
  resolveInvitationGrants,
} from '../authn/invitation-grants.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { updateSessionOrganization } from '../authn/session-store.ts'
import { getAccessManagementPermission } from '../authz/access-management.ts'
import {
  collapseAtomicGrants,
  mapEffectToAllowed,
  revokeLegacyAccessGrant,
} from '../authz/access-api-compat.ts'
import { createAccessGrant } from '../authz/create-access-grant.ts'
import {
  resolveEntityById,
  resolveEntityByKindAndItemId,
} from '../authz/entity-resolver.ts'
import { assertCanOr403, can } from '../authz/index.ts'
import {
  getAccessProfileCatalog,
  getPermissionCatalog,
  PERMISSIONS,
  type PermissionKey,
} from '../authz/catalog.ts'
import type { Db } from '../../db.ts'
import { getDb } from '../../db.ts'
import { grant, invitation, member, teammate } from '../../lib/db/schema.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

async function assertCanManageAccessOr403(
  c: Context,
  db: Db,
  resourceId: string,
): Promise<Response | null> {
  const entity = await resolveEntityById(db, resourceId)
  if (!entity) {
    return c.json({ error: 'Not found' }, 404)
  }

  return assertCanOr403(
    c,
    getAccessManagementPermission(entity.entityType),
    entity.entityType,
    entity.entityId,
  )
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

      await tx
        .insert(member)
        .values({
          organizationId: invite.organizationId,
          userId: session.userId,
        })
        .onConflictDoNothing({
          target: [member.organizationId, member.userId],
        })

      if (invite.teamId) {
        await tx
          .insert(teammate)
          .values({
            teamId: invite.teamId,
            userId: session.userId,
          })
          .onConflictDoNothing({
            target: [teammate.teamId, teammate.userId],
          })
      }

      const grants = resolveInvitationGrants(
        invite.grants,
        invite.organizationId,
      )

      try {
        await materializeInvitationGrants(
          tx,
          session.userId,
          grants,
          invite.organizationId,
        )
      } catch (err) {
        if (err instanceof InvitationGrantValidationError) {
          return { error: 'invalid_grant' as const }
        }
        throw err
      }

      return { ok: true as const, organizationId: invite.organizationId }
    })

    if ('error' in result) {
      if (result.error === 'invalid_grant') {
        return c.json({ error: 'Invalid invitation grants' }, 400)
      }
      return c.json({ error: 'Invitation expired or already used' }, 410)
    }

    await updateSessionOrganization(
      db,
      session.sessionId,
      result.organizationId,
    )

    return c.json({ ok: true as const, organizationId: result.organizationId })
  })

  router.use('/access-profiles', createSessionMiddleware(opts.secrets))
  router.use('/permissions', createSessionMiddleware(opts.secrets))
  router.use('/access/check', createSessionMiddleware(opts.secrets))
  router.use('/access/resource-id', createSessionMiddleware(opts.secrets))
  router.use('/access', createSessionMiddleware(opts.secrets))
  router.use('/access/:id', createSessionMiddleware(opts.secrets))

  router.get('/access-profiles', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const accessProfiles = getAccessProfileCatalog()
    return c.json({ accessProfiles })
  })

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

    const { organizationId } = session
    if (!organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const entity = await resolveEntityByKindAndItemId(db, kind, itemId)
    if (!entity || entity.organizationId !== organizationId) {
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

    const roKey = `${kind}:ro` as PermissionKey
    const rwKey = `${kind}:rw` as PermissionKey
    const visible =
      PERMISSIONS.includes(roKey) &&
      PERMISSIONS.includes(rwKey) &&
      ((await can(db, session.userId, roKey, entity.entityType, entity.entityId)) ||
        (await can(db, session.userId, rwKey, entity.entityType, entity.entityId)))

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

    const denied = await assertCanManageAccessOr403(c, db, resourceId)
    if (denied) return denied

    const rows = await db
      .select({
        id: grant.id,
        entityType: grant.entityType,
        entityId: grant.entityId,
        subjectType: grant.subjectType,
        subjectId: grant.subjectId,
        permission: grant.permission,
        allowed: grant.allowed,
      })
      .from(grant)
      .where(
        and(
          eq(grant.entityType, entity.entityType),
          eq(grant.entityId, entity.entityId),
        ),
      )
      .orderBy(grant.createdAt)

    return c.json({ access: collapseAtomicGrants(rows) })
  })

  router.post('/access', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const record = body as Record<string, unknown>
    const subjectKind = record.subjectKind
    const subjectId = record.subjectId
    const resourceId = record.resourceId
    const effect = record.effect
    const accessProfileKey = record.accessProfileKey
    const permissionKey = record.permissionKey

    if (
      subjectKind !== 'user' &&
      subjectKind !== 'team' &&
      subjectKind !== 'organization'
    ) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    if (typeof subjectId !== 'string' || typeof resourceId !== 'string') {
      return c.json({ error: 'Invalid request' }, 400)
    }
    if (effect !== 'allow' && effect !== 'deny') {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const providedAccessProfileKey =
      typeof accessProfileKey === 'string' && accessProfileKey.length > 0
    const providedPermissionKey =
      typeof permissionKey === 'string' && permissionKey.length > 0
    if (providedAccessProfileKey === providedPermissionKey) {
      return c.json(
        { error: 'Exactly one of accessProfileKey or permissionKey is required' },
        400,
      )
    }

    if (!isUuid(resourceId) || !isUuid(subjectId)) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const entity = await resolveEntityById(db, resourceId)
    if (!entity) {
      return c.json({ error: 'Entity not found' }, 404)
    }

    const denied = await assertCanManageAccessOr403(c, db, resourceId)
    if (denied) return denied

    const result = await createAccessGrant(db, {
      entityType: entity.entityType,
      entityId: entity.entityId,
      subjectType: subjectKind,
      subjectId,
      allowed: mapEffectToAllowed(effect),
      accessProfileKey: providedAccessProfileKey ? accessProfileKey : undefined,
      permissionKey: providedPermissionKey ? permissionKey : undefined,
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

    const revoked = await revokeLegacyAccessGrant(db, accessId)
    if (!revoked) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json({ ok: true as const })
  })
}
