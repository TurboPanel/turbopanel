import { Hono } from 'hono'
import { createRootOnlyMiddleware } from './auth/middleware.ts'
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
} from './daemon-hub.ts'
import { collectServerAddresses } from './server-addresses.ts'
import { registerDatabaseRoutes } from './database-routes.ts'
import { EXPO_UI_SERVICE, expoTmuxStatus } from './expo-pty.ts'
import { DEVELOPER_API_PREFIX } from './surfaces.ts'

/**
 * Developer console surface: fleet management, diagnostics, shell, addresses.
 * Mounted under {@link DEVELOPER_API_PREFIX} (`/api/developer/v1`). Dev-only —
 * the caller (`deno.ts`) registers this surface only when dev mode is enabled.
 */
export function registerDeveloperRoutes(app: Hono, opts: { sessionSecret: string }) {
  const developer = new Hono()
  developer.use('*', createRootOnlyMiddleware(opts.sessionSecret))

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

  registerDatabaseRoutes(developer)

  developer.get('/expo/status', async (c) => {
    const { running } = await expoTmuxStatus()
    return c.json({ running })
  })

  developer.post('/expo/restart', (c) => {
    if (!EXPO_UI_SERVICE) {
      return c.json(
        {
          ok: false,
          error:
            'expo restart unavailable: TURBOPANEL_UI_SERVICE is not set (run under systemd or configure a managed service)',
        },
        503,
      )
    }

    new Deno.Command('sudo', {
      args: ['systemctl', 'restart', EXPO_UI_SERVICE],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).spawn()

    return c.json({ ok: true })
  })

  app.route(DEVELOPER_API_PREFIX, developer)
  return app
}
