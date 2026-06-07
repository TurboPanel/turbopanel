import type { Hono } from 'hono'
import {
  awaitDaemonAck,
  type DaemonMessage,
  getColocatedDaemonId,
  sendToDaemon,
} from './daemon-hub.ts'
import { ADMIN_API_PREFIX } from './surfaces.ts'

const TUNNEL_TOKEN_TIMEOUT_MS = 30_000

/**
 * Set the self-hosted instance's Cloudflare tunnel token. The token is pushed
 * to the co-located daemon (which runs cloudflared), exposing this instance so
 * external agent nodes can connect in. An empty token tears the tunnel down.
 */
export function registerTunnelRoutes(app: Hono): Hono {
  app.post(`${ADMIN_API_PREFIX}/instance/tunnel-token`, async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof body.token !== 'string') {
      return c.json({ ok: false, error: 'expected { token: string }' }, 400)
    }

    const daemonId = getColocatedDaemonId()
    if (!daemonId) {
      return c.json(
        { ok: false, error: 'no co-located daemon connected to run the tunnel' },
        503,
      )
    }

    const id = crypto.randomUUID()
    const message: DaemonMessage = {
      type: 'tunnel-token',
      id,
      token: body.token,
      at: new Date().toISOString(),
    }
    const ack = awaitDaemonAck(id, TUNNEL_TOKEN_TIMEOUT_MS)
    if (!sendToDaemon(daemonId, message)) {
      return c.json({ ok: false, error: 'co-located daemon disconnected' }, 503)
    }

    try {
      await ack
      return c.json({ ok: true })
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: errMessage }, 500)
    }
  })

  return app
}
