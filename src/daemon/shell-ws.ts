import type { Env, Hono } from 'hono'
import { upgradeWebSocket } from 'hono/deno'
import { parseCorsOrigins } from '../app/cors.ts'
import { CLIENT_WS_PATH } from '../app/surfaces.ts'
import { SHELL_PROTOCOL } from '../contracts/shell-relay.ts'
import { authenticateShellUpgrade } from '../features/terminal/upgrade.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import type { ShellHub } from './shell-hub.ts'

export type ShellWebSocketOptions = {
  hub: ShellHub
  /** The `shell-ticket` keyring; without it the route answers 503. */
  ticketSecrets?: DerivedSecretsConfig
  /** `TURBOPANEL_UI_CORS_ORIGINS`: UI origins other than the panel's own that may connect. */
  corsOrigins?: string
}

/**
 * Browser terminal socket on the self-hosted runtime: `GET /ws/client/v1/shell/:sid`.
 *
 * The same rules as the Workers route: an `Origin` the panel trusts and the
 * one-time ticket in `Sec-WebSocket-Protocol`, then the hub accepts the socket
 * only against the pending open it holds for this sid, for the user and auth
 * session the ticket names. The chosen subprotocol is `tp-shell.v1` alone.
 */
export function registerShellWebSocket<E extends Env>(
  app: Hono<E>,
  options: ShellWebSocketOptions
): void {
  app.get(`${CLIENT_WS_PATH}/shell/:sid`, async (c, next) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket', 426)
    }
    if (!options.ticketSecrets) return new Response('Service Unavailable', { status: 503 })
    const verdict = await authenticateShellUpgrade({
      sid: c.req.param('sid'),
      origin: c.req.header('Origin'),
      protocolHeader: c.req.header('Sec-WebSocket-Protocol'),
      requestUrl: c.req.url,
      configuredOrigins: parseCorsOrigins(options.corsOrigins),
      keyring: options.ticketSecrets,
    })
    if (!verdict.ok) return new Response('Refused', { status: verdict.status })

    const { claims } = verdict
    const claim = options.hub.claim(claims.sid, claims.userId, claims.authSessionId)
    if (!claim.ok)
      return new Response(claim.status === 410 ? 'Gone' : 'Refused', { status: claim.status })

    const { hub } = options
    const sid = claim.pending.sid
    // Messages are handled in arrival order even when one needs an async read.
    let queue: Promise<void> = Promise.resolve()
    return upgradeWebSocket(
      () => ({
        onOpen(_event, ws) {
          if (ws.raw) ws.raw.binaryType = 'arraybuffer'
          hub.activate(claim.pending, {
            send: (data) => ws.send(data),
            close: (code, reason) => ws.close(code, reason),
          })
        },
        onMessage(event) {
          const data = event.data
          queue = queue
            .then(async () => {
              if (typeof data === 'string') return hub.onBrowserMessage(sid, data)
              const buffer = data instanceof Blob ? await data.arrayBuffer() : data
              hub.onBrowserMessage(sid, buffer as ArrayBuffer)
            })
            .catch(() => undefined)
        },
        onClose() {
          void hub.onBrowserClosed(sid)
        },
        onError() {
          void hub.onBrowserClosed(sid)
        },
      }),
      { protocol: SHELL_PROTOCOL }
    )(c, next)
  })
}
