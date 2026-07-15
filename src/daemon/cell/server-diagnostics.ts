/**
 * ADMIN / DEBUG ONLY — fetches a live DaemonCell snapshot.
 *
 * fetchDaemonServerCell hits the Durable Object or Redis cell directly.
 * It must never be called from normal UI status views or on a timer.
 * Use the server status read model (server-status.ts) for all normal status reads.
 */
import type { Db } from '../../db.ts'
import type {
  CellDiagnostics,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from './contracts.ts'

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

export type FetchCellDiagnosticsSuccess = {
  ok: true
  diagnostics: CellDiagnostics
}

export type FetchCellDiagnosticsFailure = {
  ok: false
  status: 404
  error: string
}

export type FetchCellDiagnosticsResult =
  | FetchCellDiagnosticsSuccess
  | FetchCellDiagnosticsFailure

export async function fetchDaemonCellDiagnostics(
  registry: DaemonCellRegistry | undefined,
  serverId: string,
  opts: { debugEnabled: boolean },
): Promise<FetchCellDiagnosticsResult> {
  if (!opts.debugEnabled) {
    return { ok: false, status: 404, error: 'daemon debug disabled' }
  }

  if (!registry) {
    return { ok: false, status: 404, error: 'daemon debug disabled' }
  }

  const cell = registry.getCell(serverId)
  const getDiagnostics = cell.getDiagnostics
  if (!getDiagnostics) {
    return { ok: false, status: 404, error: 'diagnostics unavailable' }
  }

  const diagnostics = await getDiagnostics.call(cell)
  return { ok: true, diagnostics }
}

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
