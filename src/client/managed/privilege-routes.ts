/**
 * Permission grid reads (no writes):
 *
 * - `GET /environments/:id/managed/privilege-catalogue` — every privilege the
 *   cluster's exact engine series supports, in plain words, with whether a
 *   site owner's login may hold it. Nothing outside the supported series is
 *   ever listed.
 *
 * Kept apart from `routes.ts` so the users handlers there stay untouched. The
 * session middleware for these paths comes from `managedSessionPaths()`.
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

export function registerManagedPrivilegeRoutes(router: Hono<AppEnv>) {
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
