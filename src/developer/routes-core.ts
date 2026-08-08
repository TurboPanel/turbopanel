import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
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
  collectFleetCellDiagnostics,
  collectFleetCommands,
  enqueueEchoToServer,
  listFleetServerIds,
} from '../daemon/cell/fleet-diagnostics.ts'
import {
  fetchDaemonCellDiagnostics,
  fetchDaemonServerCell,
} from '../daemon/cell/server-diagnostics.ts'
import { isDaemonDebugEnabled, cellTrace } from '../logger.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import type { ServerAddresses } from '../server-addresses.ts'
import { organization, server } from '../lib/db/schema.ts'
import { collectServerAddresses } from '../server-addresses-deno.ts'
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

type ParsedDisplayName =
  | { ok: true; value: string | null }
  | { ok: false; error: string }

function parseDisplayNameInput(displayName: unknown): ParsedDisplayName {
  if (displayName === null) return { ok: true, value: null }
  if (typeof displayName !== 'string') {
    return { ok: false, error: 'displayName must be a string or null' }
  }
  const trimmed = displayName.trim()
  if (trimmed.length > 255) {
    return { ok: false, error: 'displayName must be at most 255 characters' }
  }
  return { ok: true, value: trimmed }
}

type ParsedOrganizationId =
  | { ok: true; value: string | null }
  | { ok: false; error: string; status: number }

async function parseOrganizationIdInput(
  db: Db,
  organizationId: unknown,
): Promise<ParsedOrganizationId> {
  if (organizationId === null) return { ok: true, value: null }
  if (typeof organizationId === 'string') {
    const trimmed = organizationId.trim()
    if (!UUID_RE.test(trimmed)) {
      return { ok: false, error: 'organizationId must be a valid UUID', status: 400 }
    }
    const org = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, trimmed))
      .limit(1)
    if (org.length === 0) {
      return { ok: false, error: 'Organization not found', status: 404 }
    }
    return { ok: true, value: trimmed }
  }
  return { ok: false, error: 'organizationId must be a string or null', status: 400 }
}

