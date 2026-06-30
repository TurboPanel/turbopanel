/**
 * ADMIN / DEBUG ONLY — fetches a live DaemonCell snapshot.
 *
 * fetchDaemonServerCell hits the Durable Object or Redis cell directly.
 * It must never be called from normal UI status views or on a timer.
 * Use the server status read model (server-status.ts) for all normal status reads.
 */
/**
 * ADMIN / DEBUG ONLY — fetches a live DaemonCell snapshot.
 *
 * fetchDaemonServerCell hits the Durable Object or Redis cell directly.
 * It must never be called from normal UI status views or on a timer.
 * Use the server status read model (server-status.ts) for all normal status reads.
 */
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from './contracts.ts'
import type { DaemonCellSnapshot } from './contracts.ts'

export type FetchServerCellSuccess = {
  ok: true
  snapshot: DaemonCellSnapshot
}

export type FetchServerCellFailure = {
  ok: false
  status: 404 | 503
  error: string
}

export type FetchServerCellResult = FetchServerCellSuccess | FetchServerCellFailure

export async function fetchDaemonServerCell(
  _db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string,
): Promise<FetchServerCellResult> {
  if (!registry) {
    return { ok: false, status: 503, error: 'Daemon cell registry unavailable' }
  }

  const cell = registry.getCell(serverId)
  const snapshot = await cell.getSnapshot()
  if (!snapshot.serverId) {
    return { ok: false, status: 404, error: 'server not found' }
  }

  return { ok: true, snapshot }
}
