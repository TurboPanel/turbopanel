import type { Hono } from 'hono'
import { join } from '@std/path'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import { encodeBase64 } from '@std/encoding/base64'
import type { DaemonCellRegistry } from '../daemon/cell/contracts.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import { resolveColocatedServerIdSet } from '../client/servers/colocated.ts'
import { getDaemonCellRegistry, getDb } from '../db.ts'
import { getDaemonRepoPath } from '../daemon/version.ts'
import { cellTrace } from '../logger.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import { buildDevSyncTarArgs } from './dev-sync-archive.ts'

export const COLOCATED_DEV_SYNC_SKIPPED_REASON =
  'The co-located development daemon is not updated by dev-sync — edit the local checkout directly'

/**
 * Stable marker embedded in the daemon's managed-install dev-sync refusal
 * (`MANAGED_DEV_SYNC_REFUSED_REASON` in the daemon's `src/dev-sync-apply.ts`).
 * A target daemon on a managed / compiled / JS-fallback install has no editable
 * source checkout to replace and refuses the transfer; matching this marker lets
 * us classify that daemon as skipped rather than failed, so a mixed fleet
 * (co-located dev + managed) does not fail the whole sync. Keep in sync with the
 * daemon constant.
 */
export const MANAGED_DAEMON_DEV_SYNC_MARKER = 'dev-sync refused on this managed install'

export const MANAGED_DAEMON_DEV_SYNC_SKIPPED_REASON =
  'Skipped a managed install — source dev-sync only targets co-located development daemon checkouts'

/**
 * Refusal when the *instance host itself* has no daemon source checkout to
 * package (managed install). Source-sync streams this host's `../daemon`
 * checkout; without it there is nothing to send and the flow is disabled.
 */
export const INSTANCE_NO_DAEMON_CHECKOUT_REASON =
  'dev-sync is unavailable — this instance host has no daemon source checkout to package (managed installs update via run.sh / update.sh)'

/** Base64 characters per chunk (~256 KiB of payload before encoding). */
const CHUNK_CHARS = 256 * 1024
/** Generous ceiling: tar + transfer + unpack + deno cache + restart ack. */
const DEV_SYNC_TIMEOUT_MS = 180_000

/** True when the daemon refused because it is a managed (non-checkout) install. */
function isManagedDaemonDevSyncRefusal(message: string): boolean {
  return message.includes(MANAGED_DAEMON_DEV_SYNC_MARKER)
}

/**
 * True when `repo` is a real, editable daemon source checkout (has `main.ts`).
 * Source-sync packages this tree; a managed instance host has no such checkout.
 */
async function hasInstanceDaemonCheckout(repo: string): Promise<boolean> {
  try {
    await Deno.stat(join(repo, 'main.ts'))
    return true
  } catch {
    return false
  }
}

/**
 * Build a gzipped tarball of the local daemon checkout from an explicit source
 * allowlist (see {@link buildDevSyncTarArgs}). Only the source files an official
 * install ships are included — host-local/runtime paths such as `.env`, tunnel
 * state, logs, caches, and `node_modules` are never copied to other nodes, while
 * the checked-in `orchestration/roles` tree is. Requires `--allow-run=tar`.
 */
