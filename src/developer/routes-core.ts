import { Hono } from 'hono'
import { eq, isNull } from 'drizzle-orm'
import { createRootOnlyMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import type { Db } from '../db.ts'
import { getDb, getDaemonCellRegistry } from '../db.ts'
import {
  fleetPresenceToConnection,
  resolveFleetPresence,
  resolveOnlineFleetPresence,
  isServerConnected,
} from '../daemon/cell/fleet-presence.ts'
import {
  broadcastEchoToFleet,
  collectFleetCommands,
  collectFleetEvents,
  enqueueEchoToServer,
  listFleetServerIds,
} from '../daemon/cell/fleet-diagnostics.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import type { ServerAddresses } from '../server-addresses.ts'
import { organization, server } from '../lib/db/schema.ts'
import { collectServerAddresses } from '../server-addresses.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import { registerDatabaseRoutes } from './database-routes.ts'

/**
 * Developer console routes safe for the Workers bundle (no Deno-only imports).
 * Deno-only routes (Drizzle Studio) live in developer/routes.ts.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const COMMAND_TIMEOUT_MS = 30_000
const ADDRESSES_TIMEOUT_MS = 10_000

function nowTs(): string {
  return new Date().toISOString()
}

function extractAddresses(record: { status: string; result?: unknown }): ServerAddresses {
  if (record.status !== 'done') {
    throw new Error(record.status === 'expired'
      ? 'timeout waiting for addresses'
      : 'failed to fetch addresses')
  }
  const result = record.result as { addresses?: ServerAddresses } | undefined
  if (!result?.addresses) throw new Error('missing addresses in daemon response')
  return result.addresses
}

/** Build the developer router without mounting — extend before {@link mountDeveloperRouter}. */
export function buildDeveloperRouter(
  opts: { secrets: DerivedSecretsConfig; db?: Db; authRequired?: boolean },
): Hono {
  const developer = new Hono()
  if (opts.authRequired !== false) {
    developer.use('*', createRootOnlyMiddleware(opts.secrets))
  }

  developer.get('/daemon/connections', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const db = getDb(c)
    if (!registry || !db) return c.json({ connections: [] })
    const connections = (await resolveOnlineFleetPresence(db, registry))
      .map(fleetPresenceToConnection)
    return c.json({ connections })
  })

  developer.get('/daemon/events', async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ events: [] })
    const db = getDb(c)
    if (!db) return c.json({ events: [] })
    const limit = Number(c.req.query('limit') ?? 50)
    const perServerLimit = Number.isFinite(limit) ? limit : 50
    const serverIds = await listFleetServerIds(db)
    const events = await collectFleetEvents(registry, serverIds, perServerLimit)
    return c.json({ events })
  })

  developer.post('/daemon/broadcast', async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('payload' in body)) {
      return c.json({ error: 'expected { payload: unknown }' }, 400)
    }
    const ids = await registry.listOnlineServerIds()
    const sent = await broadcastEchoToFleet(registry, ids, body.payload)
    return c.json({ ok: true, sent })
  })

  developer.post('/daemon/:id/send', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const db = getDb(c)
    if (!registry || !db) return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('payload' in body)) {
      return c.json({ error: 'expected { payload: unknown }' }, 400)
    }
    if (!await isServerConnected(db, registry, id)) {
      return c.json({ error: 'daemon not connected' }, 404)
    }
    await enqueueEchoToServer(registry, id, body.payload)
    return c.json({ ok: true, id })
  })

  developer.get('/daemon/commands', async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ commands: [] })
    const db = getDb(c)
    if (!db) return c.json({ commands: [] })
    const limit = Number(c.req.query('limit') ?? 50)
    const perServerLimit = Number.isFinite(limit) ? limit : 50
    const serverIds = await listFleetServerIds(db)
    const commands = await collectFleetCommands(registry, serverIds, perServerLimit)
    return c.json({ commands })
  })

  developer.post('/daemon/command', async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    if (!command) return c.json({ error: 'expected { command: string }' }, 400)

    const ids = await registry.listOnlineServerIds()
    const commandIds = (
      await Promise.all(
        ids.map(async (serverId) => {
          const requestId = generateRequestId()
          const envelope: DaemonOutboundEnvelope = {
            kind: 'command',
            deliveryId: generateDeliveryId(),
            requestId,
            at: nowTs(),
            command,
          }
          try {
            await registry.getCell(serverId).createRequestAndWait(
              envelope,
              COMMAND_TIMEOUT_MS,
            )
            return requestId
          } catch {
            return null
          }
        }),
      )
    ).filter((id): id is string => id !== null)
    return c.json({ ok: true, sent: commandIds.length, commandIds })
  })

  developer.post('/daemon/:id/command', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const db = getDb(c)
    if (!registry || !db) return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    if (!command) return c.json({ error: 'expected { command: string }' }, 400)

    if (!await isServerConnected(db, registry, id)) {
      return c.json({ error: 'daemon not connected' }, 404)
    }

    const requestId = generateRequestId()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'command',
      deliveryId: generateDeliveryId(),
      requestId,
      at: nowTs(),
      command,
    }
    await registry.getCell(id).createRequestAndWait(envelope, COMMAND_TIMEOUT_MS)
    return c.json({ ok: true, commandId: requestId })
  })

  developer.get('/instance/addresses', (c) => {
    const addresses = collectServerAddresses()
    return c.json({ ok: true, source: 'instance', addresses })
  })

  developer.get('/daemon/addresses', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const db = getDb(c)
    if (!registry || !db) return c.json({ servers: [] })
    const online = await resolveOnlineFleetPresence(db, registry)
    const servers = await Promise.all(
      online.map(async (presence) => {
        const serverId = presence.serverId
        const envelope: DaemonOutboundEnvelope = {
          kind: 'addresses-request',
          deliveryId: generateDeliveryId(),
          requestId: generateRequestId(),
          at: nowTs(),
        }
        try {
          const record = await registry.getCell(serverId).createRequestAndWait(
            envelope,
            ADDRESSES_TIMEOUT_MS,
          )
          const addresses = extractAddresses(record)
          return {
            daemonId: serverId,
            hostname: presence.hostname,
            addresses,
          }
        } catch (err) {
          return {
            daemonId: serverId,
            hostname: presence.hostname,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )
    return c.json({ servers })
  })

  developer.get('/daemon/:id/addresses', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const db = getDb(c)
    if (!registry || !db) return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    const id = c.req.param('id')
    const presence = await resolveFleetPresence(db, registry, [id])
    const live = presence.get(id)
    if (!live?.connected) {
      return c.json({ error: 'daemon not connected' }, 404)
    }
    try {
      const envelope: DaemonOutboundEnvelope = {
        kind: 'addresses-request',
        deliveryId: generateDeliveryId(),
        requestId: generateRequestId(),
        at: nowTs(),
      }
      const record = await registry.getCell(id).createRequestAndWait(
        envelope,
        ADDRESSES_TIMEOUT_MS,
      )
      const addresses = extractAddresses(record)
      return c.json({
        ok: true,
        daemonId: id,
        hostname: live.hostname ?? null,
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
