import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { environment, project } from '../../lib/db/schema.ts'
import { mergeProjectEnvironmentCompose } from './deploy-prepare.ts'
import { reconcileServicesFromCompose } from './reconcile-services.ts'

/**
 * Reconcile `service` rows for one environment from its currently-persisted
 * compose (project base + environment overlay). Idempotent — safe to call
 * after any compose-affecting save (environment options PATCH, environment
 * create, project base compose PATCH/create). Non-fatal: swallows missing
 * rows, invalid compose, and reconcile errors so callers never fail a
 * compose save because of this side effect.
 */
export async function reconcileServicesForEnvironment(
  db: Db,
  environmentId: string,
): Promise<void> {
  try {
    const [envRow] = await db
      .select({ projectId: environment.projectId, options: environment.options })
      .from(environment)
      .where(eq(environment.id, environmentId))
      .limit(1)
    if (!envRow) return

    const [projectRow] = await db
      .select({ options: project.options })
      .from(project)
      .where(eq(project.id, envRow.projectId))
      .limit(1)
    if (!projectRow) return

    const merged = mergeProjectEnvironmentCompose(projectRow.options, envRow.options)
    if (merged instanceof Response) return

    await reconcileServicesFromCompose(db, environmentId, merged)
  } catch {
    // Best-effort side effect of saving compose — never fail the save.
  }
}

/** Reconcile every environment of a project (e.g. after project base compose save). */
export async function reconcileServicesForProject(
  db: Db,
  projectId: string,
): Promise<void> {
  try {
    const rows = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, projectId))
    for (const row of rows) {
      await reconcileServicesForEnvironment(db, row.id)
    }
  } catch {
    // Best-effort side effect of saving compose — never fail the save.
  }
}
