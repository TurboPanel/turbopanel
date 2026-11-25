/**
 * `POST /hostings/:id/remove-now` — let go of a compose-made hostname at once.
 *
 * Removing a hostname means taking its entry out of the environment's compose
 * file. The row the last deploy made from that entry only went away at the next
 * deploy, so a project that cannot deploy held the name for good and no other
 * project could use it. This route releases the row in its own request, once the
 * merged compose no longer declares it (`409 hosting_still_declared` while it
 * does: the next deploy would only make the row again). It asks for the same
 * step-up as `DELETE /hostings/:id` (`./delete-step-up.ts`).
 *
 * A compose-made row is deleted: its `hostname` rows go with it (cascade) and a
 * doorway's `hosting_id` is set null (the doorway keeps its own name, a
 * tunnel's own record), so the name is free at once. A row compose adopted from
 * the panel (`composeAdopted`) is not deleted but handed back, as the deploy's
 * reconcile does: the panel made it first, so the row and its names stay with
 * the panel, which keeps serving them, and the names are not freed. Asking
 * again for a row that is already gone answers 200 with `alreadyGone`, so a
 * retry after a lost reply is harmless. Another organization's id is a 404. The session gate is the step-up
 * middleware's (`./delete-step-up.ts`, registered ahead of this route).
 *
 * No deploy runs: a deploy plans from the whole environment and would ship
 * someone's other undeployed edits. The server keeps serving the route until
 * the environment's next deploy rewrites its web server config, and the answer's
 * `serverUpdate` says so (`next_deploy`, or `not_deployed` / `no_environment`
 * when no server holds a route). A panel-made hosting is removed with
 * `DELETE /hostings/:id`, which answers the same way.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { isUuid } from '../access/routes-helpers.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { composeDeclaresRoute } from '../environments/reconcile-hostings.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { environment, hosting, hostname, project, service } from '../../db/schema.ts'
import {
  ENVIRONMENT_DEPLOY_RUNNING_ERROR,
  environmentHasRunningCommand,
  lockEnvironmentRow,
} from '../../features/folders/records.ts'
import {
  isAdoptedComposeHosting,
  isComposeOwnedHosting,
  readHostingComposeOwner,
  withoutHostingComposeOwner,
} from '../../features/hostings/hosting-compose-owner.ts'
import { environmentComposeFilename } from '../../features/deploy/deploy-layers.ts'
import { resolveMergedCompose } from '../../features/schedule/plan-deploy.ts'
import {
  lockCertificatesPinnedBy,
  removeUnusedSiteCertificates,
} from '../../features/tls/unused-letsencrypt.ts'
import { nudgeTunnelRoutesAfterResponse } from '../organizations/tunnel-nudge.ts'
import { assertNotSystemOwnedOr403, getOrgId } from '../shared.ts'
import { hostingRemovalUpdate } from './letsencrypt-apply.ts'

const REMOVE_PATH = '/hostings/:id/remove-now'

const ALREADY_GONE = { ok: true as const, removed: true as const, alreadyGone: true as const }

type RemoveOutcome =
  | { kind: 'missing' | 'not_compose_owned' | 'deploy_running' | 'still_declared' }
  | { kind: 'handed_back'; environmentId: string }
  | { kind: 'removed'; environmentId: string; hostnames: string[] }

/**
 * Is the entry this row was made from still in the environment's merged
 * compose? Read under the environment lock, so the answer holds for the delete
 * that follows. A document that cannot be merged counts as still declaring it:
 * nothing shows the entry is gone.
 */
async function composeStillDeclares(
  tx: Db,
  environmentId: string,
  composeServiceName: string,
  metadata: unknown
): Promise<boolean> {
  const owner = readHostingComposeOwner(metadata)
  if (owner === null) return false
  const [layers] = await tx
    .select({
      environmentName: environment.name,
      environmentOptions: environment.options,
      projectOptions: project.options,
    })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!layers) return true
  const merged = resolveMergedCompose(
    layers.projectOptions,
    layers.environmentOptions,
    environmentComposeFilename({ id: environmentId, name: layers.environmentName })
  )
  if ('kind' in merged) return true
  return composeDeclaresRoute(merged, composeServiceName, owner.route)
}

/** Delete (or hand back) the row while holding the environment row's lock, as the deploy reconcile does. */
async function removeUnderEnvironmentLock(
  tx: Db,
  id: string,
  actorUserId: string
): Promise<RemoveOutcome> {
  const [row] = await tx
    .select({
      environmentId: service.environmentId,
      composeServiceName: service.composeServiceName,
    })
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
  if (await composeStillDeclares(tx, row.environmentId, row.composeServiceName, current.metadata)) {
    return { kind: 'still_declared' }
  }

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

export function registerHostingRemoveNowRoute(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for hosting routes')
  }
  router.post(REMOVE_PATH, async (c) => {
    const id = c.req.param('id')
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    const organizationId = await getOrgId(c, session.userId)
    if (organizationId instanceof Response) return organizationId
    if (!isUuid(id)) return c.json({ error: 'Not found' }, 404)
    const owner = await resolveEntityOrganizationId(db, 'hosting', id)
    // A well-formed id with no row is a retry for a hosting already removed;
    // there is nothing left to authorize or to tell anyone.
    if (owner === null) return c.json(ALREADY_GONE)
    if (owner !== organizationId) return c.json({ error: 'Not found' }, 404)
    const denied =
      (await assertCanOr403(c, 'organization:manage', 'hosting', id)) ??
      (await assertNotSystemOwnedOr403(c, 'hosting', id))
    if (denied) return denied

    const outcome = await db.transaction((tx) => removeUnderEnvironmentLock(tx, id, session.userId))
    switch (outcome.kind) {
      case 'missing':
        return c.json(ALREADY_GONE)
      case 'still_declared':
        return c.json(
          {
            error: 'hosting_still_declared',
            message:
              'The environment compose file still declares this hostname. Remove it from the file first, or the next deploy brings it back.',
          },
          409
        )
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
        return c.json({
          ok: true as const,
          removed: false as const,
          outcome: 'handed_back' as const,
          hostnames: [],
        })
      case 'removed': {
        nudgeTunnelRoutesAfterResponse(c, organizationId)
        const serverUpdate = await hostingRemovalUpdate(db, outcome.environmentId)
        return c.json({
          ok: true as const,
          removed: true as const,
          outcome: 'removed' as const,
          hostnames: outcome.hostnames,
          serverUpdate,
        })
      }
    }
  })
}
