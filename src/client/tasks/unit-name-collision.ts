/**
 * Task rows and compose-authored cron share one namespace of timers on the
 * host (see `renderCronForDeploy`): a task's display name folds to a unit
 * name (`cronJobUnitName`), and that unit name must not collide with another
 * task on the service or with a `x-turbopanel.cron` job in the service's
 * merged compose. Compose wins a collision at deploy, so the API is where a
 * task learns it would never run — refused here with a reason, not dropped
 * silently later.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { environment, project, service, task } from '../../lib/db/schema.ts'
import { cronJobUnitName } from '../../lib/cron.ts'
import { readServiceTurbopanelExtension } from '../../lib/compose/service-kind.ts'
import { resolveMergedCompose, servicesMapping } from '../../lib/schedule/plan-deploy.ts'
import { environmentComposeFilename } from '../environments/deploy-layers.ts'
import { isPlainObject } from '../environments/deploy-routes-helpers.ts'

import { TASK_NAME_IN_USE_ERROR } from '../display-name-uniqueness.ts'

export const TASK_NAME_UNREPRESENTABLE_ERROR = 'task_name_unrepresentable'
export const TASK_NAME_IN_COMPOSE_ERROR = 'task_name_in_compose'

export type TaskUnitNameCheck =
  | { ok: true; unitName: string }
  | { ok: false; error: string }

/** Unit names of the compose-authored cron jobs on one service. */
export async function listComposeCronJobNames(db: Db, serviceId: string): Promise<Set<string>> {
  const [row] = await db
    .select({
      composeServiceName: service.composeServiceName,
      environmentId: environment.id,
      environmentName: environment.name,
      environmentOptions: environment.options,
      projectOptions: project.options,
    })
    .from(service)
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(eq(service.id, serviceId))
    .limit(1)
  if (!row) return new Set()
  const merged = resolveMergedCompose(
    row.projectOptions,
    row.environmentOptions,
    environmentComposeFilename({ id: row.environmentId, name: row.environmentName }),
  )
  if ('kind' in merged) return new Set()
  const definition = servicesMapping(merged)[row.composeServiceName]
  if (!isPlainObject(definition)) return new Set()
  const extension = readServiceTurbopanelExtension(definition)
  return new Set((extension?.cron ?? []).map((job) => job.name))
}

/** Unit names the service's other task rows fold to. */
export async function listTaskUnitNames(
  db: Db,
  serviceId: string,
  exceptTaskId?: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: task.id, name: task.name })
    .from(task)
    .where(eq(task.serviceId, serviceId))
  const out = new Set<string>()
  for (const row of rows) {
    if (row.id === exceptTaskId) continue
    const unit = cronJobUnitName(row.name)
    if (unit !== null) out.add(unit)
  }
  return out
}

/**
 * The one check both create and rename run. Order: unrepresentable → another
 * task folds to the same unit → a compose job owns it.
 */
export async function checkTaskUnitName(
  db: Db,
  serviceId: string,
  displayName: string,
  exceptTaskId?: string,
): Promise<TaskUnitNameCheck> {
  const unitName = cronJobUnitName(displayName)
  if (unitName === null) return { ok: false, error: TASK_NAME_UNREPRESENTABLE_ERROR }
  if ((await listTaskUnitNames(db, serviceId, exceptTaskId)).has(unitName)) {
    return { ok: false, error: TASK_NAME_IN_USE_ERROR }
  }
  if ((await listComposeCronJobNames(db, serviceId)).has(unitName)) {
    return { ok: false, error: TASK_NAME_IN_COMPOSE_ERROR }
  }
  return { ok: true, unitName }
}
