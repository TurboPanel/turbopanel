/**
 * The pieces a project delete and an environment delete share around the
 * cascade: the plan the confirmation shows (and the routes refuse on), and
 * what happens after the rows are gone (the servers are asked to remove the
 * folders, the Hosting Accounts that went with a project are removed if their
 * folders are already gone, and the response says what is still under way).
 */
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { environment } from '../../db/schema.ts'
import { getCommandQueue } from '../../features/commands/queue.ts'
import { sendFolderRemovalsAfterDelete } from '../../features/folders/removal.ts'
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
    /** Removed with the project; `removed` once done, else waiting for their folders or servers. */
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
