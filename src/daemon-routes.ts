import { Hono } from 'hono'
import {
  broadcastToDaemons,
  dispatchCommand,
  listCommandResults,
  listDaemonConnections,
  listDaemonEvents,
  parseDaemonMessage,
  recordDaemonBroadcast,
  recordDaemonMessage,
  requestDaemonAddresses,
  sendToDaemon,
  type DaemonMessage,
} from './daemon-hub.ts'
import { collectServerAddresses } from './server-addresses.ts'
import { resolveInstanceTlsCaPath } from './server-paths.ts'

export function registerDaemonRoutes(app: Hono) {
  app.get('/api/daemon/connections', (c) =>
    c.json({ connections: listDaemonConnections() }))

  app.get('/api/daemon/events', (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ events: listDaemonEvents(Number.isFinite(limit) ? limit : 50) })
  })

  app.post('/api/daemon/broadcast', async (c) => {
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

  app.post('/api/daemon/:id/send', async (c) => {
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

  app.get('/api/daemon/commands', (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({ commands: listCommandResults(Number.isFinite(limit) ? limit : 50) })
  })

  app.post('/api/daemon/command', async (c) => {
    const body = await c.req.json().catch(() => null)
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    if (!command) return c.json({ error: 'expected { command: string }' }, 400)

    const commandIds = listDaemonConnections()
      .map((conn) => dispatchCommand(conn.id, command))
      .filter((id): id is string => id !== null)
    return c.json({ ok: true, sent: commandIds.length, commandIds })
  })

  app.post('/api/daemon/:id/command', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    const command = typeof body?.command === 'string' ? body.command.trim() : ''
    if (!command) return c.json({ error: 'expected { command: string }' }, 400)

    const commandId = dispatchCommand(id, command)
    if (!commandId) return c.json({ error: 'daemon not connected' }, 404)
    return c.json({ ok: true, commandId })
  })

  app.get('/api/instance/addresses', (c) => {
    const addresses = collectServerAddresses()
    return c.json({ ok: true, source: 'instance', addresses })
  })

  app.get('/api/instance/ca', async (c) => {
    try {
      const cert = await Deno.readTextFile(resolveInstanceTlsCaPath())
      return c.body(cert, 200, { 'content-type': 'application/x-pem-file' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }
  })

  app.get('/api/daemon/addresses', async (c) => {
    const connections = listDaemonConnections()
    const servers = await Promise.all(
      connections.map(async (conn) => {
        try {
          const addresses = await requestDaemonAddresses(conn.id)
          return { daemonId: conn.id, addresses }
        } catch (err) {
          return {
            daemonId: conn.id,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )
    return c.json({ servers })
  })

  app.get('/api/daemon/:id/addresses', async (c) => {
    const id = c.req.param('id')
    try {
      const addresses = await requestDaemonAddresses(id)
      return c.json({ ok: true, daemonId: id, addresses })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message === 'daemon not connected' ? 404 : 500
      return c.json({ error: message }, status)
    }
  })

  return app
}

export { parseDaemonMessage }
