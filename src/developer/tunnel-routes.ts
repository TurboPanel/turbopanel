import type { Env, Hono } from 'hono'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
import { resolveColocatedServerId } from '../client/authn/install-state.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import { getDb, getDaemonCellRegistry } from '../db.ts'
import { cellTrace } from '../logger.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'

const TUNNEL_TOKEN_TIMEOUT_MS = 30_000

export function parseTunnelTokenBody(
  body: unknown,
): { ok: true; token: string } | { ok: false } {
  if (!body || typeof body !== 'object') {
    return { ok: false }
  }
  const token = (body as { token?: unknown }).token
  if (typeof token !== 'string') {
    return { ok: false }
  }
  return { ok: true, token }
}

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
    cellTrace('request-start', {
      requestId,
      serverId,
      kind: 'tunnel-token',
    })
    const envelope: DaemonOutboundEnvelope = {
      kind: 'tunnel-token',
      deliveryId: generateDeliveryId(),
      requestId,
      at: new Date().toISOString(),
      token: parsed.token,
    }
    cellTrace('request-enqueued', {
      requestId,
      serverId,
      kind: 'tunnel-token',
      deliveryId: envelope.deliveryId,
    })

    try {
      const record = await registry.getCell(serverId).createRequestAndWait(
        envelope,
        TUNNEL_TOKEN_TIMEOUT_MS,
      )
      if (record.status === 'done') {
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'tunnel-token',
          pendingStatus: record.status,
          resultStatus: 'done',
        })
        return c.json({ ok: true })
      }
      if (record.status === 'failed') {
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'tunnel-token',
          pendingStatus: record.status,
          resultStatus: 'failed',
          error: record.error ?? 'daemon reported failure',
        })
        return c.json({ ok: false, error: record.error ?? 'daemon reported failure' }, 500)
      }
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'tunnel-token',
        pendingStatus: record.status,
        resultStatus: 'timeout',
        error: 'timeout waiting for daemon acknowledgement',
      })
      return c.json({ ok: false, error: 'timeout waiting for daemon acknowledgement' }, 500)
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'tunnel-token',
        resultStatus: 'error',
        error: errMessage,
      })
      return c.json({ ok: false, error: errMessage }, 500)
    }
  })

  return app
}
