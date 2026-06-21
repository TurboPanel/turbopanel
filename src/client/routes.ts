import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { registerAuthRoutes, type AuthRouteOpts } from './auth/http.ts'
import {
  materializeInvitationGrants,
  resolveInvitationGrants,
} from './auth/invitation-grants.ts'
import { createLicense, listLicenses, revokeLicense } from './auth/license.ts'
import { createSessionMiddleware } from './auth/middleware.ts'
import { compatLogError, compatLogInfo } from './log-compat.ts'
import { updateSessionOrganization } from './auth/session-store.ts'
import { getAccessManagementPermission } from './authz/access-management.ts'
import { createAccessGrant } from './authz/create-access-grant.ts'
import {
  assertCanOr403,
  can,
  getResourceByItem,
  getResourceId,
  listVisible,
} from './authz/index.ts'
import {
  getAccessProfileCatalog,
  getPermissionCatalog,
  PERMISSIONS,
  type PermissionKey,
} from './authz/catalog.ts'
import { listDaemonConnections } from './daemon-hub.ts'
import type { Db } from './db.ts'
import { getDb } from './db.ts'
import {
  access,
  invitation,
  member,
  resource,
  server,
  teammate,
} from './db/schema.ts'
import { CLIENT_API_PREFIX } from './surfaces.ts'
import { registerResourceRoutes } from './resource-routes.ts'

async function assertBillingOrOrgMember(
  c: Context,
  db: Db,
  organizationId: string,
): Promise<Response | null> {
  const orgResourceId = await getResourceId(db, 'organization', organizationId)
  if (!orgResourceId) {
    compatLogError('authz', `org resource not registered for ${organizationId} — run catalog sync to repair`)
    return c.json({ error: 'Organization authorization not configured' }, 500)
  }
  return assertCanOr403(c, 'organization:billing', orgResourceId)
}

async function assertCanManageAccessOr403(
  c: Context,
  db: Db,
  resourceId: string,
): Promise<Response | null> {
  const resourceRows = await db
    .select({ kind: resource.kind })
    .from(resource)
    .where(eq(resource.id, resourceId))
    .limit(1)

  const resourceRow = resourceRows[0]
  if (!resourceRow) {
    return c.json({ error: 'Not found' }, 404)
  }

  return assertCanOr403(
    c,
    getAccessManagementPermission(resourceRow.kind),
    resourceId,
  )
}

/**
 * Client (end-user UI) surface. Auth routes plus org-scoped resources for the
 * signed-in user (e.g. servers assigned to their organization).
 * Mounted under {@link CLIENT_API_PREFIX} (`/api/client/v1`).
 */
