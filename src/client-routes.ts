import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { registerAuthRoutes, type AuthRouteOpts } from './auth/http.ts'
import { getUserOrganizationId } from './auth/install-state.ts'
import { createLicense, listLicenses, revokeLicense } from './auth/license.ts'
import { createSessionMiddleware } from './auth/middleware.ts'
import { listDaemonConnections } from './daemon-hub.ts'
import { getDb } from './db.ts'
import { server } from './db/schema.ts'
import { CLIENT_API_PREFIX } from './surfaces.ts'

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

    const organizationId = await getUserOrganizationId(db, session.userId)
    if (!organizationId) {
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
      .where(and(eq(server.organizationId, organizationId), isNull(server.deletedAt)))
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

    const { licenseId, licenseToken } = await createLicense(db, {
      organizationId,
      displayName,
    })

    const origin = new URL(c.req.url).origin
    const hostFlag = origin !== 'https://turbopanel.app' ? ` --host ${origin}` : ''
    const installCommand =
      `curl -fsSL ${origin}/api/install/v1/daemon-install.sh | sh -s -- --license ${licenseId}:${licenseToken}${hostFlag}`

    console.log('[auth] license created; licenseToken is shown once and not stored in plaintext')

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

    const id = c.req.param('id')
    const revoked = await revokeLicense(db, id, organizationId)
    if (!revoked) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json({ ok: true as const })
  })

  app.route(CLIENT_API_PREFIX, client)
  return app
}
