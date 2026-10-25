/**
 * `POST /hostings/:id/release-from-compose` — hand a compose-made hosting back
 * to the panel.
 *
 * The Hosting screen's "Manage on this screen instead" moves a hostname out of
 * the environment's compose file into an ordinary panel hosting. The row the
 * last deploy made from that entry already holds the names, the pinned
 * certificate and the hostname variables, so the move keeps it: this strips the
 * compose markers (`withoutHostingComposeOwner`, the same release the deploy
 * reconcile applies to an adopted row) and the panel edits the row again.
 *
 * The caller removes the declaration from the compose file **after** this
 * answers. In that order a failed compose write leaves a panel row that the
 * next deploy adopts again (reversible); the other order would leave a
 * compose-owned row with no declaration, which the next deploy deletes.
 */
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { hosting } from '../../db/schema.ts'
import {
  isComposeOwnedHosting,
  withoutHostingComposeOwner,
} from '../../features/hostings/hosting-compose-owner.ts'
import { assertNotSystemOwnedOr403, getOrgId } from '../shared.ts'

const RELEASE_PATH = '/hostings/:id/release-from-compose'

/** The database when the caller may change this hosting, else the refusal. */
async function releaseAccess(c: Context<AppEnv>, id: string): Promise<Db | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  const organizationId = await getOrgId(c, session.userId)
  if (organizationId instanceof Response) return organizationId
  const owner = await resolveEntityOrganizationId(db, 'hosting', id)
  if (owner !== organizationId) return c.json({ error: 'Not found' }, 404)
  const denied =
    (await assertCanOr403(c, 'organization:manage', 'hosting', id)) ??
    (await assertNotSystemOwnedOr403(c, 'hosting', id))
  return denied ?? db
}

export function registerHostingComposeReleaseRoute(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for hosting routes')
  }
  router.use(RELEASE_PATH, createSessionMiddleware(opts.secrets))

  router.post(RELEASE_PATH, async (c) => {
    const id = c.req.param('id')
    const db = await releaseAccess(c, id)
    if (db instanceof Response) return db

    const [row] = await db
      .select({ metadata: hosting.metadata })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)
    if (!isComposeOwnedHosting(row.metadata)) {
      return c.json({ ok: true as const, released: false })
    }

    await db
      .update(hosting)
      .set({
        metadata: withoutHostingComposeOwner(row.metadata),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(hosting.id, id))
    return c.json({ ok: true as const, released: true })
  })
}
