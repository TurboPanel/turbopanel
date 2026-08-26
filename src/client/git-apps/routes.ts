/**
 * Organization-owned Git provider applications.
 *
 * The counterpart to the admin surface's instance-wide collection: an
 * organization registers its own GitHub App or GitLab OAuth application and
 * connects accounts through it, without an instance administrator having to
 * register one on its behalf.
 *
 * **Why this is a client route and not an admin one.** The admin surface is
 * role-gated and carries no organization context at all —
 * `createAdminAccessMiddleware` never resolves an org — so an org-scoped
 * credential editor cannot live there. Authorization here is
 * `organization:manage`, the same gate the rest of the org-owned registries use.
 *
 * Reads include instance-wide apps so the connect flow can offer them; writes
 * do not. That split is enforced in `./handlers.ts`, which both surfaces share.
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { getDb } from '../../db.ts'
import { assertCanManageOr403, getOrgId } from '../shared.ts'
import {
  completeGithubManifestHandler,
  createGitAppHandler,
  deleteGitAppHandler,
  getGitAppHandler,
  listGitAppsHandler,
  patchGitAppHandler,
  startGithubManifestHandler,
} from './handlers.ts'

const GIT_APP_PATHS = [
  '/git/apps',
  '/git/apps/:id',
  '/git/apps/github/manifest',
  '/git/apps/github/manifest/callback',
] as const

export function registerGitAppRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
): void {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for git app routes')
  }
  const secrets = opts.secrets

  for (const path of GIT_APP_PATHS) {
    router.use(path, createSessionMiddleware(secrets))
  }

  /**
   * Session + org + manage gate, in that order.
   *
   * Every handler below needs the same three things, and `organization:manage`
   * is the right gate even for reads: there is no viewer tier, and an app's
   * non-secret fields still describe the organization's provider setup.
   */
  const resolve = async (c: Parameters<typeof getOrgId>[0]) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    const organizationId = await getOrgId(c, session.userId)
    if (organizationId instanceof Response) return organizationId
    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied
    return { db, organizationId }
  }

  router.get('/git/apps', async (c) => {
    const ctx = await resolve(c)
    if (ctx instanceof Response) return ctx
    return await listGitAppsHandler(c, ctx.db, { organizationId: ctx.organizationId })
  })

  router.post('/git/apps', async (c) => {
    const ctx = await resolve(c)
    if (ctx instanceof Response) return ctx
    return await createGitAppHandler(c, ctx.db, { organizationId: ctx.organizationId })
  })

  router.post('/git/apps/github/manifest', async (c) => {
    const ctx = await resolve(c)
    if (ctx instanceof Response) return ctx
    return await startGithubManifestHandler(c, ctx.db, {
      organizationId: ctx.organizationId,
    })
  })

  router.get('/git/apps/github/manifest/callback', async (c) => {
    const ctx = await resolve(c)
    if (ctx instanceof Response) return ctx
    return await completeGithubManifestHandler(c, ctx.db, {
      organizationId: ctx.organizationId,
    })
  })

  router.get('/git/apps/:id', async (c) => {
    const ctx = await resolve(c)
    if (ctx instanceof Response) return ctx
    return await getGitAppHandler(
      c,
      ctx.db,
      { organizationId: ctx.organizationId },
      c.req.param('id'),
    )
  })

  router.patch('/git/apps/:id', async (c) => {
    const ctx = await resolve(c)
    if (ctx instanceof Response) return ctx
    return await patchGitAppHandler(
      c,
      ctx.db,
      { organizationId: ctx.organizationId },
      c.req.param('id'),
    )
  })

  router.delete('/git/apps/:id', async (c) => {
    const ctx = await resolve(c)
    if (ctx instanceof Response) return ctx
    return await deleteGitAppHandler(
      c,
      ctx.db,
      { organizationId: ctx.organizationId },
      c.req.param('id'),
    )
  })
}
