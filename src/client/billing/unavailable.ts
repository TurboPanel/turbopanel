/**
 * `/api/client/v1/billing/*` on a control plane that has no billing surface
 * (self-hosted). The route contract answers every path with
 * `503 billing_not_configured`, after the session check, instead of a bare 404.
 *
 * Kept apart from `routes.ts` so the self-hosted bundle does not pull in the
 * payment provider client.
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'

const BILLING_NOT_CONFIGURED = 'billing_not_configured'

export function registerBillingUnavailableRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts): void {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for billing routes')
  }
  router.use('/billing/*', createSessionMiddleware(opts.secrets))
  router.all('/billing/*', (c) => c.json({ error: BILLING_NOT_CONFIGURED }, 503))
}