export function registerClientRoutes(app: Hono, opts: AuthRouteOpts) {
  const client = new Hono()

  registerAuthRoutes(client, opts)

  client.get('/status', (c) => c.json({ ok: true, surface: 'client' }))

  client.use('/servers', createSessionMiddleware(opts.secrets))

  client.get('/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const { organizationId } = session
    if (!organizationId) {
      return c.json({ servers: [] })
    }

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ servers: [] })
    }

    const rows = await db
      .select({
        id: server.id,
        displayName: server.displayName,
        organizationId: server.organizationId,
        options: server.options,
        createdAt: server.createdAt,
      })
      .from(server)
      .where(and(inArray(server.id, visibleIds), isNull(server.deletedAt)))
      .orderBy(server.createdAt)

    const connectionsByServerId = new Map(
      listDaemonConnections()
        .filter((conn) => conn.serverId)
        .map((conn) => [conn.serverId!, conn]),
    )

    return c.json({
      servers: rows.map((row) => {
        const conn = connectionsByServerId.get(row.id)
        return {
          ...row,
          connected: conn != null,
          hostname: conn?.hostname ?? null,
          remoteAddress: conn?.remoteAddress ?? null,
        }
      }),
    })
  })

  client.use('/invitations/:id/accept', createSessionMiddleware(opts.secrets))

  client.post('/invitations/:id/accept', async (c) => {
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
      | { error: 'gone' }
      | { error: 'resource' }

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
        await materializeInvitationGrants(tx, session.userId, grants)
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('RESOURCE_NOT_REGISTERED')) {
          return { error: 'resource' as const }
        }
        throw err
      }

      return { ok: true as const, organizationId: invite.organizationId }
    })

    if ('error' in result) {
      if (result.error === 'gone') {
        return c.json({ error: 'Invitation expired or already used' }, 410)
      }
      return c.json({ error: 'Organization resource not registered' }, 500)
    }

    await updateSessionOrganization(
      db,
      session.sessionId,
      result.organizationId,
    )

    return c.json({ ok: true as const, organizationId: result.organizationId })
  })

  client.use('/access-profiles', createSessionMiddleware(opts.secrets))
  client.use('/permissions', createSessionMiddleware(opts.secrets))
  client.use('/access/check', createSessionMiddleware(opts.secrets))
  client.use('/access/resource-id', createSessionMiddleware(opts.secrets))
  client.use('/access', createSessionMiddleware(opts.secrets))
  client.use('/access/:id', createSessionMiddleware(opts.secrets))

  client.get('/access-profiles', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const accessProfiles = getAccessProfileCatalog()
    return c.json({ accessProfiles })
  })

  client.get('/permissions', async (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const permissions = getPermissionCatalog()
    return c.json({ permissions })
  })

  client.get('/access/check', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const resourceId = c.req.query('resourceId')?.trim()
    const permissionKey = c.req.query('permissionKey')?.trim()
    if (!resourceId || !permissionKey) {
      return c.json(
        { error: 'resourceId and permissionKey query parameters are required' },
        400,
      )
    }

    if (!PERMISSIONS.includes(permissionKey as PermissionKey)) {
      return c.json({ error: 'Invalid permissionKey' }, 400)
    }

    const resourceRows = await db
      .select({ id: resource.id })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1)

    if (!resourceRows[0]) {
      return c.json({ error: 'Not found' }, 404)
    }

    const allowed = await can(
      db,
      session.userId,
      permissionKey as PermissionKey,
      resourceId,
    )

    return c.json({ allowed })
  })

  client.get('/access/resource-id', async (c) => {
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

    const resourceRow = await getResourceByItem(db, kind, itemId)
    if (!resourceRow || resourceRow.organizationId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (kind === 'organization') {
      if (itemId !== organizationId) {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json({
        resourceId: resourceRow.id,
        kind,
        itemId,
      })
    }

    const roKey = `${kind}:ro` as PermissionKey
    const rwKey = `${kind}:rw` as PermissionKey
    const visible =
      PERMISSIONS.includes(roKey) &&
      PERMISSIONS.includes(rwKey) &&
      ((await can(db, session.userId, roKey, resourceRow.id)) ||
        (await can(db, session.userId, rwKey, resourceRow.id)))

    if (!visible) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return c.json({
      resourceId: resourceRow.id,
      kind,
      itemId,
    })
  })

  client.get('/access', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const resourceId = c.req.query('resourceId')?.trim()
    if (!resourceId) {
      return c.json({ error: 'resourceId query parameter is required' }, 400)
    }

    const denied = await assertCanManageAccessOr403(c, db, resourceId)
    if (denied) return denied

    const rows = await db
      .select({
        id: access.id,
        subjectKind: access.subjectKind,
        subjectId: access.subjectId,
        resourceId: access.resourceId,
        effect: access.effect,
        accessProfileKey: access.accessProfileKey,
        permissionKey: access.permissionKey,
      })
      .from(access)
      .where(eq(access.resourceId, resourceId))
      .orderBy(access.createdAt)

    return c.json({ access: rows })
  })

  client.post('/access', async (c) => {
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

    const denied = await assertCanManageAccessOr403(c, db, resourceId)
    if (denied) return denied

    const result = await createAccessGrant(db, {
      subjectKind,
      subjectId,
      resourceId,
      effect,
      accessProfileKey: providedAccessProfileKey ? accessProfileKey : undefined,
      permissionKey: providedPermissionKey ? permissionKey : undefined,
    })

    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }

    return c.json({
      ok: true as const,
      id: result.id,
      created: result.created,
    })
  })

  client.delete('/access/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const accessId = c.req.param('id')
    const accessRows = await db
      .select({ resourceId: access.resourceId })
      .from(access)
      .where(eq(access.id, accessId))
      .limit(1)

    const accessRow = accessRows[0]
    if (!accessRow) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageAccessOr403(c, db, accessRow.resourceId)
    if (denied) return denied

    await db.delete(access).where(eq(access.id, accessId))

    return c.json({ ok: true as const })
  })

  client.use('/licenses', createSessionMiddleware(opts.secrets))
  client.use('/licenses/:id', createSessionMiddleware(opts.secrets))

  client.get('/licenses', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const { organizationId } = session
    if (!organizationId) {
      return c.json({ licenses: [] })
    }

    const denied = await assertBillingOrOrgMember(c, db, organizationId)
    if (denied) return denied

    const licenses = await listLicenses(db, organizationId)
    return c.json({
      licenses: licenses.map(({ id, displayName, createdAt }) => ({
        id,
        displayName,
        createdAt,
      })),
    })
  })

  client.post('/licenses', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    let displayName: string | undefined
    const rawBody = await c.req.text().catch(() => '')
    if (rawBody.trim()) {
      let body: unknown
      try {
        body = JSON.parse(rawBody)
      } catch {
        return c.json({ error: 'Invalid request' }, 400)
      }

      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const record = body as Record<string, unknown>
        if (record.displayName !== undefined) {
          if (typeof record.displayName !== 'string') {
            return c.json({ error: 'Invalid request' }, 400)
          }
          displayName = record.displayName
        }
      } else {
        return c.json({ error: 'Invalid request' }, 400)
      }
    }

    const { organizationId } = session
    if (!organizationId) {
      return c.json({ error: 'No organization' }, 400)
    }

    const denied = await assertBillingOrOrgMember(c, db, organizationId)
    if (denied) return denied

    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      displayName,
    })

    const origin = new URL(c.req.url).origin
    const hostFlag = origin !== 'https://turbopanel.app' ? ` --host ${origin}` : ''
    const installCommand =
      `curl -fsSL ${origin}/api/install/v1/daemon-install.sh | sh -s -- --license ${licenseId}:${licenseToken}${hostFlag}`

    compatLogInfo('auth', 'license created; licenseToken is shown once and not stored in plaintext')

    return c.json({ licenseId, licenseToken, installCommand })
  })

  client.delete('/licenses/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const { organizationId } = session
    if (!organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertBillingOrOrgMember(c, db, organizationId)
    if (denied) return denied

    const id = c.req.param('id')
    const revoked = await revokeLicense(db, id, organizationId)
    if (!revoked) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json({ ok: true as const })
  })

  app.route(CLIENT_API_PREFIX, client)
  registerResourceRoutes(app, opts)
  return app
}
