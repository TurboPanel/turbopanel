/**
 * `GET /environments/:id/folders` — the service and volume folders that exist
 * under an environment on any server, which is what stops its name changing.
 * `total` counts every one; `folders` lists the first 20.
 *
 * `GET /environments/:id/delete-preview` — what deleting the environment
 * removes and keeps, and why it would be refused (the delete confirmation).
 */
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { getDb } from '../../db/connection.ts'
import { listEnvironmentFolders } from '../../features/folders/records.ts'
import { assertCanReadOr403 } from '../shared.ts'
import { planEnvironmentDelete } from '../projects/delete-flow.ts'

export function registerEnvironmentFolderRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment folder routes')
  }
  router.use('/environments/:id/folders', createSessionMiddleware(opts.secrets))
  router.use('/environments/:id/delete-preview', createSessionMiddleware(opts.secrets))

  router.get('/environments/:id/folders', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'environment', environmentId)
    if (denied) return denied

    const { folders, total } = await listEnvironmentFolders(db, environmentId)
    return c.json({ ok: true as const, folders, total })
  })

  router.get('/environments/:id/delete-preview', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'environment', environmentId)
    if (denied) return denied

    const { plan } = await planEnvironmentDelete(db, environmentId)
    return c.json({ ok: true as const, ...plan })
  })
}
