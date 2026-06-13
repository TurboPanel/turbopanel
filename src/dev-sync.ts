import type { Hono } from 'hono'
import { createRootOnlyMiddleware } from './auth/middleware.ts'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import { encodeBase64 } from '@std/encoding/base64'
import {
  awaitDaemonAck,
  type DaemonMessage,
  listDaemonConnections,
  sendToDaemon,
} from './daemon-hub.ts'
import { getDaemonRepoPath } from './daemon-version.ts'
import { DEVELOPER_API_PREFIX } from './surfaces.ts'

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
        '--exclude=./orchestration/runtime',
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

/**
 * Package the instance host's current daemon build and stream it to one
 * connected daemon over the WebSocket, then wait for it to unpack + restart.
 */
export async function syncDevToDaemon(daemonId: string): Promise<void> {
  const tarball = await buildDaemonTarball(getDaemonRepoPath())
  const base64 = encodeBase64(tarball)
  const id = crypto.randomUUID()
  const totalChunks = Math.max(1, Math.ceil(base64.length / CHUNK_CHARS))

  const begin: DaemonMessage = {
    type: 'dev-sync-begin',
    id,
    totalChunks,
    totalBytes: tarball.byteLength,
    at: new Date().toISOString(),
  }
  if (!sendToDaemon(daemonId, begin)) {
    throw new Error('daemon not connected')
  }

  const ack = awaitDaemonAck(id, DEV_SYNC_TIMEOUT_MS)

  for (let i = 0; i < totalChunks; i++) {
    const data = base64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)
    sendToDaemon(daemonId, {
      type: 'dev-sync-chunk',
      id,
      index: i,
      data,
      at: new Date().toISOString(),
    })
  }

  sendToDaemon(daemonId, { type: 'dev-sync-end', id, at: new Date().toISOString() })

  await ack
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
    const id = c.req.param('id')
    try {
      await syncDevToDaemon(id)
      return c.json({ ok: true, daemonId: id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message === 'daemon not connected' ? 404 : 500
      return c.json({ ok: false, error: message }, status)
    }
  })

  app.post(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, async (c) => {
    const results = await Promise.all(
      listDaemonConnections().map(async (conn) => {
        try {
          await syncDevToDaemon(conn.id)
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
