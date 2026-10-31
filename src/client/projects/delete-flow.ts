/**
 * The pieces a project delete and an environment delete share around the
 * cascade: the plan the confirmation shows (and the routes refuse on), and
 * what happens after the rows are gone (the servers are asked to remove the
 * folders, the Hosting Accounts that went with a project are removed if their
 * folders are already gone, and the response says what is still under way).
 */
import type { Context } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { environment, hosting, hostname, project, service } from '../../db/schema.ts'
import { getCommandQueue } from '../../features/commands/queue.ts'
import { sendFolderRemovalsAfterDelete } from '../../features/folders/removal.ts'
import type { AuditEntry } from '../../features/audit/audit-records.ts'
import { buildDeletePlan, type DeletePlan } from '../../features/projects/delete-plan.ts'
import type { ProjectPrincipalFate } from '../../features/principals/removal.ts'
import {
  type EnvironmentTeardownPlan,
  planEnvironmentsTeardown,
  teardownServerIds,
} from '../environments/teardown.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { removeRequestedPrincipals } from '../principals/removal-sweep.ts'

export type PlannedDelete = { plan: DeletePlan; teardownPlans: EnvironmentTeardownPlan[] }

/** The plan for deleting a whole project, with the stops it will send. */
export async function planProjectDelete(db: Db, projectId: string): Promise<PlannedDelete> {
  const rows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, projectId))
  const environmentIds = rows.map((row) => row.id)
  // The stop never retires accounts on a project delete: the folders are
  // removed after it, and the removal sweep retires the accounts after them.
  const teardownPlans = await planEnvironmentsTeardown(db, environmentIds, {
    keepPrincipals: true,
  })
  const plan = await buildDeletePlan(db, {
    projectId,
    environmentIds,
    stopServerIds: teardownServerIds(teardownPlans),
  })
  return { plan, teardownPlans }
}

/** The plan for deleting one environment, with the stops it will send. */
export async function planEnvironmentDelete(db: Db, environmentId: string): Promise<PlannedDelete> {
  const teardownPlans = await planEnvironmentsTeardown(db, [environmentId])
  const plan = await buildDeletePlan(db, {
    environmentIds: [environmentId],
    stopServerIds: teardownServerIds(teardownPlans),
  })
  return { plan, teardownPlans }
}

/**
 * A 409 for the first reason the plan cannot run, with every reason listed,
 * or null when it can. Nothing has been stopped or changed at this point.
 */
export function refuseOnPlanBlockers(c: Context<AppEnv>, plan: DeletePlan): Response | null {
  const [first] = plan.blockers
  if (!first) return null
  return c.json({ ...first, blockers: plan.blockers }, 409)
}

export type DeleteCleanupBody = {
  /** Servers asked to remove folders; each confirms on its own, the sweep asks again. */
  folderServerIds: string[]
  hostingAccounts?: {
    /** Going with the project; `removed` when already gone, else the removal sweep finishes it once its folders are gone and its servers confirm. */
    removing: Array<{ id: string; username: string; removed: boolean }>
    kept: ProjectPrincipalFate['kept']
  }
}

/**
 * After a delete commits: ask the servers to remove the folders now (the
 * folder sweep asks again for one that misses it), then try the requested
 * Hosting Account removals once (the principal sweep finishes the rest).
 * Never throws.
 */
export async function startDeleteCleanup(
  c: Context<AppEnv>,
  db: Db,
  userId: string,
  cleanup: { folderServerIds: string[]; principals?: ProjectPrincipalFate }
): Promise<DeleteCleanupBody> {
  const queue = getCommandQueue(c)
  await sendFolderRemovalsAfterDelete(db, queue, userId, cleanup.folderServerIds)
  if (!cleanup.principals) return { folderServerIds: cleanup.folderServerIds }
  const removedNow = new Set<string>()
  await forEachSequential(cleanup.principals.removed, async (row) => {
    const { removed } = await removeRequestedPrincipals(db, queue, [row.id])
    if (removed > 0) removedNow.add(row.id)
  })
  return {
    folderServerIds: cleanup.folderServerIds,
    hostingAccounts: {
      removing: cleanup.principals.removed.map((row) => ({
        ...row,
        removed: removedNow.has(row.id),
      })),
      kept: cleanup.principals.kept,
    },
  }
}

