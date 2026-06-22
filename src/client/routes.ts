import { Hono } from 'hono'
import { registerAuthRoutes, type AuthRouteOpts } from './authn/http.ts'
import { registerAccessRoutes } from './access/routes.ts'
import { registerEnvironmentRoutes } from './environments/routes.ts'
import { registerHostingRoutes } from './hostings/routes.ts'
import { registerLicenseRoutes } from './licenses/routes.ts'
import { registerProjectRoutes } from './projects/routes.ts'
import { registerServerRoutes } from './servers/routes.ts'
import { registerServiceRoutes } from './services/routes.ts'
import { registerTeamRoutes } from './teams/routes.ts'
import { registerWorkspaceRoutes } from './workspaces/routes.ts'
import { getClientOpenApiSpec } from './openapi/index.ts'
import { buildClientScalarHtml } from '../scalar-html.ts'
import { CLIENT_API_PREFIX } from '../surfaces.ts'

/**
 * Client (end-user UI) surface. Auth routes plus org-scoped resources for the
 * signed-in user (e.g. servers assigned to their organization).
 * Mounted under {@link CLIENT_API_PREFIX} (`/api/client/v1`).
 */
export function registerClientRoutes(app: Hono, opts: AuthRouteOpts) {
  const client = new Hono()

  registerAuthRoutes(client, opts)

  client.get('/status', (c) => c.json({ ok: true, surface: 'client' }))

  registerServerRoutes(client, opts)
  registerLicenseRoutes(client, opts)
  registerAccessRoutes(client, opts)
  registerWorkspaceRoutes(client, opts)
  registerEnvironmentRoutes(client, opts)
  registerProjectRoutes(client, opts)
  registerServiceRoutes(client, opts)
  registerHostingRoutes(client, opts)
  registerTeamRoutes(client, opts)

  client.get('/openapi.json', (c) => {
    const origin = new URL(c.req.url).origin
    return c.json(getClientOpenApiSpec(origin, { runtime: opts.runtime }))
  })

  client.get('/reference', (c) => {
    const origin = new URL(c.req.url).origin
    return c.html(buildClientScalarHtml('/api/client/v1/openapi.json', origin))
  })

  app.route(CLIENT_API_PREFIX, client)
  return app
}
