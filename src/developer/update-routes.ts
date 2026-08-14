import type { Hono } from 'hono'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import type { DaemonCellRegistry } from '../daemon/cell/contracts.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import { getDaemonCellRegistry, getDb } from '../db.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import { resolveColocatedServerIdSet } from '../client/servers/colocated.ts'

const UPDATE_TIMEOUT_MS = 180_000
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

export const COLOCATED_DAEMON_UPDATE_SKIPPED_REASON =
  'The co-located development daemon runs from source — rebuild upgrades remote servers only'

function parseUpdateOverride(body: {
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

async function updateDaemon(
  registry: DaemonCellRegistry,
  serverId: string,
  options: { channel?: string; updateUrl?: string; updateSha256?: string },
): Promise<void> {
  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'update',
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    channel: options.channel ?? 'trunk',
    ...(options.updateUrl !== undefined ? { updateUrl: options.updateUrl } : {}),
    ...(options.updateSha256 !== undefined
      ? { updateSha256: options.updateSha256 }
      : {}),
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
 * Push a daemon update trigger to connected daemons. Defaults to channel-based
 * resolution (trunk); optional updateUrl + updateSha256 for explicit-URL triggers.
 */
export function registerUpdateRoutes(
  app: Hono,
  opts: { secrets: DerivedSecretsConfig; authRequired?: boolean },
): Hono {
  if (opts.authRequired !== false) {
    app.use(`${DEVELOPER_API_PREFIX}/daemon/update`, createDeveloperAccessMiddleware(opts.secrets))
    app.use(`${DEVELOPER_API_PREFIX}/daemon/:id/update`, createDeveloperAccessMiddleware(opts.secrets))
  }

  app.post(`${DEVELOPER_API_PREFIX}/daemon/:id/update`, async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    const body = await c.req.json().catch(() => ({})) as {
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
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, [serverId])
    if (colocatedIds.has(serverId)) {
      return c.json({
        ok: true,
        results: [{
          daemonId: serverId,
          ok: true,
          skipped: true,
          error: COLOCATED_DAEMON_UPDATE_SKIPPED_REASON,
        }],
      })
    }
    try {
      await updateDaemon(registry, serverId, { channel, ...override })
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
    const body = await c.req.json().catch(() => ({})) as {
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
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, ids)
    const skippedResults = ids
      .filter((serverId) => colocatedIds.has(serverId))
      .map((daemonId) => ({
        daemonId,
        ok: true as const,
        skipped: true as const,
        error: COLOCATED_DAEMON_UPDATE_SKIPPED_REASON,
      }))
    const results = await Promise.all(
      ids
        .filter((serverId) => !colocatedIds.has(serverId))
        .map(async (serverId) => {
          try {
            await updateDaemon(registry, serverId, { channel, ...override })
            return { daemonId: serverId, ok: true as const }
          } catch (err) {
            return {
              daemonId: serverId,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        }),
    )
    const combined = [...skippedResults, ...results]
    return c.json({ ok: combined.every((r) => r.ok), results: combined })
  })

  return app
}
