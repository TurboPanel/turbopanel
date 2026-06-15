import type { Context } from 'hono'
import type { WSContext } from 'hono/ws'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
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
} from './daemon-hub.ts'
import type { Db } from './db.ts'
import { tryAssignColocatedDaemonToInstalledOrganization } from './auth/install-state.ts'
import { resolveServerId } from './server-registry.ts'

let pruneTimer: ReturnType<typeof setInterval> | undefined

function runPruneCycle(): void {
  const pruned = pruneStaleDaemons()
  if (pruned.length > 0) {
    console.log(`[ws] pruned ${pruned.length} stale daemon connection(s): ${pruned.join(', ')}`)
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

/** Shared daemon hub logic for Deno and Workers WebSocket upgrades. */
export function createDaemonWebSocketSession(
  c: Context,
  ws: WSContext,
  { db }: DaemonWebSocketOptions = {},
): DaemonWebSocketSession {
  const remoteAddress = c.req.header('x-real-ip')?.trim() ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
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
  console.log(
    `[ws] daemon connected: ${conn.id}${
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
      console.warn('[ws] ignored non-JSON message from daemon')
      return
    }

    console.log(`[ws] from ${connId ?? 'unknown'}:`, message.type)
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
            })
            if (serverId) {
              connId = setDaemonServerId(socketId, serverId)
            }
          } catch (err) {
            console.error('[ws] failed to resolve server id:', err)
          }
        } else {
          console.warn('[ws] no database configured — server id not assigned')
        }

        const activeId = connId ?? socketId
        const evicted = evictDuplicateDaemons(activeId, {
          hostname: message.hostname,
          serverId: serverId ?? undefined,
          remoteAddress: identityAddress,
        })
        if (evicted.length > 0) {
          console.log(
            `[ws] evicted ${evicted.length} duplicate connection(s) for ${
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
          console.log(`[ws] daemon server id: ${serverId} (${activeId})`)

          if (db && identityAddress === '__direct__') {
            try {
              await tryAssignColocatedDaemonToInstalledOrganization(db)
            } catch (err) {
              console.error('[ws] failed to assign colocated server:', err)
            }
          }
        }

        if (message.hostname) {
          console.log(`[ws] daemon hostname: ${message.hostname} (${activeId})`)
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
      message.type === 'tunnel-token-result'
    ) {
      recordDaemonAck(message.id, message.ok, message.error)
    }
  }

  const cleanup = () => {
    if (pingTimer) clearInterval(pingTimer)
    if (connId) {
      unregisterDaemon(connId)
      console.log(`[ws] daemon disconnected: ${connId}`)
    }
  }

  return {
    onMessage,
    onClose: cleanup,
    onError: cleanup,
  }
}
