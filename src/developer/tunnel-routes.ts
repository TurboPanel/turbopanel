import type { Context, Env, Hono } from 'hono'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { DEVELOPER_API_PREFIX } from '../app/surfaces.ts'
import { handleTunnelTokenRequest } from './tunnel-token-handler.ts'

export { parseTunnelTokenBody } from './tunnel-token.ts'

/**
 * Set the self-hosted instance's Cloudflare tunnel token. The token is pushed
 * to the co-located daemon (which runs cloudflared), exposing this instance so
 * external remote daemons can connect in. An empty token tears the tunnel down.
 */
export function registerTunnelRoutes<E extends Env>(
  app: Hono<E>,
  opts: { secrets: DerivedSecretsConfig; authRequired?: boolean }
): Hono<E> {
  if (opts.authRequired !== false) {
    app.use(
      `${DEVELOPER_API_PREFIX}/instance/tunnel-token`,
      createDeveloperAccessMiddleware(opts.secrets)
    )
  }

  app.post(`${DEVELOPER_API_PREFIX}/instance/tunnel-token`, (c) =>
    handleTunnelTokenRequest(c as Context)
  )

  return app
}
