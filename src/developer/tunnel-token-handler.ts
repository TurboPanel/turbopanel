import type { Context } from 'hono'
import { getDaemonCellRegistry, getDb } from '../db/connection.ts'
import type { SecretsConfig } from '../lib/secrets/secrets.ts'
import { dispatchInstanceTunnelToken, parseTunnelTokenBody } from './tunnel-token.ts'

/**
 * Shared HTTP handler for the developer route and the self-hosted admin route:
 * parse the body, resolve the database and cell registry, dispatch, answer.
 */
export async function handleTunnelTokenRequest(c: Context): Promise<Response> {
  const body = await c.req.json().catch(() => null)
  const parsed = parseTunnelTokenBody(body)
  if (!parsed.ok) {
    return c.json({ ok: false, error: 'expected { token: string }' }, 400)
  }
  const db = getDb(c)
  if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
  const registry = getDaemonCellRegistry(c)
  if (!registry) {
    return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
  }
  const result = await dispatchInstanceTunnelToken({
    db,
    registry,
    token: parsed.token,
    secretsConfig: c.get('secretsConfig') as SecretsConfig | undefined,
  })
  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, result.status)
  }
  return c.json({ ok: true })
}
