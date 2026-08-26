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
import { parseLogsTailQuery } from '../managed/logs.ts'

const LOGS_TIMEOUT_MS = 20_000

export { parseLogsTailQuery }

function extractLogs(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return null
  }
  const logs = (result as Record<string, unknown>).logs
  return typeof logs === 'string' ? logs : null
}

/**
 * Correlated cell round-trip for a bounded `docker container logs` tail
 * (not a command, not stored).
 */
export async function fetchContainerLogTail(
  c: Context<AppEnv>,
  db: Db,
  params: {
    serverId: string
    containerId: string
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
    kind: 'container-logs-request',
    deliveryId: generateDeliveryId(),
    requestId,
    containerId: params.containerId,
    tail: params.tail,
    at: new Date().toISOString(),
  }

  cellTrace('request-start', {
    requestId,
    serverId: params.serverId,
    kind: 'container-logs-request',
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
        kind: 'container-logs-request',
        pendingStatus: record.status,
        resultStatus: 'timeout',
      })
      return c.json({ error: 'timeout waiting for container logs' }, 503)
    }

    if (record.status === 'failed') {
      const error = record.error ?? 'failed to fetch container logs'
      cellTrace('request-result', {
        requestId,
        serverId: params.serverId,
        kind: 'container-logs-request',
        pendingStatus: record.status,
        resultStatus: 'failed',
        error,
      })
      return c.json({ error }, 500)
    }

    const logs = extractLogs(record.result)
    if (logs === null) {
      return c.json({ error: 'invalid container logs result' }, 500)
    }

    cellTrace('request-result', {
      requestId,
      serverId: params.serverId,
      kind: 'container-logs-request',
      pendingStatus: record.status,
      resultStatus: 'done',
    })
    return { logs }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId: params.serverId,
      kind: 'container-logs-request',
      resultStatus: 'error',
      error: message,
    })
    return c.json({ error: message }, 503)
  }
}
