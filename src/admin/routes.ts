import { Hono } from 'hono'
import { createSessionMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import {
  broadcastEchoToFleet,
  collectFleetCommands,
  collectFleetEvents,
  enqueueEchoToServer,
  listFleetServerIds,
} from '../daemon/cell/fleet-diagnostics.ts'
import {
  fleetPresenceToConnection,
  isServerConnected,
  resolveFleetPresence,
  resolveOnlineFleetPresence,
} from '../daemon/cell/fleet-presence.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import { getDaemonCellRegistry, getDb } from '../db.ts'
import type { ServerAddresses } from '../server-addresses.ts'
import { collectServerAddresses } from '../server-addresses.ts'
import { ADMIN_API_PREFIX } from '../surfaces.ts'

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

/**
 * Admin UI surface: fleet management, diagnostics, shell, addresses.
 * Unmounted until a real, documented admin surface ships.
 */
export function registerAdminRoutes(app: Hono, opts: { secrets: DerivedSecretsConfig }) {
  const admin = new Hono()
  admin.use('*', createSessionMiddleware(opts.secrets))

  admin.get('/daemon/connections', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const db = getDb(c)
    if (!registry || !db) return c.json({ connections: [] })
    const connections = (await resolveOnlineFleetPresence(db, registry))
      .map(fleetPresenceToConnection)
    return c.json({ connections })
  })

  admin.get('/daemon/events', async (c) => {
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

  admin.post('/daemon/broadcast', async (c) => {
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

  admin.post('/daemon/:id/send', async (c) => {
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

  admin.get('/daemon/commands', async (c) => {
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

  admin.post('/daemon/command', async (c) => {
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

  admin.post('/daemon/:id/command', async (c) => {
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

  admin.get('/instance/addresses', (c) => {
    const addresses = collectServerAddresses()
    return c.json({ ok: true, source: 'instance', addresses })
  })

  admin.get('/daemon/addresses', async (c) => {
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

  admin.get('/daemon/:id/addresses', async (c) => {
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

  app.route(ADMIN_API_PREFIX, admin)
  return app
}
