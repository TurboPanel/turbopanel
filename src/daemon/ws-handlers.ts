import type { WSContext } from 'hono/ws'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import {
  type DaemonMessage,
  evictDuplicateDaemons,
  parseDaemonMessage,
  pruneStaleDaemons,
  recordAddressesResult,
  recordCommandResult,
  recordDaemonAck,
  recordDaemonMessage,
  registerDaemon,
  setDaemonHostname,
  setDaemonServerId,
  setDaemonRemoteAddress,
  touchDaemonInbound,
  unregisterDaemon,
} from './hub.ts'
import type { Db } from '../db.ts'
import { tryAssignColocatedDaemonToInstalledOrganization } from '../client/authn/install-state.ts'
import { resolveServerId } from '../server-registry.ts'
import { compatLogError, compatLogInfo, compatLogWarn } from '../log-compat.ts'

let pruneTimer: ReturnType<typeof setInterval> | undefined

function runPruneCycle(): void {
  const pruned = pruneStaleDaemons()
  if (pruned.length > 0) {
    compatLogInfo('ws', `pruned ${pruned.length} stale daemon connection(s): ${pruned.join(', ')}`)
  }
}

function ensurePruneTimer(): void {
  if (pruneTimer) return
  pruneTimer = setInterval(runPruneCycle, 15_000)
}

export type DaemonWebSocketOptions = {
  developerSurface?: boolean
  db?: Db
  secrets?: DerivedSecretsConfig
}

export type DaemonWebSocketSession = {
  onMessage: (event: MessageEvent, ws: WSContext) => void
  onClose: () => void
  onError: () => void
}

export type DaemonWebSocketConnectMeta = {
  /** From X-Real-IP / X-Forwarded-For; omit for direct Unix-socket dials. */
  remoteAddress?: string
}

/** Shared daemon hub logic for Deno and Workers WebSocket upgrades. */
export function createDaemonWebSocketSession(
  ws: WSContext,
  { db }: DaemonWebSocketOptions = {},
  { remoteAddress }: DaemonWebSocketConnectMeta = {},
): DaemonWebSocketSession {
  let connId: string | undefined
  let identityAddress = remoteAddress ?? '__direct__'
  let pingTimer: ReturnType<typeof setInterval> | undefined

  ensurePruneTimer()
  const conn = registerDaemon(
    (data) => ws.send(data),
    () => ws.close(),
  )
  connId = conn.id
  identityAddress = remoteAddress ?? '__direct__'
  setDaemonRemoteAddress(conn.id, identityAddress)
  compatLogInfo(
    'ws',
    `daemon connected: ${conn.id}${
      remoteAddress ? ` from ${remoteAddress}` : ''
    }`,
  )

  const hello: DaemonMessage = {
    type: 'hello',
    from: 'instance',
    at: new Date().toISOString(),
  }
  recordDaemonMessage(conn.id, 'out', hello)
  ws.send(JSON.stringify(hello))

  pingTimer = setInterval(() => {
    const ping: DaemonMessage = {
      type: 'ping',
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
    }
    ws.send(JSON.stringify(ping))
  }, 15_000)

  const onMessage = (event: MessageEvent, ws: WSContext) => {
    const raw = typeof event.data === 'string'
      ? event.data
      : String(event.data)
    const message = parseDaemonMessage(raw)
    if (!message) {
      compatLogWarn('ws', 'ignored non-JSON message from daemon')
      return
    }

    compatLogInfo('ws', `from ${connId ?? 'unknown'}: ${message.type}`)
    if (connId) {
      touchDaemonInbound(connId)
      recordDaemonMessage(connId, 'in', message)
    }

    if (message.type === 'hello' && message.from === 'daemon' && connId) {
      const socketId = connId
      void (async () => {
        if (message.hostname) setDaemonHostname(socketId, message.hostname)

        let serverId: string | null = null
        if (db) {
          try {
            serverId = await resolveServerId(db, {
              serverId: message.serverId,
              machineId: message.machineId,
              hostname: message.hostname,
              licenseId: message.licenseId,
              licenseToken: message.licenseToken,
            })

            if (!serverId && message.licenseId) {
              compatLogWarn(
                'ws',
                `rejected daemon ${socketId}: invalid or revoked license ${message.licenseId}`,
              )
              ws.close(4401, 'invalid license')
              return
            }

            if (serverId) {
              connId = setDaemonServerId(socketId, serverId)
            }
          } catch (err) {
            compatLogError('ws', `failed to resolve server id: ${err}`)
          }
        } else {
          compatLogWarn('ws', 'no database configured — server id not assigned')
        }

        const activeId = connId ?? socketId
        const evicted = evictDuplicateDaemons(activeId, {
          hostname: message.hostname,
          serverId: serverId ?? undefined,
          remoteAddress: identityAddress,
        })
        if (evicted.length > 0) {
          compatLogInfo(
            'ws',
            `evicted ${evicted.length} duplicate connection(s) for ${
              serverId ?? message.hostname ?? activeId
            }`,
          )
        }

        if (serverId) {
          const ack: DaemonMessage = {
            type: 'hello',
            from: 'instance',
            serverId,
            at: new Date().toISOString(),
          }
          recordDaemonMessage(activeId, 'out', ack)
          ws.send(JSON.stringify(ack))
          compatLogInfo('ws', `daemon server id: ${serverId} (${activeId})`)

          if (db && identityAddress === '__direct__') {
            try {
              await tryAssignColocatedDaemonToInstalledOrganization(db)
            } catch (err) {
              compatLogError('ws', `failed to assign colocated server: ${err}`)
            }
          }
        }

        if (message.hostname) {
          compatLogInfo('ws', `daemon hostname: ${message.hostname} (${activeId})`)
        }
      })()
    }

    if (message.type === 'ping') {
      const pong: DaemonMessage = {
        type: 'pong',
        id: message.id,
        at: new Date().toISOString(),
      }
      if (connId) recordDaemonMessage(connId, 'out', pong)
      ws.send(JSON.stringify(pong))
    }

    if (message.type === 'command-result') {
      recordCommandResult(message)
    }

    if (message.type === 'addresses-result') {
      recordAddressesResult(message)
    }

    if (
      message.type === 'dev-sync-result' ||
      message.type === 'tunnel-token-result' ||
      message.type === 'update-result'
    ) {
      recordDaemonAck(message.id, message.ok, message.error)
    }
  }

  const cleanup = () => {
    if (pingTimer) clearInterval(pingTimer)
    if (connId) {
      unregisterDaemon(connId)
      compatLogInfo('ws', `daemon disconnected: ${connId}`)
    }
  }

  return {
    onMessage,
    onClose: cleanup,
    onError: cleanup,
  }
}
