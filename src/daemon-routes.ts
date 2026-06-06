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
  sendToDaemon,
  type DaemonMessage,
} from './daemon-hub.ts'

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

  return app
}

export { parseDaemonMessage }
