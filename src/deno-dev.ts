/**
 * Development Deno entry. Imports the developer surface so production compile
 * of {@link ./deno.ts} never sees these modules.
 */
import { registerVersionRoute } from './daemon/version.ts'
import { registerDevSyncRoutes } from './developer/dev-sync.ts'
import { registerDevUpdateOverlay } from './developer/dev-update-overlay.ts'
import { registerDeveloperRoutes } from './developer/routes.ts'
import { registerSystemRoutes } from './developer/system-routes.ts'
import { registerTunnelRoutes } from './developer/tunnel-routes.ts'
import { registerUpdateRoutes } from './developer/update-routes.ts'
import { startDenoServer } from './deno-server.ts'

await startDenoServer({
  registerDeveloperSurface({ routes, sessionSecrets, db }) {
    registerDeveloperRoutes(routes, { secrets: sessionSecrets, db })
    registerVersionRoute(routes)
    registerSystemRoutes(routes, { secrets: sessionSecrets, db })
    registerDevSyncRoutes(routes, { secrets: sessionSecrets })
    registerTunnelRoutes(routes, { secrets: sessionSecrets })
    registerUpdateRoutes(routes, { secrets: sessionSecrets })
    // Client update UI resolves trunk from the local daemon overlay and
    // rebuilds it on demand, instead of comparing against the public CDN.
    registerDevUpdateOverlay()
  },
})
