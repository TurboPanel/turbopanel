import { Hono } from 'hono'
import type { Context } from 'hono'
import { createAdminAccessMiddleware, createRootOnlyMiddleware } from '../client/authn/middleware.ts'
import { resolveColocatedServerId } from '../client/authn/install-state.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import {
  broadcastEchoToFleet,
  collectFleetCommands,
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
import { emptyServerAddresses } from '../server-addresses.ts'
import { buildAdminScalarHtml } from '../scalar-html.ts'
import { ADMIN_API_PREFIX } from '../surfaces.ts'
import { getAdminOpenApiSpec } from './openapi/index.ts'
import {
  getPublicUrls,
  parsePublicUrlEntries,
  setPublicUrls,
} from './public-urls.ts'
import {
  emailSettingsToApiShape,
  resolveEmailSettings,
  updateEmailSettings,
} from '../lib/settings/email-settings.ts'

const COMMAND_TIMEOUT_MS = 30_000
const ADDRESSES_TIMEOUT_MS = 10_000
const PUBLIC_URLS_APPLY_TIMEOUT_MS = 60_000
const MAX_CELL_PURGE_BATCH_SIZE = 200

function nowTs(): string {
  return new Date().toISOString()
}

function resolvePlatformEnv(
  c: Context,
  opts: { getEnv?: () => Record<string, string | undefined> },
): Record<string, string | undefined> {
  const fromContext = c.get('platformEnv')
  if (fromContext) return fromContext
  if (opts.getEnv) return opts.getEnv()
  return {}
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
 * Admin UI surface: fleet diagnostics, public URL management, and (dev-only) shell.
 */
export function registerAdminRoutes(app: Hono, opts: {
  secrets: DerivedSecretsConfig
  runtime: 'deno' | 'workers'
  devSurface: boolean
  getEnv?: () => Record<string, string | undefined>
}) {
  const admin = new Hono()
  admin.use('*', createAdminAccessMiddleware(opts.secrets))

  admin.get('/daemon/connections', async (c) => {
    const registry = getDaemonCellRegistry(c)
    const db = getDb(c)
    if (!registry || !db) return c.json({ connections: [] })
    const connections = (await resolveOnlineFleetPresence(db, registry))
      .map(fleetPresenceToConnection)
    return c.json({ connections })
  })

  admin.get('/daemon/events', async (c) => {
    return c.json({ events: [] })
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

  if (opts.devSurface) {
    admin.post('/daemon/command', createRootOnlyMiddleware(opts.secrets), async (c) => {
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

    admin.post('/daemon/:id/command', createRootOnlyMiddleware(opts.secrets), async (c) => {
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
  }

  admin.get('/instance/addresses', async (c) => {
    if (opts.runtime !== 'deno') {
      return c.json({
        ok: false,
        error: 'instance address collection is not available on this runtime',
        addresses: emptyServerAddresses(),
      }, 422)
    }
    const { collectServerAddresses } = await import('../server-addresses-deno.ts')
    const addresses = collectServerAddresses()
    return c.json({ ok: true, source: 'instance', addresses })
  })

  admin.get('/instance/public-urls', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ ok: true, urls: [] })
    const urls = await getPublicUrls(db)
    return c.json({ ok: true, urls })
  })

  admin.put('/instance/public-urls', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)

    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('urls' in body)) {
      return c.json({ ok: false, error: 'expected { urls: string[] }' }, 400)
    }
    if (!Array.isArray(body.urls) || !body.urls.every((u: unknown) => typeof u === 'string')) {
      return c.json({ ok: false, error: 'expected { urls: string[] }' }, 400)
    }

    const parsed = parsePublicUrlEntries(body.urls)
    if (!parsed.ok) {
      return c.json(parsed, 422)
    }

    await setPublicUrls(db, parsed.urls)
    return c.json({ ok: true, urls: parsed.urls, applied: false })
  })

  admin.get('/settings/email', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const resolved = await resolveEmailSettings(db, resolvePlatformEnv(c, opts))
    return c.json({ settings: emailSettingsToApiShape(resolved) })
  })

  admin.put('/settings/email', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'expected a JSON object of setting keys' }, 400)
    }

    const updates: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === 'string' || value === null) updates[key] = value
    }

    const env = resolvePlatformEnv(c, opts)
    const resolved = await updateEmailSettings(db, env, updates)
    return c.json({ settings: emailSettingsToApiShape(resolved) })
  })

  admin.post('/instance/public-urls/apply', async (c) => {
    if (opts.runtime === 'workers') {
      return c.json(
        { ok: false, error: 'cert apply is not applicable on this runtime' },
        422,
      )
    }

    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)

    const body = await c.req.json().catch(() => null)
    let urls: string[]

    if (body && typeof body === 'object' && 'urls' in body) {
      if (!Array.isArray(body.urls) || !body.urls.every((u: unknown) => typeof u === 'string')) {
        return c.json({ ok: false, error: 'expected { urls?: string[] }' }, 400)
      }
      const parsed = parsePublicUrlEntries(body.urls)
      if (!parsed.ok) {
        return c.json(parsed, 422)
      }
      await setPublicUrls(db, parsed.urls)
      urls = parsed.urls
    } else {
      urls = await getPublicUrls(db)
    }

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    }

    const serverId = await resolveColocatedServerId(db, registry)
    if (!serverId) {
      return c.json(
        { ok: false, error: 'no co-located daemon connected to apply public URLs' },
        503,
      )
    }

    const snapshots = await registry.getSnapshots([serverId])
    if (!snapshots.get(serverId)?.connected) {
      return c.json({ ok: false, error: 'co-located daemon disconnected' }, 503)
    }

    const envelope: DaemonOutboundEnvelope = {
      kind: 'public-urls-update',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: nowTs(),
      urls,
    }

    try {
      const record = await registry.getCell(serverId).createRequestAndWait(
        envelope,
        PUBLIC_URLS_APPLY_TIMEOUT_MS,
      )
      if (record.status === 'done') {
        return c.json({ ok: true, applied: true })
      }
      if (record.status === 'failed') {
        return c.json(
          { ok: false, applied: false, error: record.error ?? 'daemon reported failure' },
          500,
        )
      }
      return c.json(
        { ok: false, applied: false, error: 'timeout waiting for daemon' },
        500,
      )
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, applied: false, error: errMessage }, 500)
    }
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

  admin.post('/cells/purge-batch', createRootOnlyMiddleware(opts.secrets), async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    const body = await c.req.json().catch(() => null)
    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray(body.serverIds) ||
      body.serverIds.length === 0 ||
      !body.serverIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
    ) {
      return c.json({ error: 'expected { serverIds: string[] } with at least one id' }, 400)
    }
    if (body.serverIds.length > MAX_CELL_PURGE_BATCH_SIZE) {
      return c.json(
        { error: `serverIds exceeds maximum batch size of ${MAX_CELL_PURGE_BATCH_SIZE}` },
        400,
      )
    }

    const settled = await Promise.allSettled(
      body.serverIds.map((serverId: string) => registry.purge(serverId)),
    )
    const results = body.serverIds.map((serverId: string, index: number) => {
      const outcome = settled[index]!
      if (outcome.status === 'fulfilled') {
        return { serverId, ok: true as const }
      }
      const error = outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason)
      return { serverId, ok: false as const, error }
    })

    return c.json({ ok: true, results })
  })

  admin.post('/cells/:serverId/purge', createRootOnlyMiddleware(opts.secrets), async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    const serverId = c.req.param('serverId')
    if (!serverId) {
      return c.json({ error: 'serverId is required' }, 400)
    }

    try {
      await registry.getCell(serverId).purge()
      return c.json({ ok: true, serverId, purged: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: message }, 500)
    }
  })

  if (opts.devSurface) {
    admin.get('/openapi.json', (c) => {
      const origin = new URL(c.req.url).origin
      return c.json(getAdminOpenApiSpec(origin, { devSurface: opts.devSurface }))
    })
    admin.get('/reference', (c) => {
      const origin = new URL(c.req.url).origin
      const specUrl = `${ADMIN_API_PREFIX}/openapi.json`
      return c.html(buildAdminScalarHtml(specUrl, origin))
    })
  }

  app.route(ADMIN_API_PREFIX, admin)
  return app
}
