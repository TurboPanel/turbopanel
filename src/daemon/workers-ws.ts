import type { Env, Hono } from 'hono'
import type { DaemonJwtKeyring } from './authn/daemon-jwt-keyring.ts'
import { getDb } from '../db/connection.ts'
import { CLIENT_WS_PATH, DAEMON_WS_PATH } from '../app/surfaces.ts'
import { parseCorsOrigins } from '../app/cors.ts'
import { authenticateShellUpgrade } from '../features/terminal/upgrade.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { verifyDaemonJwt } from './authn/daemon-jwt.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../features/servers/server-identity-db.ts'
import { resolveCellLocationHint } from './cell/location.ts'
import { extractCloudflareGeo } from '../features/geo/server-geo.ts'
import type { RateLimiter } from './rate-limit/contracts.ts'
import { daemonConnectRateLimitKey } from './rate-limit/keys.ts'
import { resolvePeerAddress } from '../lib/peer-address.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'
import { refuseUnsignedDaemonUpgrade } from './authn/upgrade-signature.ts'

const CELL_SERVER_ID_HEADER = 'X-Turbopanel-Cell-Server-Id'
const CELL_GEO_HEADER = 'X-Turbopanel-Cell-Geo'
const REAL_IP_HEADER = 'X-Real-IP'
/** `server.trust_level` read at upgrade; the cell refuses an unsigned session at 1 or more. */
export const CELL_TRUST_LEVEL_HEADER = 'X-Turbopanel-Cell-Trust-Level'
/**
 * `<keyId>:<x>` of the server's current daemon key, read at upgrade, so the
 * cell checks the daemon's attach proof without a database read.
 */
export const CELL_DAEMON_KEY_HEADER = 'X-Turbopanel-Cell-Daemon-Key'
/**
 * `1` when `server.trust_reports_signed_at` is set (read at upgrade): the
 * cell refuses this server's unsigned reports on a signed session.
 */
export const CELL_REPORTS_SIGNED_HEADER = 'X-Turbopanel-Cell-Reports-Signed'

/** Who a browser's terminal socket belongs to; stamped by the route, read by the cell. */
export const CELL_SHELL_SID_HEADER = 'X-Turbopanel-Cell-Shell-Sid'
export const CELL_SHELL_USER_HEADER = 'X-Turbopanel-Cell-Shell-User'
export const CELL_SHELL_AUTH_SESSION_HEADER = 'X-Turbopanel-Cell-Shell-AuthSession'

/** Internal headers stamped by the Workers isolate — never pass through from clients. */
const INTERNAL_CELL_FORWARD_HEADERS = [
  CELL_SERVER_ID_HEADER,
  CELL_GEO_HEADER,
  REAL_IP_HEADER,
  CELL_TRUST_LEVEL_HEADER,
  CELL_DAEMON_KEY_HEADER,
  CELL_REPORTS_SIGNED_HEADER,
  // The cell treats a request carrying the sid header as a browser terminal
  // socket, so a daemon's upgrade must never be able to set it.
  CELL_SHELL_SID_HEADER,
  CELL_SHELL_USER_HEADER,
  CELL_SHELL_AUTH_SESSION_HEADER,
] as const

export type WorkersDaemonWebSocketOptions = {
  secrets?: DaemonJwtKeyring
  /** Cloudflare Rate Limit binding adapter — gates reconnect storms before the DO wakes. */
  connectLimiter?: RateLimiter
  /** The control plane identity key; checks a signed upgrade. Null = feature off. */
  panelIdentity?: () => Promise<PanelIdentity | null>
  /** Sign every upgrade, bound token or not. Default true: only tests turn it off. */
  requireSigned?: boolean
}

export function buildWorkersDaemonCellForwardHeaders(
  inbound: Headers,
  options: {
    serverId: string
    cf?: unknown
    cfConnectingIp?: string | null
    trustLevel?: number
    daemonKey?: { id: string; x: string }
    reportsSigned?: boolean
  }
): Headers {
  const headers = new Headers(inbound)
  for (const name of INTERNAL_CELL_FORWARD_HEADERS) {
    headers.delete(name)
  }

  headers.set(CELL_SERVER_ID_HEADER, options.serverId)
  headers.set(CELL_TRUST_LEVEL_HEADER, String(options.trustLevel ?? 0))
  if (options.daemonKey) {
    headers.set(CELL_DAEMON_KEY_HEADER, `${options.daemonKey.id}:${options.daemonKey.x}`)
  }
  if (options.reportsSigned) headers.set(CELL_REPORTS_SIGNED_HEADER, '1')

  const geo = extractCloudflareGeo(options.cf)
  if (geo) {
    headers.set(CELL_GEO_HEADER, JSON.stringify(geo))
  }

  // The edge strips any client-supplied CF-Connecting-IP, so this is the one
  // address a Workers deployment can trust. Same resolver as the Deno
  // transport so both agree on what "peer address" means.
  const peer = resolvePeerAddress(
    { cfConnectingIp: options.cfConnectingIp },
    { runtime: 'workers' }
  )
  if (peer) {
    headers.set(REAL_IP_HEADER, peer.address)
  }

  return headers
}

/**
 * Daemon WebSocket hub for Cloudflare Workers / wrangler dev.
 *
 * Verifies the daemon JWT, then forwards the upgrade request to the per-server
 * Durable Object cell. The native Workers WebSocket lifecycle runs inside the
 * Durable Object (hibernation), so the Postgres presence projection — the
 * equivalent of `onDaemonConnected()` / `onDaemonDisconnected()` and daemon
 * build updates — is driven from `DaemonCellObject` itself rather than here. We stamp
 * the resolved server id onto the forwarded request so the cell resolves its
 * identity consistently across the WS and RPC entry paths.
 */
