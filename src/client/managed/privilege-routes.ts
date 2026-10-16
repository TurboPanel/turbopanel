/**
 * Permission grid reads (no writes):
 *
 * - `GET /environments/:id/managed/privilege-catalogue` — every privilege the
 *   cluster's exact engine series supports, in plain words, with whether a
 *   site owner's login may hold it. Nothing outside the supported series is
 *   ever listed.
 *
 * Kept apart from `routes.ts` so the users handlers there stay untouched.
 * Design: `features/managed/privileges/DESIGN.md`.
 */
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDb } from '../../db/connection.ts'
import { managed } from '../../db/schema.ts'
import { ingressEngineVersionFromOptions } from '../../features/managed/ingress-desired-pure.ts'
import { privilegeCatalogueFor } from '../../features/managed/privileges/catalogue.ts'
import { authorizeManagedRequest, loadManagedContext } from './context.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'

/** Session paths these routes need, kept here so the shared managed list stays untouched. */
export const MANAGED_PRIVILEGE_SESSION_PATHS = [
  '/environments/:id/managed/privilege-catalogue',
] as const

export function registerManagedPrivilegeRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for managed privilege routes')
  }
  for (const path of MANAGED_PRIVILEGE_SESSION_PATHS) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }
  router.get('/environments/:id/managed/privilege-catalogue', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'read')
    if (auth instanceof Response) return auth
    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const [row] = await db
      .select({ options: managed.options })
      .from(managed)
      .where(eq(managed.environmentId, environmentId))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const series = ingressEngineVersionFromOptions(ctx.spec, row.options)
    const catalogue = series ? privilegeCatalogueFor(ctx.spec.engine, series) : undefined
    if (!catalogue) {
      return c.json(
        {
          error: 'privilege_catalogue_unsupported_version',
          message:
            'Permissions cannot be shown for this database version. Only versions the panel supports are listed.',
        },
        422
      )
    }
    return c.json(catalogue)
  })
}
