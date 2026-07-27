import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDaemonCellRegistry } from '../../db.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../../daemon/cell/protocol.ts'
import { cellTrace } from '../../logger.ts'
import { loadServerStatusRecords } from '../servers/update-status.ts'
import type { Db } from '../../db.ts'

const LOGS_TIMEOUT_MS = 20_000
const DEFAULT_TAIL = 200
const MAX_TAIL = 2_000

export function clampManagedLogsTail(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_TAIL
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_TAIL
  return Math.min(Math.max(1, parsed), MAX_TAIL)
}

/** Alias used by managed routes (`?tail=` query). */
export function parseLogsTailQuery(raw: string | undefined): number {
  return clampManagedLogsTail(raw)
}

function extractLogs(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return null
  }
  const logs = (result as Record<string, unknown>).logs
  return typeof logs === 'string' ? logs : null
}

/**
 * Correlated cell round-trip for managed compose logs (not a command).
 */
export async function fetchManagedLogs(
  c: Context<AppEnv>,
  db: Db,
  params: {
    serverId: string
    managedId: string
    tail: number
  },
): Promise<{ logs: string } | Response> {
  const registry = getDaemonCellRegistry(c)
  if (!registry) {
    return c.json({ error: 'Daemon cell registry unavailable' }, 503)
  }

  const records = await loadServerStatusRecords(db, registry, [params.serverId])
  const live = records[0]
  if (!live?.connected) {
    return c.json({ error: 'server_offline' }, 409)
  }

  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'managed-logs-request',
    deliveryId: generateDeliveryId(),
    requestId,
    managedId: params.managedId,
    tail: params.tail,
    at: new Date().toISOString(),
  }

  cellTrace('request-start', {
    requestId,
    serverId: params.serverId,
    kind: 'managed-logs-request',
  })

  try {
    const record = await registry.getCell(params.serverId).createRequestAndWait(
      envelope,
      LOGS_TIMEOUT_MS,
    )

    if (record.status === 'expired') {
      cellTrace('request-result', {
        requestId,
        serverId: params.serverId,
        kind: 'managed-logs-request',
        pendingStatus: record.status,
        resultStatus: 'timeout',
      })
      return c.json({ error: 'timeout waiting for managed logs' }, 503)
    }

    if (record.status === 'failed') {
      const error = record.error ?? 'failed to fetch managed logs'
      cellTrace('request-result', {
        requestId,
        serverId: params.serverId,
        kind: 'managed-logs-request',
        pendingStatus: record.status,
        resultStatus: 'failed',
        error,
      })
      return c.json({ error }, 500)
    }

    const logs = extractLogs(record.result)
    if (logs === null) {
      return c.json({ error: 'invalid managed logs result' }, 500)
    }

    cellTrace('request-result', {
      requestId,
      serverId: params.serverId,
      kind: 'managed-logs-request',
      pendingStatus: record.status,
      resultStatus: 'done',
    })
    return { logs }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId: params.serverId,
      kind: 'managed-logs-request',
      resultStatus: 'error',
      error: message,
    })
    return c.json({ error: message }, 503)
  }
}
