import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from './contracts.ts'
import { isServerConnected, resolveFleetPresence } from './fleet-presence.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from './protocol.ts'
import type {
  DaemonCellSnapshot,
  MonitorInstanceRow,
  MonitorResourceRow,
} from './contracts.ts'

const PING_TIMEOUT_MS = 5_000

function nowTs(): string {
  return new Date().toISOString()
}

export type PingServerSuccess = {
  ok: true
  tripMs: number
  sentAt: string
  pongAt: string
}

export type PingServerFailure = {
  ok: false
  status: 404 | 503 | 504
  error: string
}

export type PingServerResult = PingServerSuccess | PingServerFailure

export async function pingDaemonServer(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string,
): Promise<PingServerResult> {
  if (!registry) {
    return { ok: false, status: 503, error: 'Daemon cell registry unavailable' }
  }

  if (!await isServerConnected(db, registry, serverId)) {
    return { ok: false, status: 404, error: 'daemon not connected' }
  }

  const envelope: DaemonOutboundEnvelope = {
    kind: 'ping',
    deliveryId: generateDeliveryId(),
    requestId: generateRequestId(),
    at: nowTs(),
  }
  const record = await registry.getCell(serverId).createRequestAndWait(
    envelope,
    PING_TIMEOUT_MS,
  )

  if (record.status === 'expired') {
    return { ok: false, status: 504, error: 'ping timed out' }
  }

  const sentAt = record.sentAt ?? envelope.at
  const pongAt = record.finishedAt ?? record.expiresAt
  const tripMs = Math.max(0, Date.parse(pongAt) - Date.parse(sentAt))
  return {
    ok: true,
    tripMs,
    sentAt,
    pongAt,
  }
}

export type FetchServerCellSuccess = {
  ok: true
  snapshot: DaemonCellSnapshot
  monitorInstance: MonitorInstanceRow | null
  resources: MonitorResourceRow[]
}

export type FetchServerCellFailure = {
  ok: false
  status: 404 | 503
  error: string
}

export type FetchServerCellResult = FetchServerCellSuccess | FetchServerCellFailure

export async function fetchDaemonServerCell(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string,
): Promise<FetchServerCellResult> {
  if (!registry) {
    return { ok: false, status: 503, error: 'Daemon cell registry unavailable' }
  }

  const presence = await resolveFleetPresence(db, registry, [serverId])
  if (!presence.has(serverId)) {
    return { ok: false, status: 404, error: 'server not found' }
  }

  const cell = registry.getCell(serverId)
  const [snapshot, monitorInstance, resources] = await Promise.all([
    cell.getSnapshot(),
    cell.getMonitorInstance(serverId),
    cell.listMonitorResources(serverId),
  ])

  return { ok: true, snapshot, monitorInstance, resources }
}