/** Longest list written into one audit entry; the total always rides beside it. */
export const DELETE_AUDIT_LIST_CAP = 50

function capped<T>(rows: readonly T[]): { items: T[]; total: number } {
  return { items: rows.slice(0, DELETE_AUDIT_LIST_CAP), total: rows.length }
}

/** What a delete removes that is worth keeping in the trail, read before it runs. */
export type DeleteAuditSnapshot = {
  /** Project name (project delete only). */
  projectName?: string | null
  environments: Array<{ id: string; name: string | null }>
  hostnames: string[]
  serverIds: string[]
  /** Hosting Accounts going with a project delete. */
  hostingAccounts: string[]
}

/**
 * Read the names, ids and public hostnames a delete is about to remove. The
 * rows are gone once the delete commits, so this runs first. The plan has no
 * hostnames, so they are read through hosting, service and environment.
 */
export async function snapshotDeleteForAudit(
  db: Db,
  plan: DeletePlan,
  projectId?: string
): Promise<DeleteAuditSnapshot> {
  const serviceIds = plan.services.map((row) => row.id)
  const hostRows =
    serviceIds.length === 0
      ? []
      : await db
          .select({ hostname: hostname.hostname })
          .from(hostname)
          .innerJoin(hosting, eq(hosting.id, hostname.hostingId))
          .innerJoin(service, eq(service.id, hosting.serviceId))
          .where(inArray(service.id, serviceIds))
  let projectName: string | null | undefined
  if (projectId) {
    const [row] = await db
      .select({ name: project.name })
      .from(project)
      .where(eq(project.id, projectId))
      .limit(1)
    projectName = row?.name ?? null
  }
  return {
    ...(projectId ? { projectName } : {}),
    environments: plan.environments.map(({ id, name }) => ({ id, name })),
    hostnames: [...new Set(hostRows.map((row) => row.hostname))].sort((a, b) => a.localeCompare(b)),
    serverIds: plan.servers.map((row) => row.id).sort((a, b) => a.localeCompare(b)),
    hostingAccounts: plan.hostingAccounts
      .filter((row) => row.action === 'remove')
      .map((row) => row.username)
      .sort((a, b) => a.localeCompare(b)),
  }
}

/** The small, non-secret context of a delete entry: lists are capped with their totals. */
export function deleteAuditContext(
  snapshot: DeleteAuditSnapshot,
  options: { environmentList?: boolean } = {}
): Record<string, unknown> {
  const environments = capped(snapshot.environments)
  const hostnames = capped(snapshot.hostnames)
  const hostingAccounts = capped(snapshot.hostingAccounts)
  return {
    ...(snapshot.projectName === undefined ? {} : { name: snapshot.projectName }),
    ...(options.environmentList === false
      ? {}
      : { environments: environments.items, environmentCount: environments.total }),
    hostnames: hostnames.items,
    hostnameCount: hostnames.total,
    serverIds: snapshot.serverIds.slice(0, DELETE_AUDIT_LIST_CAP),
    ...(snapshot.hostingAccounts.length > 0
      ? { hostingAccounts: hostingAccounts.items, hostingAccountCount: hostingAccounts.total }
      : {}),
  }
}

type DeleteAuditWho = {
  organizationId: string
  actorUserId: string
  actorEmail: string | null
}

/** The audit entry for a project delete (one entry; the environments ride in its context). */
export function projectDeleteAuditEntry(
  who: DeleteAuditWho,
  projectId: string,
  snapshot: DeleteAuditSnapshot
): AuditEntry {
  return {
    ...who,
    action: 'project.delete',
    targetType: 'project',
    targetId: projectId,
    context: deleteAuditContext(snapshot),
  }
}

/** The audit entry for an environment delete. */
export function environmentDeleteAuditEntry(
  who: DeleteAuditWho,
  environmentId: string,
  snapshot: DeleteAuditSnapshot
): AuditEntry {
  const [env] = snapshot.environments
  return {
    ...who,
    action: 'environment.delete',
    targetType: 'environment',
    targetId: environmentId,
    context: {
      name: env?.name ?? null,
      ...deleteAuditContext(snapshot, { environmentList: false }),
    },
  }
}
