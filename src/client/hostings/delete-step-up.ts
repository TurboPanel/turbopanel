/**
 * Step-up gate for `DELETE /hostings/:id`. It runs ahead of the delete handler
 * in `./routes.ts` (registered first), so that file stays untouched. Anything
 * the handler will refuse anyway (unknown or foreign hosting, no manage
 * permission) is passed straight through to it, keeping its answers and its
 * order of checks; only a caller who could delete is asked to re-authenticate.
 */
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDb } from '../../db/connection.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { requireStepUpIfConfigured } from '../authn/step-up.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { getOrgId } from '../shared.ts'

export function registerHostingDeleteStepUp(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for hosting routes')
  }
  router.delete('/hostings/:id', createSessionMiddleware(opts.secrets), async (c, next) => {
    const db = getDb(c)
    const session = c.get('session')
    if (!db || !session) return next()

    const organizationId = await getOrgId(c, session.userId)
    if (organizationId instanceof Response) return next()

    const id = c.req.param('id')
    if ((await resolveEntityOrganizationId(db, 'hosting', id)) !== organizationId) return next()
    if (await assertCanOr403(c, 'organization:manage', 'hosting', id)) return next()

    return (await requireStepUpIfConfigured(c, organizationId, 'hosting.delete')) ?? next()
  })
}
