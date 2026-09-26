import { resolveColocatedServerId } from '../client/authn/install-state.ts'
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../contracts/cell-protocol.ts'
import type { Db } from '../db/connection.ts'
import { cellTrace } from '../lib/logger.ts'
import { encryptSecretForDaemon } from '../lib/secrets/data-encryption.ts'
import type { SecretsConfig } from '../lib/secrets/secrets.ts'
import {
  type InstanceSecretSealing,
  InstanceSecretSealingError,
  resolveInstanceSecretSealing,
} from '../features/install/instance-secret-sealing.ts'

const TUNNEL_TOKEN_TIMEOUT_MS = 30_000

export function parseTunnelTokenBody(
  body: unknown,
): { ok: true; token: string } | { ok: false } {
  if (!body || typeof body !== 'object') {
    return { ok: false }
  }
  const token = (body as { token?: unknown }).token
  if (typeof token !== 'string') {
    return { ok: false }
  }
  return { ok: true, token }
}

export type TunnelTokenDispatch =
  | { ok: true }
  | { ok: false; status: 503 | 500; error: string }

/**
 * Push a tunnel token to the co-located daemon. An empty token tears the
 * tunnel down. Shared by the developer route and the admin Access route.
 * A daemon that advertises `sealed-instance-secrets-v1` receives a non-empty
 * token only as a `tpdaemon` envelope, so the cell outbox never holds it.
 */
export async function dispatchInstanceTunnelToken(params: {
  db: Db
  registry: DaemonCellRegistry
  token: string
  secretsConfig: SecretsConfig | undefined
}): Promise<TunnelTokenDispatch> {
  const serverId = await resolveColocatedServerId(params.db, params.registry)
  if (!serverId) {
    return {
      ok: false,
      status: 503,
      error: 'no co-located daemon connected to run the tunnel',
    }
  }

  const snapshots = await params.registry.getSnapshots([serverId])
  if (!snapshots.get(serverId)?.connected) {
    return { ok: false, status: 503, error: 'co-located daemon disconnected' }
  }

  let sealing: InstanceSecretSealing | null
  try {
    sealing = await resolveInstanceSecretSealing(params.db, serverId, params.secretsConfig)
  } catch (err) {
    if (err instanceof InstanceSecretSealingError) {
      return { ok: false, status: 503, error: err.message }
    }
    throw err
  }

  return await sendInstanceTunnelToken(params.registry, serverId, params.token, sealing)
}

/** The token field(s) for the envelope: sealed when possible, never both. */
async function tunnelTokenFields(
  token: string,
  sealing: InstanceSecretSealing | null,
): Promise<{ token: string } | { tokenEnvelope: string }> {
  // The empty teardown token carries no secret; every daemon reads it as-is.
  if (!sealing || token === '') return { token }
  return {
    tokenEnvelope: await encryptSecretForDaemon(sealing.secretsConfig, sealing.recipient, token),
  }
}

/** Enqueue the `tunnel-token` request on the server's cell and wait for the daemon. */
export async function sendInstanceTunnelToken(
  registry: DaemonCellRegistry,
  serverId: string,
  token: string,
  sealing: InstanceSecretSealing | null,
): Promise<TunnelTokenDispatch> {
  const requestId = generateRequestId()
  cellTrace('request-start', {
    requestId,
    serverId,
    kind: 'tunnel-token',
  })
  const envelope: DaemonOutboundEnvelope = {
    kind: 'tunnel-token',
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    ...(await tunnelTokenFields(token, sealing)),
  }
  cellTrace('request-enqueued', {
    requestId,
    serverId,
    kind: 'tunnel-token',
    deliveryId: envelope.deliveryId,
  })

  try {
    const record = await registry.getCell(serverId).createRequestAndWait(
      envelope,
      TUNNEL_TOKEN_TIMEOUT_MS,
    )
    return tunnelTokenRecordResult(requestId, serverId, record.status, record.error)
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'tunnel-token',
      resultStatus: 'error',
      error: errMessage,
    })
    return { ok: false, status: 500, error: errMessage }
  }
}

function tunnelTokenRecordResult(
  requestId: string,
  serverId: string,
  status: string,
  error: string | null | undefined,
): TunnelTokenDispatch {
  if (status === 'done') {
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'tunnel-token',
      pendingStatus: status,
      resultStatus: 'done',
    })
    return { ok: true }
  }
  if (status === 'failed') {
    const message = error ?? 'daemon reported failure'
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'tunnel-token',
      pendingStatus: status,
      resultStatus: 'failed',
      error: message,
    })
    return { ok: false, status: 500, error: message }
  }
  const timeout = 'timeout waiting for daemon acknowledgement'
  cellTrace('request-result', {
    requestId,
    serverId,
    kind: 'tunnel-token',
    pendingStatus: status,
    resultStatus: 'timeout',
    error: timeout,
  })
  return { ok: false, status: 500, error: timeout }
}
