import type { Hono } from 'hono'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import { getDb } from '../db.ts'
import { DAEMON_WS_PATH } from '../surfaces.ts'
import { getServerDaemonKeyByServerId } from './authn/server-identity-db.ts'
import { verifyDaemonJwt } from './authn/daemon-jwt.ts'
import {
  resolveCellGeneration,
  resolveCellLocationHint,
} from './cell/location.ts'

export type WorkersDaemonWebSocketOptions = {
  secrets?: DerivedSecretsConfig
}

/**
 * Daemon WebSocket hub for Cloudflare Workers / wrangler dev.
 *
 * Verifies the daemon JWT, then forwards the raw upgrade request
 * to the per-server Durable Object cell.
 */
export function registerWorkersDaemonWebSocket(
  app: Hono,
  options: WorkersDaemonWebSocketOptions,
): void {
  app.get(DAEMON_WS_PATH, async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('Expected WebSocket', 426)
    }

    const authHeader = c.req.header('authorization')?.trim() ?? ''
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : ''
    if (!token || !options.secrets) {
      return new Response('Unauthorized', { status: 401 })
    }
    const payload = await verifyDaemonJwt(token, options.secrets)
    if (!payload) {
      return new Response('Unauthorized', { status: 401 })
    }

    const db = getDb(c)
    if (db === undefined) {
      return new Response('Database unavailable', { status: 503 })
    }

    const keyRow = await getServerDaemonKeyByServerId(db, payload.sub)
    if (
      !keyRow ||
      keyRow.daemonKeyId !== payload.kid ||
      keyRow.daemonKeyRevokedAt !== null
    ) {
      return new Response('Unauthorized', { status: 401 })
    }

    const serverId = payload.sub
    const [locationHint, generation] = await Promise.all([
      resolveCellLocationHint(db, serverId),
      resolveCellGeneration(db, serverId),
    ])
    const logicalName = generation > 1 ? `${serverId}:g${generation}` : serverId

    const env = c.env as CloudflareBindings
    const stub = locationHint
      ? env.DAEMON_CELL.getByName(logicalName, {
        locationHint: locationHint as DurableObjectLocationHint,
      })
      : env.DAEMON_CELL.getByName(logicalName)

    return stub.fetch(c.req.raw)
  })
}
