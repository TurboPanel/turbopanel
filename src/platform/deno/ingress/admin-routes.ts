import type { Hono, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { handleTunnelTokenRequest } from '../../../developer/tunnel-token-handler.ts'

export type IngressAdminDeps = { rootOnly: MiddlewareHandler<AppEnv> }

/**
 * Self-hosted-only admin routes. Mounted only by `src/platform/deno/server.ts`
 * through `registerAdminRoutes({ registerPlatformAdminRoutes })`, so the admin
 * session middleware still applies and High Availability has no such route.
 */
export function registerIngressAdminRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.post('/instance/tunnel-token', deps.rootOnly, (c) => handleTunnelTokenRequest(c))
}
