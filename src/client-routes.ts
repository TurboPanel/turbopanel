import { Hono } from 'hono'
import { registerAuthRoutes, type AuthRouteOpts } from './auth/http.ts'
import { createSessionMiddleware } from './auth/middleware.ts'
import { CLIENT_API_PREFIX } from './surfaces.ts'

/**
 * Client (end-user UI) surface. Greenfield — no client features exist yet, so
 * this only exposes a stub status endpoint to establish the namespace.
 * Mounted under {@link CLIENT_API_PREFIX} (`/api/client/v1`).
 */
export function registerClientRoutes(app: Hono, opts: AuthRouteOpts) {
  const client = new Hono()

  registerAuthRoutes(client, opts)
  client.use('/*', createSessionMiddleware(opts.sessionSecret))

  client.get('/status', (c) => c.json({ ok: true, surface: 'client' }))

  app.route(CLIENT_API_PREFIX, client)
  return app
}