export function registerWorkersDaemonWebSocket<E extends Env>(
  app: Hono<E>,
  options: WorkersDaemonWebSocketOptions
): void {
  app.get(DAEMON_WS_PATH, async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket', 426)
    }

    const authHeader = c.req.header('authorization')?.trim() ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : ''
    if (!token || !options.secrets) {
      return new Response('Unauthorized', { status: 401 })
    }
    const payload = await verifyDaemonJwt(token, options.secrets)
    if (!payload) {
      return new Response('Unauthorized', { status: 401 })
    }

    const serverId = payload.sub
    if (options.connectLimiter) {
      const { success } = await options.connectLimiter.limit({
        key: daemonConnectRateLimitKey(serverId),
      })
      if (!success) {
        return new Response('Too Many Requests', { status: 429 })
      }
    }

    const db = getDb(c)
    if (db === undefined) {
      return new Response('Database unavailable', { status: 503 })
    }

    // A valid JWT is not enough to open a socket.
    //
    // The token lives for DAEMON_JWT_LIFETIME_MS (15 minutes) and says
    // nothing about whether the key that minted it is still active. Without
    // this check, an operator who revoked a compromised host's daemon key and
    // purged its cell watched that host reconnect with its cached token and
    // keep receiving queued commands and secrets until the token expired —
    // the self-hosted socket re-checks the key on every inbound frame
    // (`deno-ws.ts` assertDaemonKeyStillActive), and hosted checked nothing.
    // The kid in the payload is the daemon key id, so the same row answers
    // both questions: is this still the current key, and is it still active.
    const daemonState = await getServerDaemonStateByServerId(db, serverId)
    if (daemonState?.key.id !== payload.kid || !isDaemonKeyActive(daemonState.key)) {
      return new Response('Forbidden', { status: 403 })
    }

    const refused = await refuseUnsignedDaemonUpgrade({
      db,
      request: c.req.raw,
      serverId,
      cnfJkt: payload.cnf?.jkt,
      state: daemonState,
      requireSigned: options.requireSigned ?? true,
      panelIdentity: options.panelIdentity,
    })
    if (refused) return new Response(refused.error, { status: refused.status })

    const locationHint = await resolveCellLocationHint(db, serverId)
    const logicalName = serverId

    const env = c.env as CloudflareBindings
    const stub = locationHint
      ? env.DAEMON_CELL.getByName(logicalName, {
          locationHint: locationHint as DurableObjectLocationHint,
        })
      : env.DAEMON_CELL.getByName(logicalName)

    const headers = buildWorkersDaemonCellForwardHeaders(c.req.raw.headers, {
      serverId,
      cf: (c.req.raw as Request & { cf?: unknown }).cf,
      cfConnectingIp: c.req.header('CF-Connecting-IP'),
      trustLevel: daemonState.trustLevel ?? 0,
      reportsSigned: daemonState.reportsSigned === true,
      ...(typeof daemonState.key.publicJwk.x === 'string'
        ? { daemonKey: { id: daemonState.key.id, x: daemonState.key.publicJwk.x } }
        : {}),
    })

    return stub.fetch(new Request(c.req.raw, { headers }))
  })
}

export type WorkersShellWebSocketOptions = {
  /** The `shell-ticket` keyring; without it the route answers 503. */
  ticketSecrets?: DerivedSecretsConfig
  /** `TURBOPANEL_UI_CORS_ORIGINS`: UI origins other than the panel's own that may connect. */
  corsOrigins?: string
}

/**
 * Browser terminal socket: `GET /ws/client/v1/shell/:sid`.
 *
 * Checks the ticket and the `Origin`, drops every client-supplied
 * `X-Turbopanel-Cell-*` header, stamps who the socket is for and forwards to
 * the server's cell, which accepts it only against a pending open it holds for
 * this sid. The forwarded protocol offer is rewritten to `tp-shell.v1` alone,
 * so the ticket never reaches the cell.
 */
export function registerWorkersShellWebSocket<E extends Env>(
  app: Hono<E>,
  options: WorkersShellWebSocketOptions
): void {
  app.get(`${CLIENT_WS_PATH}/shell/:sid`, async (c) => {
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

    const db = getDb(c)
    if (db === undefined) return new Response('Database unavailable', { status: 503 })

    const { claims } = verdict
    const locationHint = await resolveCellLocationHint(db, claims.serverId)
    const env = c.env as CloudflareBindings
    const stub = locationHint
      ? env.DAEMON_CELL.getByName(claims.serverId, {
          locationHint: locationHint as DurableObjectLocationHint,
        })
      : env.DAEMON_CELL.getByName(claims.serverId)

    // Nothing the client sent under the cell's header prefix, or its claimed address, survives.
    const headers = new Headers()
    for (const [name, value] of c.req.raw.headers) {
      const lower = name.toLowerCase()
      if (lower.startsWith('x-turbopanel-cell-') || lower === REAL_IP_HEADER.toLowerCase()) continue
      headers.append(name, value)
    }
    headers.set('Sec-WebSocket-Protocol', 'tp-shell.v1')
    headers.set(CELL_SERVER_ID_HEADER, claims.serverId)
    headers.set(CELL_SHELL_SID_HEADER, claims.sid)
    headers.set(CELL_SHELL_USER_HEADER, claims.userId)
    headers.set(CELL_SHELL_AUTH_SESSION_HEADER, claims.authSessionId)
    return stub.fetch(new Request(c.req.raw, { headers }))
  })
}
