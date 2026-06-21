import type { Hono } from 'hono'
import { createRootOnlyMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import {
  awaitDaemonAck,
  type DaemonMessage,
  listDaemonConnections,
  sendToDaemon,
} from '../daemon/hub.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'

const UPDATE_TIMEOUT_MS = 120_000

async function updateDaemon(daemonId: string, updateUrl: string): Promise<void> {
  const id = crypto.randomUUID()
  const ack = awaitDaemonAck(id, UPDATE_TIMEOUT_MS)
  const message: DaemonMessage = {
    type: 'update',
    id,
    updateUrl,
    at: new Date().toISOString(),
  }
  if (!sendToDaemon(daemonId, message)) {
    throw new Error('daemon not connected')
  }
  await ack
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
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof body.updateUrl !== 'string') {
      return c.json({ ok: false, error: 'expected { updateUrl: string }' }, 400)
    }

    const daemonId = c.req.param('id')
    try {
      await updateDaemon(daemonId, body.updateUrl)
      return c.json({ ok: true, results: [{ daemonId, ok: true }] })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message === 'daemon not connected' ? 404 : 500
      return c.json({
        ok: false,
        results: [{ daemonId, ok: false, error: message }],
      }, status)
    }
  })

  app.post(`${DEVELOPER_API_PREFIX}/daemon/update`, async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof body.updateUrl !== 'string') {
      return c.json({ ok: false, error: 'expected { updateUrl: string }' }, 400)
    }

    const results = await Promise.all(
      listDaemonConnections().map(async (conn) => {
        try {
          await updateDaemon(conn.id, body.updateUrl)
          return { daemonId: conn.id, ok: true }
        } catch (err) {
          return {
            daemonId: conn.id,
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
