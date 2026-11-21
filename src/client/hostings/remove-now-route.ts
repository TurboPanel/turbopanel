/**
 * `POST /hostings/:id/remove-now` — let go of a compose-made hostname at once.
 *
 * "Remove hostname" on the Hosting screen drops the entry from the
 * environment's compose file. The row the last deploy made from that entry
 * only went away at the next deploy, so a project that cannot deploy held the
 * name for good and no other project could use it. The screen calls this after
 * the file save: the row is deleted in this request, which frees its
 * `hostname` rows and unlinks any doorway that pointed at it (`doorway.hosting_id`
 * is set null; the doorway keeps its own name, a tunnel's own record).
 *
 * Then the route is dropped from the servers with a hostings-only run
 * (`pushHostingRemoval`): no build, no restart. When that cannot run (server
 * offline, no finished deploy yet, a deploy in progress, another hosting with
 * an undeployed edit, or the run is refused) the name is still free, and the
 * answer's `serverUpdate` says so: the server keeps serving the route until
 * the environment's next deploy rewrites its web server config. Nothing
 * reconnects a server on its own.
 *
 * A row compose adopted from the panel (`composeAdopted`) is handed back, not
 * deleted, as the deploy's reconcile does: the panel made it first and keeps
 * serving it, so there is nothing to push. A panel-made hosting is removed with
 * `DELETE /hostings/:id`, which pushes the same way.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { hosting, hostname, service } from '../../db/schema.ts'
import {
  ENVIRONMENT_DEPLOY_RUNNING_ERROR,
  environmentHasRunningCommand,
  lockEnvironmentRow,
} from '../../features/folders/records.ts'
import {
  isAdoptedComposeHosting,
  isComposeOwnedHosting,
  withoutHostingComposeOwner,
} from '../../features/hostings/hosting-compose-owner.ts'
import {
  lockCertificatesPinnedBy,
  removeUnusedSiteCertificates,
} from '../../features/tls/unused-letsencrypt.ts'
import { nudgeTunnelRoutesAfterResponse } from '../organizations/tunnel-nudge.ts'
import { assertNotSystemOwnedOr403, getOrgId } from '../shared.ts'
import {
  type HostingApplyDeps,
  type HostingApplyOutcome,
  pushHostingRemoval,
  requestHostingApplyDeps,
} from './letsencrypt-apply.ts'

const REMOVE_PATH = '/hostings/:id/remove-now'

type RemoveOutcome =
  | { kind: 'missing' | 'not_compose_owned' | 'deploy_running' }
  | { kind: 'handed_back'; environmentId: string }
  | { kind: 'removed'; environmentId: string; hostnames: string[] }

/** Delete (or hand back) the row while holding the environment row's lock, as the deploy reconcile does. */
async function removeUnderEnvironmentLock(
  tx: Db,
  id: string,
  actorUserId: string
): Promise<RemoveOutcome> {
  const [row] = await tx
    .select({ environmentId: service.environmentId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .where(eq(hosting.id, id))
    .limit(1)
  if (!row) return { kind: 'missing' }
  await lockEnvironmentRow(tx, row.environmentId)
  if (await environmentHasRunningCommand(tx, row.environmentId)) return { kind: 'deploy_running' }
  const certificateIds = await lockCertificatesPinnedBy(tx, [id])

  const [current] = await tx
    .select({ metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, id))
    .limit(1)
  if (!current) return { kind: 'missing' }
  if (!isComposeOwnedHosting(current.metadata)) return { kind: 'not_compose_owned' }

  if (isAdoptedComposeHosting(current.metadata)) {
    await tx
      .update(hosting)
      .set({
        metadata: withoutHostingComposeOwner(current.metadata),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(hosting.id, id), sql`${hosting.metadata}->>'composeOwned' = 'true'`))
    return { kind: 'handed_back', environmentId: row.environmentId }
  }

  const names = await tx
    .select({ hostname: hostname.hostname })
    .from(hostname)
    .where(eq(hostname.hostingId, id))
  // The hostname rows go with it (cascade) and a doorway's `hosting_id` is set null.
  await tx.delete(hosting).where(eq(hosting.id, id))
  await removeUnusedSiteCertificates(tx, certificateIds, {
    reason: 'its site was removed',
    actor: { userId: actorUserId },
  })
  return {
    kind: 'removed',
    environmentId: row.environmentId,
    hostnames: names.map((n) => n.hostname).sort((a, b) => a.localeCompare(b)),
  }
}

export type HostingRemoveNowDeps = {
  /** Where the hostings-only run is queued; defaults to the request's queue and registry. */
  applyDeps?: (c: Context<AppEnv>) => HostingApplyDeps
}

export function registerHostingRemoveNowRoute(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  deps: HostingRemoveNowDeps = {}
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for hosting routes')
  }
  router.use(REMOVE_PATH, createSessionMiddleware(opts.secrets))

  router.post(REMOVE_PATH, async (c) => {
    const id = c.req.param('id')
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
    if (denied) return denied

    const outcome = await db.transaction((tx) => removeUnderEnvironmentLock(tx, id, session.userId))
    switch (outcome.kind) {
      case 'missing':
        return c.json({ error: 'Not found' }, 404)
      case 'not_compose_owned':
        return c.json(
          {
            error: 'hosting_not_owned_by_compose',
            message: 'This hosting was made on this screen. Delete it instead.',
          },
          409
        )
      case 'deploy_running':
        return c.json(
          {
            error: ENVIRONMENT_DEPLOY_RUNNING_ERROR,
            message:
              'A deploy of this environment is running. Try again when it has finished, so the deploy does not take the hostname back.',
          },
          409
        )
      case 'handed_back':
        return c.json({ ok: true as const, outcome: 'handed_back' as const, hostnames: [] })
      case 'removed': {
        nudgeTunnelRoutesAfterResponse(c, organizationId)
        const serverUpdate: HostingApplyOutcome = await pushHostingRemoval(
          c,
          db,
          {
            environmentId: outcome.environmentId,
            organizationId,
            actor: { actorType: 'user', actorId: session.userId },
          },
          (deps.applyDeps ?? requestHostingApplyDeps)(c)
        )
        return c.json({
          ok: true as const,
          outcome: 'removed' as const,
          hostnames: outcome.hostnames,
          serverUpdate,
        })
      }
    }
  })
}
