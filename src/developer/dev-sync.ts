import type { Hono } from 'hono'
import { createRootOnlyMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import { encodeBase64 } from '@std/encoding/base64'
import type { DaemonCellRegistry } from '../daemon/cell/contracts.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import { getDaemonCellRegistry } from '../db.ts'
import { getDaemonRepoPath } from '../daemon/version.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'

/** Base64 characters per chunk (~256 KiB of payload before encoding). */
const CHUNK_CHARS = 256 * 1024
/** Generous ceiling: tar + transfer + unpack + deno cache + restart ack. */
const DEV_SYNC_TIMEOUT_MS = 180_000

/**
 * Build a gzipped tarball of the local daemon checkout, excluding heavy,
 * host-specific, or generated paths. Requires `--allow-run=tar`.
 */
async function buildDaemonTarball(repo: string): Promise<Uint8Array> {
  const tmp = await Deno.makeTempFile({ suffix: '.tgz' })
  try {
    const command = new Deno.Command('tar', {
      args: [
        '-czf',
        tmp,
        '-C',
        repo,
        '--exclude=./.git',
        '--exclude=./orchestration/roles',
        '--exclude=./cloudflared/tunnels',
        '--exclude=./node_modules',
        '.',
      ],
      stdout: 'piped',
      stderr: 'piped',
    })
    const out = await command.output()
    if (!out.success) {
      throw new Error(`tar failed: ${new TextDecoder().decode(out.stderr).trim()}`)
    }
    return await Deno.readFile(tmp)
  } finally {
    await Deno.remove(tmp).catch(() => {})
  }
}

async function syncDevToDaemonWithRegistry(
  registry: DaemonCellRegistry,
  serverId: string,
): Promise<void> {
  const snapshots = await registry.getSnapshots([serverId])
  if (!snapshots.get(serverId)?.connected) {
    throw new Error('daemon not connected')
  }

  const cell = registry.getCell(serverId)
  const tarball = await buildDaemonTarball(getDaemonRepoPath())
  const base64 = encodeBase64(tarball)
  const requestId = generateRequestId()
  const totalChunks = Math.max(1, Math.ceil(base64.length / CHUNK_CHARS))

  const begin: DaemonOutboundEnvelope = {
    kind: 'dev-sync',
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    phase: 'begin',
    totalChunks,
    totalBytes: tarball.byteLength,
  }
  await cell.enqueue(begin)

  for (let i = 0; i < totalChunks; i++) {
    const chunk: DaemonOutboundEnvelope = {
      kind: 'dev-sync',
      deliveryId: generateDeliveryId(),
      requestId,
      at: new Date().toISOString(),
      phase: 'chunk',
      index: i,
      data: base64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
    }
    await cell.enqueue(chunk)
  }

  const end: DaemonOutboundEnvelope = {
    kind: 'dev-sync',
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    phase: 'end',
  }
  await cell.enqueue(end)

  const record = await cell.waitForRequest(requestId, DEV_SYNC_TIMEOUT_MS)
  if (!record || record.status === 'expired') {
    throw new Error('timeout waiting for daemon acknowledgement')
  }
  if (record.status === 'failed') {
    throw new Error(record.error ?? 'daemon reported failure')
  }
  if (record.status !== 'done') {
    throw new Error(`unexpected dev-sync status: ${record.status}`)
  }
}

/**
 * Package the instance host's current daemon build and stream it to one
 * connected daemon over the WebSocket, then wait for it to unpack + restart.
 */
export async function syncDevToDaemon(
  daemonId: string,
  registry: DaemonCellRegistry,
): Promise<void> {
  await syncDevToDaemonWithRegistry(registry, daemonId)
}

/**
 * Admin routes to push the current dev daemon build to agents. Deno-only: tar +
 * filesystem access are not available in the Workers build.
 */
export function registerDevSyncRoutes(
  app: Hono,
  opts: { secrets: DerivedSecretsConfig; authRequired?: boolean },
): Hono {
  if (opts.authRequired !== false) {
    app.use(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, createRootOnlyMiddleware(opts.secrets))
    app.use(`${DEVELOPER_API_PREFIX}/daemon/:id/sync-dev`, createRootOnlyMiddleware(opts.secrets))
  }

  app.post(`${DEVELOPER_API_PREFIX}/daemon/:id/sync-dev`, async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    const id = c.req.param('id')
    try {
      await syncDevToDaemon(id, registry)
      return c.json({ ok: true, daemonId: id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message === 'daemon not connected' ? 404 : 500
      return c.json({ ok: false, error: message }, status)
    }
  })

  app.post(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    const ids = await registry.listOnlineServerIds()
    const results = await Promise.all(
      ids.map(async (serverId) => {
        try {
          await syncDevToDaemon(serverId, registry)
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
