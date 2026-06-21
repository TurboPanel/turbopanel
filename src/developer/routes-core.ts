import { Hono } from 'hono'
import { eq, isNull } from 'drizzle-orm'
import { createRootOnlyMiddleware } from '../authn/middleware.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import type { Db } from '../db.ts'
import { getDb } from '../db.ts'
import { organization, server } from '../db/schema.ts'
import {
  broadcastToDaemons,
  type DaemonMessage,
  dispatchCommand,
  listCommandResults,
  listDaemonConnections,
  listDaemonEvents,
  recordDaemonBroadcast,
  requestDaemonAddresses,
  sendToDaemon,
} from '../daemon/hub.ts'
import { collectServerAddresses } from '../server-addresses.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import { registerDatabaseRoutes } from './database-routes.ts'

/**
 * Developer console routes safe for the Workers bundle (no Deno-only imports).
 * Deno-only routes (Drizzle Studio) live in developer/routes.ts.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function nowTs(): string {
  return new Date().toISOString()
}

/** Build the developer router without mounting — extend before {@link mountDeveloperRouter}. */
export function buildDeveloperRouter(
  opts: { secrets: DerivedSecretsConfig; db?: Db; authRequired?: boolean },
): Hono {
  const developer = new Hono()
  if (opts.authRequired !== false) {
    developer.use('*', createRootOnlyMiddleware(opts.secrets))
  }

  developer.get('/daemon/connections', (c) =>
    c.json({ connections: listDaemonConnections() }))

  developer.get('/daemon/events', (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ events: listDaemonEvents(Number.isFinite(limit) ? limit : 50) })
  })

  developer.post('/daemon/broadcast', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('payload' in body)) {
      return c.json({ error: 'expected { payload: unknown }' }, 400)
    }

    const message: DaemonMessage = {
      type: 'echo',
      payload: body.payload,
      at: new Date().toISOString(),
    }
    const sent = broadcastToDaemons(message)
    recordDaemonBroadcast(sent, body.payload)
    return c.json({ ok: true, sent })
  })

  developer.post('/daemon/:id/send', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('payload' in body)) {
      return c.json({ error: 'expected { payload: unknown }' }, 400)
    }

    const message: DaemonMessage = {
      type: 'echo',
      payload: body.payload,
      at: new Date().toISOString(),
    }
    const sent = sendToDaemon(id, message)
    if (!sent) return c.json({ error: 'daemon not connected' }, 404)
    return c.json({ ok: true, id })
  })

  developer.get('/daemon/commands', (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ commands: listCommandResults(Number.isFinite(limit) ? limit : 50) })
  })

  developer.post('/daemon/command', async (c) => {
    const body = await c.req.json().catch(() => null)
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    if (!command) return c.json({ error: 'expected { command: string }' }, 400)

    const commandIds = listDaemonConnections()
      .map((conn) => dispatchCommand(conn.id, command))
      .filter((id): id is string => id !== null)
    return c.json({ ok: true, sent: commandIds.length, commandIds })
  })

  developer.post('/daemon/:id/command', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    if (!command) return c.json({ error: 'expected { command: string }' }, 400)

    const commandId = dispatchCommand(id, command)
    if (!commandId) return c.json({ error: 'daemon not connected' }, 404)
    return c.json({ ok: true, commandId })
  })

  developer.get('/instance/addresses', (c) => {
    const addresses = collectServerAddresses()
    return c.json({ ok: true, source: 'instance', addresses })
  })

  developer.get('/daemon/addresses', async (c) => {
    const connections = listDaemonConnections()
    const servers = await Promise.all(
      connections.map(async (conn) => {
        try {
          const addresses = await requestDaemonAddresses(conn.id)
          return {
            daemonId: conn.id,
            hostname: conn.hostname ?? null,
            addresses,
          }
        } catch (err) {
          return {
            daemonId: conn.id,
            hostname: conn.hostname ?? null,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )
    return c.json({ servers })
  })

  developer.get('/daemon/:id/addresses', async (c) => {
    const id = c.req.param('id')
    try {
      const addresses = await requestDaemonAddresses(id)
      const conn = listDaemonConnections().find((entry) => entry.id === id)
      return c.json({
        ok: true,
        daemonId: id,
        hostname: conn?.hostname ?? null,
        addresses,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message === 'daemon not connected' ? 404 : 500
      return c.json({ error: message }, status)
    }
  })

  developer.get('/organizations', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const rows = await db
      .select({
        id: organization.id,
        displayName: organization.displayName,
        slug: organization.slug,
      })
      .from(organization)
      .orderBy(organization.displayName)
    return c.json({ organizations: rows })
  })

  developer.get('/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const rows = await db
      .select({
        id: server.id,
        displayName: server.displayName,
        organizationId: server.organizationId,
        options: server.options,
        createdAt: server.createdAt,
      })
      .from(server)
      .where(isNull(server.deletedAt))
      .orderBy(server.createdAt)
    return c.json({ servers: rows })
  })

  developer.post('/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const body = await c.req.json().catch(() => null) as {
      displayName?: string | null
      options?: Record<string, unknown> | null
    } | null

    let displayName: string | null = null
    if (body && body.displayName != null) {
      if (typeof body.displayName !== 'string') {
        return c.json({ error: 'displayName must be a string or null' }, 400)
      }
      const trimmed = body.displayName.trim()
      if (trimmed.length > 255) {
        return c.json({ error: 'displayName must be at most 255 characters' }, 400)
      }
      displayName = trimmed
    }

    const options = body?.options ?? null
    const now = nowTs()
    const inserted = await db
      .insert(server)
      .values({ displayName, options, createdAt: now, updatedAt: now })
      .returning({ id: server.id })

    return c.json({ ok: true, id: inserted[0].id }, 201)
  })

  developer.patch('/servers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null) as {
      displayName?: string | null
      organizationId?: string | null
      options?: Record<string, unknown> | null
    } | null

    const patch: {
      displayName?: string | null
      organizationId?: string | null
      options?: Record<string, unknown> | null
    } = {}
    if (body && 'displayName' in body) {
      if (body.displayName != null) {
        if (typeof body.displayName !== 'string') {
          return c.json({ error: 'displayName must be a string or null' }, 400)
        }
        const trimmed = body.displayName.trim()
        if (trimmed.length > 255) {
          return c.json({ error: 'displayName must be at most 255 characters' }, 400)
        }
        patch.displayName = trimmed
      } else {
        patch.displayName = null
      }
    }
    if (body && 'options' in body) {
      patch.options = body.options ?? null
    }
    if (body && 'organizationId' in body) {
      const organizationId = body.organizationId
      if (organizationId == null) {
        patch.organizationId = null
      } else if (typeof organizationId !== 'string') {
        return c.json({ error: 'organizationId must be a string or null' }, 400)
      } else {
        const trimmed = organizationId.trim()
        if (!UUID_RE.test(trimmed)) {
          return c.json({ error: 'organizationId must be a valid UUID' }, 400)
        }
        const org = await db
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, trimmed))
          .limit(1)
        if (org.length === 0) {
          return c.json({ error: 'Organization not found' }, 404)
        }
        patch.organizationId = trimmed
      }
    }

    const updated = await db
      .update(server)
      .set({ ...patch, updatedAt: nowTs() })
      .where(eq(server.id, id))
      .returning({ id: server.id, organizationId: server.organizationId })

    if (updated.length === 0) return c.json({ error: 'Server not found' }, 404)

    return c.json({ ok: true })
  })

  registerDatabaseRoutes(developer)

  return developer
}

export function mountDeveloperRouter(app: Hono, developer: Hono): Hono {
  app.route(DEVELOPER_API_PREFIX, developer)
  return developer
}

export function registerDeveloperRoutesCore(
  app: Hono,
  opts: { secrets: DerivedSecretsConfig; db?: Db; authRequired?: boolean },
) {
  return mountDeveloperRouter(app, buildDeveloperRouter(opts))
}
