import type { Hono } from 'hono'
import { WSContext } from 'hono/ws'
import {
  createDaemonWebSocketSession,
  type DaemonWebSocketOptions,
} from './daemon-ws-handlers.ts'
import { DAEMON_WS_PATH } from './surfaces.ts'

/**
 * Daemon WebSocket hub for Cloudflare Workers / wrangler dev.
 *
 * The Hono Cloudflare adapter omits `onOpen`, so we wire the shared session
 * handler directly after `WebSocketPair` accept.
 */
export function registerWorkersDaemonWebSocket(
  app: Hono,
  options: DaemonWebSocketOptions = {},
): void {
  app.get(DAEMON_WS_PATH, async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket', 426)
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()

    const ws = new WSContext({
      close: (code, reason) => server.close(code, reason),
      get protocol() {
        return server.protocol
      },
      raw: server,
      get readyState() {
        return server.readyState
      },
      url: server.url ? new URL(server.url) : null,
      send: (source) => server.send(source),
    })

    const remoteAddress = c.req.header('x-real-ip')?.trim() ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    const session = createDaemonWebSocketSession(ws, options, { remoteAddress })
    server.addEventListener('message', (evt) => session.onMessage(evt, ws))
    server.addEventListener('close', () => session.onClose())
    server.addEventListener('error', () => session.onError())

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  })
}
