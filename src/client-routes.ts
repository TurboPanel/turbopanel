import { Hono } from 'hono'
import { CLIENT_API_PREFIX } from './surfaces.ts'

/**
 * Client (end-user UI) surface. Greenfield — no client features exist yet, so
 * this only exposes a stub status endpoint to establish the namespace.
 * Mounted under {@link CLIENT_API_PREFIX} (`/api/client/v1`).
 */
export function registerClientRoutes(app: Hono) {
  const client = new Hono()

  client.get('/status', (c) => c.json({ ok: true, surface: 'client' }))

  app.route(CLIENT_API_PREFIX, client)
  return app
}
