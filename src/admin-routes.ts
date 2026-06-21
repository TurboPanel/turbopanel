import { Hono } from 'hono'
import { createSessionMiddleware } from './authn/middleware.ts'
import type { DerivedSecretsConfig } from './authn/secrets.ts'
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
} from './daemon/hub.ts'
import { collectServerAddresses } from './server-addresses.ts'
/** Reserved for a future admin UI surface — not mounted from `createApp()` yet. */
const ADMIN_API_PREFIX = '/api/admin/v1'

/**
 * Admin UI surface: fleet management, diagnostics, shell, addresses.
 * Unmounted until a real, documented admin surface ships.
 */
export function registerAdminRoutes(app: Hono, opts: { secrets: DerivedSecretsConfig }) {
  const admin = new Hono()
  admin.use('*', createSessionMiddleware(opts.secrets))

  admin.get('/daemon/connections', (c) =>
    c.json({ connections: listDaemonConnections() }))

  admin.get('/daemon/events', (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ events: listDaemonEvents(Number.isFinite(limit) ? limit : 50) })
  })

  admin.post('/daemon/broadcast', async (c) => {
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

  admin.post('/daemon/:id/send', async (c) => {
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

  admin.get('/daemon/commands', (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ commands: listCommandResults(Number.isFinite(limit) ? limit : 50) })
  })

  admin.post('/daemon/command', async (c) => {
    const body = await c.req.json().catch(() => null)
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    if (!command) return c.json({ error: 'expected { command: string }' }, 400)

    const commandIds = listDaemonConnections()
      .map((conn) => dispatchCommand(conn.id, command))
      .filter((id): id is string => id !== null)
    return c.json({ ok: true, sent: commandIds.length, commandIds })
  })

  admin.post('/daemon/:id/command', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    if (!command) return c.json({ error: 'expected { command: string }' }, 400)

    const commandId = dispatchCommand(id, command)
    if (!commandId) return c.json({ error: 'daemon not connected' }, 404)
    return c.json({ ok: true, commandId })
  })

  admin.get('/instance/addresses', (c) => {
    const addresses = collectServerAddresses()
    return c.json({ ok: true, source: 'instance', addresses })
  })

  admin.get('/daemon/addresses', async (c) => {
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

  admin.get('/daemon/:id/addresses', async (c) => {
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

  app.route(ADMIN_API_PREFIX, admin)
  return app
}
