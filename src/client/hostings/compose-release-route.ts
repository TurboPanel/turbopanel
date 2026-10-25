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
import { and, eq, sql } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { hosting, service } from '../../db/schema.ts'
import {
  ENVIRONMENT_DEPLOY_RUNNING_ERROR,
  environmentHasRunningCommand,
  lockEnvironmentRow,
} from '../../features/folders/records.ts'
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

type ReleaseOutcome = 'released' | 'not_compose_owned' | 'missing' | 'deploy_running'

/**
 * Strip the markers while holding the environment row's lock. The deploy's
 * hosting reconcile takes the same lock before it reads the rows, so it either
 * finishes first (and this sees what it wrote) or starts after (and adopts the
 * released row while the file still names it) — never writes stale compose
 * markers over the release. A deploy already past that point refuses the
 * release outright, and the update only touches a row compose still owns.
 */
async function releaseUnderEnvironmentLock(tx: Db, id: string): Promise<ReleaseOutcome> {
  const [row] = await tx
    .select({ metadata: hosting.metadata, environmentId: service.environmentId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .where(eq(hosting.id, id))
    .limit(1)
  if (!row) return 'missing'
  await lockEnvironmentRow(tx, row.environmentId)
  if (await environmentHasRunningCommand(tx, row.environmentId)) return 'deploy_running'

  const [current] = await tx
    .select({ metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, id))
    .limit(1)
  if (!current) return 'missing'
  if (!isComposeOwnedHosting(current.metadata)) return 'not_compose_owned'

  const updated = await tx
    .update(hosting)
    .set({
      metadata: withoutHostingComposeOwner(current.metadata),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(hosting.id, id), sql`${hosting.metadata}->>'composeOwned' = 'true'`))
    .returning({ id: hosting.id })
  return updated.length > 0 ? 'released' : 'not_compose_owned'
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

    const outcome = await db.transaction((tx) => releaseUnderEnvironmentLock(tx, id))
    if (outcome === 'missing') return c.json({ error: 'Not found' }, 404)
    if (outcome === 'deploy_running') {
      return c.json(
        {
          error: ENVIRONMENT_DEPLOY_RUNNING_ERROR,
          message:
            'A deploy of this environment is running. Try again when it has finished, so the deploy does not take the hostname back.',
        },
        409
      )
    }
    return c.json({ ok: true as const, released: outcome === 'released' })
  })
}
