/**
 * Step-up gate for `POST /tls/ca/rotate` and `POST /tls/ca/retire`. It runs
 * ahead of the handlers in `./routes.ts` (registered first), so that file stays
 * untouched. A caller who may not manage the organization is passed straight
 * through to the handler, keeping its answers and its order of checks; only a
 * caller who could rotate or retire is asked to re-authenticate.
 */
import type { Hono, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDb } from '../../db/connection.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { requireStepUpIfConfigured } from '../authn/step-up.ts'
import type { StepUpAction } from '../authn/step-up-actions.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { getOrgId } from '../shared.ts'

/** Ask for a re-authentication, but only of a caller the handler would let through. */
function tlsCaGate(action: StepUpAction): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = c.get('session')
    if (!getDb(c) || !session) return next()

    const organizationId = await getOrgId(c, session.userId)
    if (organizationId instanceof Response) return next()
    if (await assertCanOr403(c, 'organization:manage', 'organization', organizationId)) {
      return next()
    }

    return (await requireStepUpIfConfigured(c, organizationId, action)) ?? next()
  }
}

export function registerTlsCaStepUp(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  const secrets = opts.secrets
  if (!secrets) {
    throw new TypeError('session secrets are required for TLS routes')
  }
  const session = createSessionMiddleware(secrets)
  router.post('/tls/ca/rotate', session, tlsCaGate('tls.ca.rotate'))
  router.post('/tls/ca/retire', session, tlsCaGate('tls.ca.retire'))
}
