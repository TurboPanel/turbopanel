/**
 * The fleet-wide and single-server "ask the daemon what addresses it sees
 * itself as" round trip, shared verbatim between the admin console
 * (`src/admin/routes.ts`) and the developer console (`src/developer/routes-core.ts`).
 * Both surfaces expose the same two GET routes for the same reason (a manual
 * "what does this daemon think its own IPs are" check) and used to carry two
 * independently hand-written copies of this handler.
 */
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { generateDeliveryId, generateRequestId } from '../../contracts/cell-protocol.ts'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import type { ServerReportedIp } from '../../contracts/server-addresses.ts'
import { getDaemonCellRegistry, getDb } from '../../db/connection.ts'
import { cellTrace } from '../../lib/logger.ts'
import { resolveFleetPresence, resolveOnlineFleetPresence } from './fleet-presence.ts'

const ADDRESSES_TIMEOUT_MS = 10_000

/** A cell response record's `result.ips`, or a thrown reason it can't be read. */
export function extractAddresses(record: { status: string; result?: unknown }): ServerReportedIp[] {
  if (record.status !== 'done') {
    throw new Error(
      record.status === 'expired' ? 'timeout waiting for addresses' : 'failed to fetch addresses'
    )
  }
  const result = record.result as { ips?: ServerReportedIp[] } | undefined
  if (!result?.ips) throw new Error('missing ips in daemon response')
  return result.ips
}

/** `daemon not connected` is the one address-fetch failure worth a 404 over a 500. */
export function addressesFetchErrorStatus(message: string): 404 | 500 {
  return message === 'daemon not connected' ? 404 : 500
}

/** `GET /daemon/addresses` — every connected server's self-reported addresses. */
export async function fetchFleetAddressesRoute(c: Context<AppEnv>): Promise<Response> {
  const registry = getDaemonCellRegistry(c)
  const db = getDb(c)
  if (!registry || !db) return c.json({ servers: [] })
  const online = await resolveOnlineFleetPresence(db, registry)
  const servers = await Promise.all(
    online.map(async (presence) => {
      const serverId = presence.serverId
      const requestId = generateRequestId()
      cellTrace('request-start', { requestId, serverId, kind: 'addresses-request' })
      const envelope: DaemonOutboundEnvelope = {
        kind: 'addresses-request',
        deliveryId: generateDeliveryId(),
        requestId,
        at: new Date().toISOString(),
      }
      cellTrace('request-enqueued', {
        requestId,
        serverId,
        kind: 'addresses-request',
        deliveryId: envelope.deliveryId,
      })
      try {
        const record = await registry
          .getCell(serverId)
          .createRequestAndWait(envelope, ADDRESSES_TIMEOUT_MS)
        if (record.status === 'failed') {
          const error = record.error ?? 'failed to fetch addresses'
          cellTrace('request-result', {
            requestId,
            serverId,
            kind: 'addresses-request',
            pendingStatus: record.status,
            resultStatus: 'failed',
            error,
          })
          return { daemonId: serverId, hostname: presence.hostname, error }
        }
        if (record.status === 'expired') {
          const error = 'timeout waiting for addresses'
          cellTrace('request-result', {
            requestId,
            serverId,
            kind: 'addresses-request',
            pendingStatus: record.status,
            resultStatus: 'timeout',
            error,
          })
          return { daemonId: serverId, hostname: presence.hostname, error }
        }
        const ips = extractAddresses(record)
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'addresses-request',
          pendingStatus: record.status,
          resultStatus: 'done',
        })
        return { daemonId: serverId, hostname: presence.hostname, ips }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        cellTrace('request-result', {
          requestId,
          serverId,
          kind: 'addresses-request',
          resultStatus: 'error',
          error,
        })
        return { daemonId: serverId, hostname: presence.hostname, error }
      }
    })
  )
  return c.json({ servers })
}

/** `GET /daemon/:id/addresses` — one server's self-reported addresses. */
export async function fetchServerAddressesRoute(c: Context<AppEnv>): Promise<Response> {
  const registry = getDaemonCellRegistry(c)
  const db = getDb(c)
  if (!registry || !db) {
    return c.json({ error: 'Daemon cell registry unavailable' }, 503)
  }
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'missing id' }, 400)
  const presence = await resolveFleetPresence(db, registry, [id])
  const live = presence.get(id)
  if (!live?.connected) {
    return c.json({ error: 'daemon not connected' }, 404)
  }
  const requestId = generateRequestId()
  cellTrace('request-start', { requestId, serverId: id, kind: 'addresses-request' })
  try {
    const envelope: DaemonOutboundEnvelope = {
      kind: 'addresses-request',
      deliveryId: generateDeliveryId(),
      requestId,
      at: new Date().toISOString(),
    }
    cellTrace('request-enqueued', {
      requestId,
      serverId: id,
      kind: 'addresses-request',
      deliveryId: envelope.deliveryId,
    })
    const record = await registry.getCell(id).createRequestAndWait(envelope, ADDRESSES_TIMEOUT_MS)
    if (record.status === 'failed') {
      const error = record.error ?? 'failed to fetch addresses'
      cellTrace('request-result', {
        requestId,
        serverId: id,
        kind: 'addresses-request',
        pendingStatus: record.status,
        resultStatus: 'failed',
        error,
      })
      return c.json({ error }, 500)
    }
    if (record.status === 'expired') {
      const error = 'timeout waiting for addresses'
      cellTrace('request-result', {
        requestId,
        serverId: id,
        kind: 'addresses-request',
        pendingStatus: record.status,
        resultStatus: 'timeout',
        error,
      })
      return c.json({ error }, 500)
    }
    const ips = extractAddresses(record)
    cellTrace('request-result', {
      requestId,
      serverId: id,
      kind: 'addresses-request',
      pendingStatus: record.status,
      resultStatus: 'done',
    })
    return c.json({ ok: true, daemonId: id, hostname: live.hostname ?? null, ips })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId: id,
      kind: 'addresses-request',
      resultStatus: 'error',
      error: message,
    })
    return c.json({ error: message }, addressesFetchErrorStatus(message))
  }
}
