import type { Env, Hono } from 'hono'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { getDb, getDaemonCellRegistry } from '../db/connection.ts'
import { DEVELOPER_API_PREFIX } from '../app/surfaces.ts'
import {
  dispatchInstanceTunnelToken,
  parseTunnelTokenBody,
} from './tunnel-token.ts'

export { parseTunnelTokenBody }

/**
 * Set the self-hosted instance's Cloudflare tunnel token. The token is pushed
 * to the co-located daemon (which runs cloudflared), exposing this instance so
 * external remote daemons can connect in. An empty token tears the tunnel down.
 */
export function registerTunnelRoutes<E extends Env>(
  app: Hono<E>,
  opts: { secrets: DerivedSecretsConfig; authRequired?: boolean },
): Hono<E> {
  if (opts.authRequired !== false) {
    app.use(`${DEVELOPER_API_PREFIX}/instance/tunnel-token`, createDeveloperAccessMiddleware(opts.secrets))
  }

  app.post(`${DEVELOPER_API_PREFIX}/instance/tunnel-token`, async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = parseTunnelTokenBody(body)
    if (!parsed.ok) {
      return c.json({ ok: false, error: 'expected { token: string }' }, 400)
    }

    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    }

    const result = await dispatchInstanceTunnelToken({
      db,
      registry,
      token: parsed.token,
    })
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, result.status)
    }
    return c.json({ ok: true })
  })

  return app
}
