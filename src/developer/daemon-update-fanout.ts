/**
 * Push the daemon `update` command to connected servers, in parallel, and
 * wait for each acknowledgement. Shared by the developer surface's daemon
 * update routes and the development Build and Push Daemon admin route.
 *
 * Deno development only: never imported by `deno.ts` or the Workers build.
 */
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../contracts/cell-protocol.ts'
import type { Db } from '../db/connection.ts'
import { resolveColocatedServerIdSet } from '../client/servers/colocated.ts'

const UPDATE_TIMEOUT_MS = 180_000

export const COLOCATED_DAEMON_UPDATE_SKIPPED_REASON =
  'The co-located development daemon runs from source — rebuild upgrades remote servers only'

export const DAEMON_NOT_CONNECTED = 'daemon not connected'

export type DaemonUpdateOptions = {
  channel?: string
  updateUrl?: string
  updateSha256?: string
}

export type DaemonUpdateResult =
  | { serverId: string; ok: true; skipped?: true; error?: string }
  | { serverId: string; ok: false; error: string }

/** Send one `update` envelope and wait for the daemon to report done. */
export async function pushDaemonUpdate(
  registry: DaemonCellRegistry,
  serverId: string,
  options: DaemonUpdateOptions
): Promise<void> {
  const envelope: DaemonOutboundEnvelope = {
    kind: 'update',
    deliveryId: generateDeliveryId(),
    requestId: generateRequestId(),
    at: new Date().toISOString(),
    channel: options.channel ?? 'trunk',
    ...(options.updateUrl === undefined ? {} : { updateUrl: options.updateUrl }),
    ...(options.updateSha256 === undefined ? {} : { updateSha256: options.updateSha256 }),
  }

  const snapshots = await registry.getSnapshots([serverId])
  if (!snapshots.get(serverId)?.connected) {
    throw new Error(DAEMON_NOT_CONNECTED)
  }

  const record = await registry.getCell(serverId).createRequestAndWait(envelope, UPDATE_TIMEOUT_MS)

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
 * Update every listed server except the co-located one (it runs from source
 * and is reported as skipped). The pushes run in parallel; one failure never
 * stops the others.
 */
export async function fanOutDaemonUpdate(
  registry: DaemonCellRegistry,
  db: Db,
  serverIds: readonly string[],
  options: DaemonUpdateOptions
): Promise<DaemonUpdateResult[]> {
  const ids = [...serverIds]
  const colocatedIds = await resolveColocatedServerIdSet(db, registry, ids)
  const skipped: DaemonUpdateResult[] = ids
    .filter((serverId) => colocatedIds.has(serverId))
    .map((serverId) => ({
      serverId,
      ok: true,
      skipped: true,
      error: COLOCATED_DAEMON_UPDATE_SKIPPED_REASON,
    }))
  const pushed = await Promise.all(
    ids
      .filter((serverId) => !colocatedIds.has(serverId))
      .map(async (serverId): Promise<DaemonUpdateResult> => {
        try {
          await pushDaemonUpdate(registry, serverId, options)
          return { serverId, ok: true }
        } catch (err) {
          return { serverId, ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      })
  )
  return [...skipped, ...pushed]
}
