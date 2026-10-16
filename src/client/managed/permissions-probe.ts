import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import {
  type DaemonOutboundEnvelope,
  generateDeliveryId,
  generateRequestId,
} from '../../contracts/cell-protocol.ts'
import {
  type ManagedPermissionsObserved,
  parseManagedPermissionsObserved,
} from '../../features/managed/privileges/observed.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'
import { cellTrace } from '../../lib/logger.ts'
import { MANAGED_PERMISSIONS_READ_FEATURE } from '../../lib/version-wire.ts'
import { loadServerStatusRecords } from '../servers/update-status.ts'

/**
 * Read a cluster's logins' current permissions from the host that runs it
 * (a correlated cell round trip, not a command, nothing is stored).
 *
 * Read only: the host runs `SELECT` and `SHOW` statements. Never throws and
 * never waits past `timeoutMs`. Sends nothing to a daemon that does not
 * advertise `managed-permissions-read-v1`.
 */

/** The operator is looking at a screen: a short wait, then an honest "try again". */
export const MANAGED_PERMISSIONS_PROBE_TIMEOUT_MS = 15_000

export type ManagedPermissionsProbeParams = {
  serverId: string
  managedId: string
  engine: string
  logins: string[]
  databases: string[]
  timeoutMs: number
}

export type ManagedPermissionsProbeOutcome =
  | { status: 'observed'; permissions: ManagedPermissionsObserved }
  | { status: 'unsupported' }
  | {
      status: 'unavailable'
      reason: 'no_registry' | 'offline' | 'timeout' | 'daemon_error' | 'invalid_result' | 'error'
      error?: string
    }

/** Seams for hostfree tests; production wires the defaults. */
export type ManagedPermissionsProbeDeps = {
  isServerConnected?: (serverId: string) => Promise<boolean>
  daemonFeatures?: (serverId: string) => Promise<readonly string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function probeManagedPermissions(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  params: ManagedPermissionsProbeParams,
  deps: ManagedPermissionsProbeDeps = {}
): Promise<ManagedPermissionsProbeOutcome> {
  if (!registry) return { status: 'unavailable', reason: 'no_registry' }

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
    if (!features.includes(MANAGED_PERMISSIONS_READ_FEATURE)) return { status: 'unsupported' }
    if (!(await isServerConnected(params.serverId))) {
      return { status: 'unavailable', reason: 'offline' }
    }

    const envelope: DaemonOutboundEnvelope = {
      kind: 'managed-permissions-request',
      deliveryId: generateDeliveryId(),
      requestId,
      managedId: params.managedId,
      engine: params.engine,
      logins: params.logins,
      databases: params.databases,
      at: new Date().toISOString(),
    }
    cellTrace('request-start', {
      requestId,
      serverId: params.serverId,
      kind: 'managed-permissions-request',
    })
    const record = await registry
      .getCell(params.serverId)
      .createRequestAndWait(envelope, params.timeoutMs)
    cellTrace('request-result', {
      requestId,
      serverId: params.serverId,
      kind: 'managed-permissions-request',
      pendingStatus: record.status,
    })

    if (record.status === 'expired') return { status: 'unavailable', reason: 'timeout' }
    if (record.status === 'failed') {
      return { status: 'unavailable', reason: 'daemon_error', error: record.error ?? undefined }
    }
    const result = record.result
    const permissions =
      isRecord(result) && result.ok === true
        ? parseManagedPermissionsObserved(result.permissions)
        : null
    if (!permissions) return { status: 'unavailable', reason: 'invalid_result' }
    return { status: 'observed', permissions }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId: params.serverId,
      kind: 'managed-permissions-request',
      resultStatus: 'error',
      error: message,
    })
    return { status: 'unavailable', reason: 'error', error: message }
  }
}