async function buildDaemonTarball(repo: string): Promise<Uint8Array> {
  // Stream the archive to stdout (`-f -`) rather than a temp file. The instance
  // runs as a sandboxed Deno process whose `--allow-write` does not include the
  // OS temp dir, so `Deno.makeTempFile()` throws "Requires write access to
  // <TMP>". Writing to stdout needs no filesystem write permission.
  const command = new Deno.Command('tar', {
    args: buildDevSyncTarArgs(repo, '-'),
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await command.output()
  if (!out.success) {
    throw new Error(`tar failed: ${new TextDecoder().decode(out.stderr).trim()}`)
  }
  return out.stdout
}

async function syncDevToDaemonWithRegistry(
  registry: DaemonCellRegistry,
  serverId: string,
): Promise<void> {
  const snapshots = await registry.getSnapshots([serverId])
  if (!snapshots.get(serverId)?.connected) {
    throw new Error('daemon not connected')
  }

  // Gate on the source: only a checkout-backed instance host can serve dev-sync.
  const repo = getDaemonRepoPath()
  if (!(await hasInstanceDaemonCheckout(repo))) {
    throw new Error(INSTANCE_NO_DAEMON_CHECKOUT_REASON)
  }

  const cell = registry.getCell(serverId)
  const tarball = await buildDaemonTarball(repo)
  const base64 = encodeBase64(tarball)
  const requestId = generateRequestId()
  const totalChunks = Math.max(1, Math.ceil(base64.length / CHUNK_CHARS))

  cellTrace('request-start', {
    requestId,
    serverId,
    kind: 'dev-sync',
    totalChunks,
    totalBytes: tarball.byteLength,
  })

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
  cellTrace('request-enqueued', {
    requestId,
    serverId,
    kind: 'dev-sync',
    phase: 'begin',
    totalChunks,
  })

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
  cellTrace('request-enqueued', {
    requestId,
    serverId,
    kind: 'dev-sync',
    phase: 'end',
    totalChunks,
  })

  const record = await cell.waitForRequest(requestId, DEV_SYNC_TIMEOUT_MS)
  if (!record || record.status === 'expired') {
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'dev-sync',
      pendingStatus: record?.status,
      resultStatus: 'timeout',
      error: 'timeout waiting for daemon acknowledgement',
    })
    throw new Error('timeout waiting for daemon acknowledgement')
  }
  if (record.status === 'failed') {
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'dev-sync',
      pendingStatus: record.status,
      resultStatus: 'failed',
      error: record.error ?? 'daemon reported failure',
    })
    throw new Error(record.error ?? 'daemon reported failure')
  }
  if (record.status !== 'done') {
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'dev-sync',
      pendingStatus: record.status,
      resultStatus: 'failed',
      error: `unexpected dev-sync status: ${record.status}`,
    })
    throw new Error(`unexpected dev-sync status: ${record.status}`)
  }
  cellTrace('request-result', {
    requestId,
    serverId,
    kind: 'dev-sync',
    pendingStatus: record.status,
    resultStatus: 'done',
  })
}

/**
 * Package the instance host's current daemon build and stream it to one
 * connected daemon over the WebSocket, then wait for unpack + systemd restart.
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
    app.use(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, createDeveloperAccessMiddleware(opts.secrets))
    app.use(`${DEVELOPER_API_PREFIX}/daemon/:id/sync-dev`, createDeveloperAccessMiddleware(opts.secrets))
  }

  app.post(`${DEVELOPER_API_PREFIX}/daemon/:id/sync-dev`, async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    const id = c.req.param('id')
    const colocatedIds = await resolveColocatedServerIdSet(getDb(c), registry, [id])
    if (colocatedIds.has(id)) {
      return c.json({ ok: false, error: COLOCATED_DEV_SYNC_SKIPPED_REASON }, 422)
    }
    try {
      await syncDevToDaemon(id, registry)
      return c.json({ ok: true, daemonId: id })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Managed target daemon has no source checkout — report as skipped, not
      // failed, so operators aren't shown a spurious error for a valid install.
      if (isManagedDaemonDevSyncRefusal(message)) {
        return c.json({
          ok: true,
          daemonId: id,
          skipped: true,
          error: MANAGED_DAEMON_DEV_SYNC_SKIPPED_REASON,
        })
      }
      const status = message === 'daemon not connected' ? 404 : 500
      return c.json({ ok: false, error: message }, status)
    }
  })

  app.post(`${DEVELOPER_API_PREFIX}/daemon/sync-dev`, async (c) => {
    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
    const ids = await registry.listOnlineServerIds()
    const colocatedIds = await resolveColocatedServerIdSet(getDb(c), registry, ids)
    const skippedResults = ids
      .filter((serverId) => colocatedIds.has(serverId))
      .map((daemonId) => ({
        daemonId,
        ok: true as const,
        skipped: true as const,
        error: COLOCATED_DEV_SYNC_SKIPPED_REASON,
      }))
    const results = await Promise.all(
      ids
        .filter((serverId) => !colocatedIds.has(serverId))
        .map(async (serverId) => {
          try {
            await syncDevToDaemon(serverId, registry)
            return { daemonId: serverId, ok: true as const }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            // Managed target daemon has no source checkout — classify as skipped
            // so a mixed fleet does not fail the whole sync.
            if (isManagedDaemonDevSyncRefusal(message)) {
              return {
                daemonId: serverId,
                ok: true as const,
                skipped: true as const,
                error: MANAGED_DAEMON_DEV_SYNC_SKIPPED_REASON,
              }
            }
            return {
              daemonId: serverId,
              ok: false as const,
              error: message,
            }
          }
        }),
    )
    const allResults = [...skippedResults, ...results]
    return c.json({
      ok: allResults.every((r) => r.ok),
      results: allResults,
    })
  })

  return app
}
