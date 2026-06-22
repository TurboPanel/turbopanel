import type { Hono } from 'hono'
import { createRootOnlyMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import type { DaemonCellRegistry } from '../daemon/cell/contracts.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import { getDaemonCellRegistry } from '../db.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'

const UPDATE_TIMEOUT_MS = 120_000

async function updateDaemon(
  registry: DaemonCellRegistry,
  serverId: string,
  updateUrl: string,
): Promise<void> {
  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'update',
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    updateUrl,
  }

  const snapshots = await registry.getSnapshots([serverId])
  if (!snapshots.get(serverId)?.connected) {
    throw new Error('daemon not connected')
  }

  const record = await registry.getCell(serverId).createRequestAndWait(
    envelope,
    UPDATE_TIMEOUT_MS,
  )

  if (record.status === 'done') return
  if (record.status === 'failed') {
    throw new Error(record.error ?? 'daemon reported failure')
  }
  if (record.status === 'expired') {
    throw new Error('timeout waiting for daemon acknowledgement')
  }
  throw new Error(`unexpected update status: ${record.status}`)
}

/**
 * Push a daemon update URL to connected agents. Each daemon downloads the
 * binary, refreshes its checkout, and restarts via update.sh.
 */
export function registerUpdateRoutes(
  app: Hono,
  opts: { secrets: DerivedSecretsConfig; authRequired?: boolean },
): Hono {
  if (opts.authRequired !== false) {
    app.use(`${DEVELOPER_API_PREFIX}/daemon/update`, createRootOnlyMiddleware(opts.secrets))
    app.use(`${DEVELOPER_API_PREFIX}/daemon/:id/update`, createRootOnlyMiddleware(opts.secrets))
  }

  app.post(`${DEVELOPER_API_PREFIX}/daemon/:id/update`, async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof body.updateUrl !== 'string') {
      return c.json({ ok: false, error: 'expected { updateUrl: string }' }, 400)
    }

    const serverId = c.req.param('id')
    try {
      await updateDaemon(registry, serverId, body.updateUrl)
      return c.json({ ok: true, results: [{ daemonId: serverId, ok: true }] })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message === 'daemon not connected' ? 404 : 500
      return c.json({
        ok: false,
        results: [{ daemonId: serverId, ok: false, error: message }],
      }, status)
    }
  })

  app.post(`${DEVELOPER_API_PREFIX}/daemon/update`, async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof body.updateUrl !== 'string') {
      return c.json({ ok: false, error: 'expected { updateUrl: string }' }, 400)
    }

    const ids = await registry.listOnlineServerIds()
    const results = await Promise.all(
      ids.map(async (serverId) => {
        try {
          await updateDaemon(registry, serverId, body.updateUrl)
          return { daemonId: serverId, ok: true }
        } catch (err) {
          return {
            daemonId: serverId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )
    return c.json({ ok: results.every((r) => r.ok), results })
  })

  return app
}
