import type { Hono } from 'hono'
import { createRootOnlyMiddleware } from '../client/authn/middleware.ts'
import { resolveColocatedServerId } from '../client/authn/install-state.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import { getDb, getDaemonCellRegistry } from '../db.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'

const TUNNEL_TOKEN_TIMEOUT_MS = 30_000

/**
 * Set the self-hosted instance's Cloudflare tunnel token. The token is pushed
 * to the co-located daemon (which runs cloudflared), exposing this instance so
 * external remote daemons can connect in. An empty token tears the tunnel down.
 */
export function registerTunnelRoutes(
  app: Hono,
  opts: { secrets: DerivedSecretsConfig; authRequired?: boolean },
): Hono {
  if (opts.authRequired !== false) {
    app.use(`${DEVELOPER_API_PREFIX}/instance/tunnel-token`, createRootOnlyMiddleware(opts.secrets))
  }

  app.post(`${DEVELOPER_API_PREFIX}/instance/tunnel-token`, async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof body.token !== 'string') {
      return c.json({ ok: false, error: 'expected { token: string }' }, 400)
    }

    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    }

    const serverId = await resolveColocatedServerId(db, registry)
    if (!serverId) {
      return c.json(
        { ok: false, error: 'no co-located daemon connected to run the tunnel' },
        503,
      )
    }

    const snapshots = await registry.getSnapshots([serverId])
    if (!snapshots.get(serverId)?.connected) {
      return c.json({ ok: false, error: 'co-located daemon disconnected' }, 503)
    }

    const requestId = generateRequestId()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'tunnel-token',
      deliveryId: generateDeliveryId(),
      requestId,
      at: new Date().toISOString(),
      token: body.token,
    }

    try {
      const record = await registry.getCell(serverId).createRequestAndWait(
        envelope,
        TUNNEL_TOKEN_TIMEOUT_MS,
      )
      if (record.status === 'done') {
        return c.json({ ok: true })
      }
      if (record.status === 'failed') {
        return c.json({ ok: false, error: record.error ?? 'daemon reported failure' }, 500)
      }
      return c.json({ ok: false, error: 'timeout waiting for daemon acknowledgement' }, 500)
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      return c.json({ ok: false, error: errMessage }, 500)
    }
  })

  return app
}
