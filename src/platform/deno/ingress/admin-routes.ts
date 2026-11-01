import type { Hono, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { requireInstanceStepUp } from '../../../client/authn/step-up.ts'
import { handleTunnelTokenRequest } from '../../../developer/tunnel-token-handler.ts'
import { recordAudit } from '../../../features/audit/audit-records.ts'
import { getDb } from '../../../db/connection.ts'

export type IngressAdminDeps = { rootOnly: MiddlewareHandler<AppEnv> }

/**
 * Self-hosted-only admin routes. Mounted only by `src/platform/deno/server.ts`
 * through `registerAdminRoutes({ registerPlatformAdminRoutes })`, so the admin
 * session middleware still applies and High Availability has no such route.
 */
export function registerIngressAdminRoutes(admin: Hono<AppEnv>, deps: IngressAdminDeps): void {
  admin.post('/instance/tunnel-token', deps.rootOnly, async (c) => {
    const stepUp = await requireInstanceStepUp(c, 'instance.tunnel_token.set')
    if (stepUp) return stepUp
    const response = await handleTunnelTokenRequest(c)
    if (response.ok) {
      const session = c.get('session')
      // The token itself is never recorded.
      await recordAudit(getDb(c), {
        organizationId: null,
        actorUserId: session?.userId ?? null,
        actorEmail: session?.email ?? null,
        action: 'instance.tunnel_token.set',
        targetType: 'instance',
      })
    }
    return response
  })
}
