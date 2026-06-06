import type { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/deno'
import {
  type DaemonMessage,
  parseDaemonMessage,
  recordCommandResult,
  recordDaemonMessage,
  registerDaemon,
  unregisterDaemon,
} from './daemon-hub.ts'
import { getDaemonCommit } from './daemon-version.ts'

export function registerDaemonWebSocket(app: Hono) {
  app.get(
    '/ws',
    upgradeWebSocket(() => {
      let connId: string | undefined
      let pingTimer: ReturnType<typeof setInterval> | undefined

      return {
        onOpen(_event, ws) {
          const conn = registerDaemon((data) => ws.send(data))
          connId = conn.id
          console.log(`[ws] daemon connected: ${conn.id}`)

          const hello: DaemonMessage = {
            type: 'hello',
            from: 'instance',
            at: new Date().toISOString(),
          }
          recordDaemonMessage(conn.id, 'out', hello)
          ws.send(JSON.stringify(hello))

          // Tell the daemon which commit it should be running, so it can
          // self-update if its checkout has drifted from this host's.
          void getDaemonCommit().then((version) => {
            if (ws.readyState !== WebSocket.OPEN) return
            const message: DaemonMessage = {
              type: 'version',
              commit: version.commit,
              branch: version.branch,
              at: new Date().toISOString(),
            }
            if (connId) recordDaemonMessage(connId, 'out', message)
            ws.send(JSON.stringify(message))
          }).catch((err) => {
            console.warn(
              '[ws] failed to send version:',
              err instanceof Error ? err.message : err,
            )
          })

          pingTimer = setInterval(() => {
            const ping: DaemonMessage = {
              type: 'ping',
              id: crypto.randomUUID(),
              at: new Date().toISOString(),
            }
            ws.send(JSON.stringify(ping))
          }, 15_000)
        },

        onMessage(event, ws) {
          const raw = typeof event.data === 'string'
            ? event.data
            : String(event.data)
          const message = parseDaemonMessage(raw)
          if (!message) {
            console.warn('[ws] ignored non-JSON message from daemon')
            return
          }

          console.log(`[ws] from ${connId ?? 'unknown'}:`, message.type)
          if (connId) recordDaemonMessage(connId, 'in', message)

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
        },

        onClose() {
          if (pingTimer) clearInterval(pingTimer)
          if (connId) {
            unregisterDaemon(connId)
            console.log(`[ws] daemon disconnected: ${connId}`)
          }
        },

        onError(_event) {
          if (pingTimer) clearInterval(pingTimer)
          if (connId) unregisterDaemon(connId)
        },
      }
    }),
  )
}
