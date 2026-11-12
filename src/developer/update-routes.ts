import type { Env, Hono } from 'hono'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { getDaemonCellRegistry, getDb } from '../db/connection.ts'
import { DEVELOPER_API_PREFIX } from '../app/surfaces.ts'
import {
  DAEMON_NOT_CONNECTED,
  type DaemonUpdateResult,
  fanOutDaemonUpdate,
} from './daemon-update-fanout.ts'

export { COLOCATED_DAEMON_UPDATE_SKIPPED_REASON } from './daemon-update-fanout.ts'

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

export function parseUpdateOverride(body: {
  updateUrl?: unknown
  updateSha256?: unknown
}): { updateUrl?: string; updateSha256?: string } | { error: string } {
  const updateUrl = typeof body.updateUrl === 'string' ? body.updateUrl.trim() : ''
  const updateSha256 =
    typeof body.updateSha256 === 'string' ? body.updateSha256.trim().toLowerCase() : ''

  if (!updateUrl && !updateSha256) {
    return {}
  }

  if (!updateUrl || !updateSha256) {
    return {
      error: 'updateUrl and updateSha256 must both be provided for explicit URL updates',
    }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(updateUrl)
  } catch {
    return { error: 'updateUrl must be a valid absolute URL' }
  }

  if (parsedUrl.protocol !== 'https:') {
    return { error: 'updateUrl must use HTTPS' }
  }

  if (!SHA256_HEX_RE.test(updateSha256)) {
    return { error: 'updateSha256 must be a 64-character hex string' }
  }

  return { updateUrl, updateSha256 }
}

function toDeveloperResult(result: DaemonUpdateResult) {
  const { serverId, ...rest } = result
  return { daemonId: serverId, ...rest }
}

/**
 * Push a daemon update trigger to connected daemons. Defaults to channel-based
 * resolution (trunk); optional updateUrl + updateSha256 for explicit-URL triggers.
 */
export function registerUpdateRoutes<E extends Env>(
  app: Hono<E>,
  opts: { secrets: DerivedSecretsConfig; authRequired?: boolean }
): Hono<E> {
  if (opts.authRequired !== false) {
    app.use(`${DEVELOPER_API_PREFIX}/daemon/update`, createDeveloperAccessMiddleware(opts.secrets))
    app.use(
      `${DEVELOPER_API_PREFIX}/daemon/:id/update`,
      createDeveloperAccessMiddleware(opts.secrets)
    )
  }

  app.post(`${DEVELOPER_API_PREFIX}/daemon/:id/update`, async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as {
      updateUrl?: unknown
      updateSha256?: unknown
      channel?: unknown
    }
    const channel = typeof body.channel === 'string' ? body.channel : 'trunk'
    const override = parseUpdateOverride(body)
    if ('error' in override) {
      return c.json({ ok: false, error: override.error }, 400)
    }

    const serverId = c.req.param('id')
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const [result] = await fanOutDaemonUpdate(registry, db, [serverId], { channel, ...override })
    if (!result || result.ok) {
      return c.json({ ok: true, results: result ? [toDeveloperResult(result)] : [] })
    }
    const status = result.error === DAEMON_NOT_CONNECTED ? 404 : 500
    return c.json({ ok: false, results: [toDeveloperResult(result)] }, status)
  })

  app.post(`${DEVELOPER_API_PREFIX}/daemon/update`, async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as {
      updateUrl?: unknown
      updateSha256?: unknown
      channel?: unknown
    }
    const channel = typeof body.channel === 'string' ? body.channel : 'trunk'
    const override = parseUpdateOverride(body)
    if ('error' in override) {
      return c.json({ ok: false, error: override.error }, 400)
    }

    const ids = await registry.listOnlineServerIds()
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const combined = (await fanOutDaemonUpdate(registry, db, ids, { channel, ...override })).map(
      toDeveloperResult
    )
    return c.json({ ok: combined.every((r) => r.ok), results: combined })
  })

  return app
}
