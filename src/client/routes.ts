import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import {
  registerAuthnRoutes,
  registerAuthRoutes,
  type AuthRouteOpts,
} from './authn/http.ts'
import {
  getClientPublicStatus,
  resolveSignupEnvOverrideFromContext,
} from './authn/install-state.ts'
import { getDb } from '../db.ts'
import { registerAccessRoutes } from './access/routes.ts'
import {
  registerEnvironmentDeployPreviewRoutes,
  registerEnvironmentDeployRoutes,
  registerEnvironmentLifecycleRoutes,
  registerEnvironmentStopRoutes,
} from './environments/deploy-routes.ts'
import { registerManagedRoutes } from './managed/routes.ts'
import { registerEnvironmentRoutes } from './environments/routes.ts'
import { registerVariableRoutes } from './variables/routes.ts'
import { registerContainerRoutes } from './containers/routes.ts'
import { registerHostingRoutes } from './hostings/routes.ts'
import { registerTlsRoutes } from './tls/routes.ts'
import { registerLicenseRoutes } from './licenses/routes.ts'
import {
  registerOrganizationLimitsRoutes,
  registerProjectPrincipalRoutes,
  registerServerLimitsRoutes,
} from './principals/routes.ts'
import { registerStorageRoutes } from './storage/routes.ts'
import { registerNetworkRoutes } from './networks/routes.ts'
import { registerDatacenterRoutes } from './datacenters/routes.ts'
import { registerIpRoutes } from './ips/routes.ts'
import { registerVpnRoutes } from './vpns/routes.ts'
import { registerProjectRoutes } from './projects/routes.ts'
import { registerServerRoutes } from './servers/routes.ts'
import { registerSystemRoutes } from './system/routes.ts'
import { registerServiceRoutes } from './services/routes.ts'
import { registerTeamRoutes } from './teams/routes.ts'
import { registerOrganizationRoutes } from './organizations/routes.ts'
import { registerWorkspaceRoutes } from './workspaces/routes.ts'
import { getClientOpenApiSpec } from './openapi/index.ts'
import { buildClientScalarHtml } from '../scalar-html.ts'
import { CLIENT_API_PREFIX } from '../surfaces.ts'

/**
 * Client (end-user UI) surface. Auth routes plus org-scoped resources for the
 * signed-in user (e.g. servers assigned to their organization).
 * Mounted under {@link CLIENT_API_PREFIX} (`/api/client/v1`).
 */
export function registerClientRoutes(app: Hono<AppEnv>, opts: AuthRouteOpts) {
  const client = new Hono<AppEnv>()

  registerAuthRoutes(client, opts)
  registerAuthnRoutes(client, opts)

  client.get('/status', async (c) => {
    const db = getDb(c)
    const platformEnv = c.get('platformEnv')
    // Effective signup flag is resolved inside getClientPublicStatus via
    // resolveEffectiveSignupEnabled — same helper as sign-up / OTP auto-reg.
    // Prefer per-request platformEnv so dashboard force overrides apply without
    // an isolate recycle (do not rely on createApp()-captured signupEnvOverride).
    const payload = await getClientPublicStatus(
      db,
      opts.runtime,
      resolveSignupEnvOverrideFromContext(platformEnv, opts.signupEnvOverride),
      platformEnv,
      c.get('dataEncryptionSecrets'),
    )
    if (payload === null) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }
    return c.json(payload)
  })

  registerServerRoutes(client, opts)
  registerSystemRoutes(client, opts)
  registerNetworkRoutes(client, opts)
  registerDatacenterRoutes(client, opts)
  registerIpRoutes(client, opts)
  registerVpnRoutes(client, opts)
  registerLicenseRoutes(client, opts)
  registerOrganizationRoutes(client, opts)
  registerAccessRoutes(client, opts)
  registerWorkspaceRoutes(client, opts)
  registerEnvironmentRoutes(client, opts)
  registerEnvironmentDeployPreviewRoutes(client, opts)
  registerEnvironmentDeployRoutes(client, opts)
  registerEnvironmentStopRoutes(client, opts)
  registerEnvironmentLifecycleRoutes(client, opts)
  registerManagedRoutes(client, opts)
  registerVariableRoutes(client, opts)
  registerProjectRoutes(client, opts)
  registerServiceRoutes(client, opts)
  registerHostingRoutes(client, opts)
  registerContainerRoutes(client, opts)
  registerStorageRoutes(client, opts)
  registerProjectPrincipalRoutes(client, opts)
  registerOrganizationLimitsRoutes(client, opts)
  registerServerLimitsRoutes(client, opts)
  registerTlsRoutes(client, opts)
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