/** Build the developer router without mounting — extend before {@link mountDeveloperRouter}. */
export function buildDeveloperRouter(
  opts: { secrets: DerivedSecretsConfig; db?: Db; authRequired?: boolean },
): Hono {
  const developer = new Hono()
  if (opts.authRequired !== false) {
    developer.use('*', createDeveloperAccessMiddleware(opts.secrets))
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
    return c.json({ events: [] })
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

  developer.get('/daemon/:id/cell', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const id = c.req.param('id')

    const result = await fetchDaemonServerCell(db, registry, id)
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }
    return c.json(result)
  })

  developer.get('/daemon/:id/cell/diagnostics', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const debugEnabled = isDaemonDebugEnabled(
      c.env as { TURBOPANEL_DAEMON_DEBUG?: string },
    )
    const id = c.req.param('id')

    const result = await fetchDaemonCellDiagnostics(registry, id, {
      debugEnabled,
    })
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }
    return c.json(result)
  })

  developer.get('/daemon/diagnostics', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const db = getDb(c)
    const debugEnabled = isDaemonDebugEnabled(
      c.env as { TURBOPANEL_DAEMON_DEBUG?: string },
    )
    if (!debugEnabled) {
      return c.json({ error: 'daemon debug disabled' }, 404)
    }
    if (!registry || !db) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }

    const serverIds = await listFleetServerIds(db)
    const diagnostics = await collectFleetCellDiagnostics(
      registry,
      serverIds,
      { debugEnabled },
    )
    return c.json({ ok: true, diagnostics })
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
        const requestId = generateRequestId()
        cellTrace('request-start', {
          requestId,
          serverId,
          kind: 'addresses-request',
        })
        const envelope: DaemonOutboundEnvelope = {
          kind: 'addresses-request',
          deliveryId: generateDeliveryId(),
          requestId,
          at: nowTs(),
        }
        cellTrace('request-enqueued', {
          requestId,
          serverId,
          kind: 'addresses-request',
          deliveryId: envelope.deliveryId,
        })
        try {
          const record = await registry.getCell(serverId).createRequestAndWait(
            envelope,
            ADDRESSES_TIMEOUT_MS,
          )
          if (record.status === 'failed') {
            const error = record.error ?? 'failed to fetch addresses'
            cellTrace('request-result', {
              requestId,
              serverId,
              kind: 'addresses-request',
              pendingStatus: record.status,
              resultStatus: 'failed',
              error,
            })
            return {
              daemonId: serverId,
              hostname: presence.hostname,
              error,
            }
          }
          if (record.status === 'expired') {
            const error = 'timeout waiting for addresses'
            cellTrace('request-result', {
              requestId,
              serverId,
              kind: 'addresses-request',
              pendingStatus: record.status,
              resultStatus: 'timeout',
              error,
            })
            return {
              daemonId: serverId,
              hostname: presence.hostname,
              error,
            }
          }
          const addresses = extractAddresses(record)
          cellTrace('request-result', {
            requestId,
            serverId,
            kind: 'addresses-request',
            pendingStatus: record.status,
            resultStatus: 'done',
          })
          return {
            daemonId: serverId,
            hostname: presence.hostname,
            addresses,
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          cellTrace('request-result', {
            requestId,
            serverId,
            kind: 'addresses-request',
            resultStatus: 'error',
            error,
          })
          return {
            daemonId: serverId,
            hostname: presence.hostname,
            error,
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
    const requestId = generateRequestId()
    cellTrace('request-start', {
      requestId,
      serverId: id,
      kind: 'addresses-request',
    })
    try {
      const envelope: DaemonOutboundEnvelope = {
        kind: 'addresses-request',
        deliveryId: generateDeliveryId(),
        requestId,
        at: nowTs(),
      }
      cellTrace('request-enqueued', {
        requestId,
        serverId: id,
        kind: 'addresses-request',
        deliveryId: envelope.deliveryId,
      })
      const record = await registry.getCell(id).createRequestAndWait(
        envelope,
        ADDRESSES_TIMEOUT_MS,
      )
      if (record.status === 'failed') {
        const error = record.error ?? 'failed to fetch addresses'
        cellTrace('request-result', {
          requestId,
          serverId: id,
          kind: 'addresses-request',
          pendingStatus: record.status,
          resultStatus: 'failed',
          error,
        })
        return c.json({ error }, 500)
      }
      if (record.status === 'expired') {
        const error = 'timeout waiting for addresses'
        cellTrace('request-result', {
          requestId,
          serverId: id,
          kind: 'addresses-request',
          pendingStatus: record.status,
          resultStatus: 'timeout',
          error,
        })
        return c.json({ error }, 500)
      }
      const addresses = extractAddresses(record)
      cellTrace('request-result', {
        requestId,
        serverId: id,
        kind: 'addresses-request',
        pendingStatus: record.status,
        resultStatus: 'done',
      })
      return c.json({
        ok: true,
        daemonId: id,
        hostname: live.hostname ?? null,
        addresses,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cellTrace('request-result', {
        requestId,
        serverId: id,
        kind: 'addresses-request',
        resultStatus: 'error',
        error: message,
      })
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
        displayName: organization.name,
        slug: organization.slug,
      })
      .from(organization)
      .orderBy(organization.name)
    return c.json({ organizations: rows })
  })

  developer.get('/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const rows = await db
      .select({
        id: server.id,
        displayName: server.name,
        organizationId: server.organizationId,
        options: server.options,
        createdAt: server.createdAt,
      })
      .from(server)
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
    if (body?.displayName != null) {
      const parsed = parseDisplayNameInput(body.displayName)
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      displayName = parsed.value
    }

    const options = body?.options ?? null
    const now = nowTs()
    const inserted = await db
      .insert(server)
      .values({ name: displayName, options, createdAt: now, updatedAt: now })
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
      name?: string | null
      organizationId?: string | null
      options?: Record<string, unknown> | null
    } = {}
    if (body && 'displayName' in body) {
      const parsed = parseDisplayNameInput(body.displayName)
      if (!parsed.ok) return c.json({ error: parsed.error }, 400)
      patch.name = parsed.value
    }
    if (body && 'options' in body) {
      patch.options = body.options ?? null
    }
    if (body && 'organizationId' in body) {
      const parsed = await parseOrganizationIdInput(db, body.organizationId)
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
      patch.organizationId = parsed.value
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
