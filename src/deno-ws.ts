import type { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/deno'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import {
  createDaemonWebSocketSession,
  type DaemonWebSocketOptions,
} from './daemon-ws-handlers.ts'
import {
  CLIENT_WS_PATH,
  DAEMON_WS_PATH,
  DEVELOPER_WS_PATH,
} from './surfaces.ts'

export function registerDaemonWebSocket(
  app: Hono,
  options: DaemonWebSocketOptions = {},
): void {
  app.get(
    DAEMON_WS_PATH,
    upgradeWebSocket((c) => {
      let session: ReturnType<typeof createDaemonWebSocketSession> | undefined
      return {
        onOpen(_event, ws) {
          session = createDaemonWebSocketSession(c, ws, options)
        },
        onMessage(event, ws) {
          session?.onMessage(event, ws)
        },
        onClose() {
          session?.onClose()
        },
        onError() {
          session?.onError()
        },
      }
    }),
  )

  if (options.developerSurface) {
    registerStubWebSocket(app, DEVELOPER_WS_PATH, 'developer')
  }
  registerStubWebSocket(app, CLIENT_WS_PATH, 'client')
}

/**
 * Placeholder WebSocket surface for the admin/client UIs. Today the UIs poll
 * REST; these endpoints reserve the namespace for future live streaming. They
 * accept the upgrade, greet the peer, and otherwise idle.
 */
function registerStubWebSocket(app: Hono, path: string, surface: string): void {
  app.get(
    path,
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        ws.send(JSON.stringify({
          type: 'hello',
          surface,
          at: new Date().toISOString(),
        }))
      },
    })),
  )
}

export type { DaemonWebSocketOptions }
