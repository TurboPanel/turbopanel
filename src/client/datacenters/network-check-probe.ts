import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
  MAX_DAEMON_WS_NETWORK_CHECK_TARGETS,
  type ServerNetworkCheckEntry,
  type ServerNetworkCheckTarget,
} from '../../contracts/cell-protocol.ts'
import type { NetworkCheckServerOutcome } from '../../features/net/server-network-check.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'
import { cellTrace } from '../../lib/logger.ts'
import { SERVER_NETWORK_CHECK_FEATURE } from '../../lib/version-wire.ts'
import { loadServerStatusRecords } from '../servers/update-status.ts'

/**
 * Ask one host to try its peers (a correlated cell round trip; nothing is
 * stored). Never throws and never waits past `timeoutMs`. Sends nothing to a
 * daemon that does not advertise `server-network-check-v1`: that server reads
 * as "not tested", which never blocks saving.
 */

/** Each target is cut off after 3 s on the host; the screen waits a little longer. */
export const NETWORK_CHECK_PROBE_TIMEOUT_MS = 10_000

/** Seams for hostfree tests; production wires the defaults. */
export type NetworkCheckProbeDeps = {
  isServerConnected?: (serverId: string) => Promise<boolean>
  daemonFeatures?: (serverId: string) => Promise<readonly string[]>
}

function isEntry(value: unknown): value is ServerNetworkCheckEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.peerServerId === 'string' &&
    typeof e.address === 'string' &&
    typeof e.reachable === 'boolean'
  )
}

export async function probeServerNetworkCheck(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  params: { serverId: string; targets: ServerNetworkCheckTarget[]; timeoutMs: number },
  deps: NetworkCheckProbeDeps = {}
): Promise<NetworkCheckServerOutcome> {
  if (!registry) return { status: 'not_tested', reason: 'error' }
  if (params.targets.length > MAX_DAEMON_WS_NETWORK_CHECK_TARGETS) {
    return { status: 'not_tested', reason: 'error' }
  }
  const daemonFeatures =
    deps.daemonFeatures ??
    (async (serverId: string) => {
      const state = await getServerDaemonStateByServerId(db, serverId)
      return state?.projection?.features ?? []
    })
  const isServerConnected =
    deps.isServerConnected ??
    (async (serverId: string) => {
      const records = await loadServerStatusRecords(db, registry, [serverId])
      return records[0]?.connected === true
    })

  const requestId = generateRequestId()
  try {
    const features = await daemonFeatures(params.serverId)
    if (!features.includes(SERVER_NETWORK_CHECK_FEATURE)) {
      return { status: 'not_tested', reason: 'daemon_update_required' }
    }
    if (!(await isServerConnected(params.serverId))) {
      return { status: 'not_tested', reason: 'offline' }
    }
    const envelope: DaemonOutboundEnvelope = {
      kind: 'server-network-check-request',
      deliveryId: generateDeliveryId(),
      requestId,
      targets: params.targets,
      at: new Date().toISOString(),
    }
    cellTrace('request-start', {
      requestId,
      serverId: params.serverId,
      kind: 'server-network-check-request',
    })
    const record = await registry
      .getCell(params.serverId)
      .createRequestAndWait(envelope, params.timeoutMs)
    if (record.status === 'expired') return { status: 'not_tested', reason: 'timeout' }
    const result = record.result as { ok?: unknown; results?: unknown } | null
    if (record.status === 'failed' || result?.ok !== true) {
      return { status: 'not_tested', reason: 'error' }
    }
    if (!Array.isArray(result.results) || !result.results.every(isEntry)) {
      return { status: 'not_tested', reason: 'error' }
    }
    return { status: 'checked', results: result.results }
  } catch (err) {
    cellTrace('request-result', {
      requestId,
      serverId: params.serverId,
      kind: 'server-network-check-request',
      resultStatus: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
    return { status: 'not_tested', reason: 'error' }
  }
}
