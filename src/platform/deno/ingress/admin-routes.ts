import type { Hono, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { getDaemonCellRegistry, getDb } from '../../../db/connection.ts'
import {
  dispatchInstanceTunnelToken,
  parseTunnelTokenBody,
} from '../../../developer/tunnel-token.ts'

export type IngressAdminDeps = { rootOnly: MiddlewareHandler<AppEnv> }

/**
 * Self-hosted-only admin routes. Mounted only by `src/platform/deno/server.ts`
 * through `registerAdminRoutes({ registerPlatformAdminRoutes })`, so the admin
 * session middleware still applies and High Availability has no such route.
 */
export function registerIngressAdminRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.post('/instance/tunnel-token', deps.rootOnly, async (c) => {
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
      secretsConfig: c.get('secretsConfig'),
    })
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, result.status)
    }
    return c.json({ ok: true })
  })
}
