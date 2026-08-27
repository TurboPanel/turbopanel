/**
 * Scheduled tasks (cron) on a service.
 *
 * `task` is deliberately not added to `RESOURCE_KINDS` / `ENTITY_TYPES` in
 * `src/client/authz/catalog.ts` — there are no per-task grants. Gating rides
 * the parent `service`, which the evaluator and `resolveEntityOrganizationId`
 * already handle.
 *
 * A task row is configuration only: nothing is enqueued, no `command` is
 * created, and no daemon sees it yet.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import {
  TASK_NAME_IN_USE_ERROR,
  isTaskDisplayNameTaken,
} from '../display-name-uniqueness.ts'
import { service } from '../../lib/db/schema.ts'
import {
  countTasksForService,
  createTask,
  deleteTask,
  getTask,
  isTaskUniqueViolation,
  listTasksForServices,
  updateTask,
  type TaskRecord,
} from '../../lib/db/task-records.ts'
import {
  assertCanCreateOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
  requireStringField,
} from '../shared.ts'
import {
  buildTaskPatchFields,
  MAX_CRON_JOBS_PER_SERVICE,
  invalidTaskIdResponse,
  parseTaskCreateFields,
  parseTaskListFilters,
  type TaskListFilters,
} from './routes-helpers.ts'

type TaskRequestContext = {
  db: Db
  organizationId: string
  userId: string
}

async function requireTaskRequestContext(
  c: Context<AppEnv>,
): Promise<TaskRequestContext | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult
  return { db, organizationId: orgResult, userId: session.userId }
}

async function resolveListedServiceIds(
  c: Context<AppEnv>,
  db: Db,
  visibleIds: string[],
  filters: TaskListFilters,
): Promise<string[] | Response> {
  if (filters.serviceId) {
    if (!visibleIds.includes(filters.serviceId)) {
      return c.json({ error: 'Not found' }, 404)
    }
    return [filters.serviceId]
  }
  if (!filters.environmentId) return visibleIds

  const rows = await db
    .select({ id: service.id })
    .from(service)
    .where(
      and(
        inArray(service.id, visibleIds),
        eq(service.environmentId, filters.environmentId),
      ),
    )
  return rows.map((row) => row.id)
}

async function loadTaskInOrganization(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  id: string,
): Promise<TaskRecord | Response> {
  const invalidId = invalidTaskIdResponse(c, id, 'path')
  if (invalidId) return invalidId
  const row = await getTask(db, id)
  if (!row) return c.json({ error: 'Not found' }, 404)

  const serviceOrgId = await resolveEntityOrganizationId(db, 'service', row.serviceId)
  if (!serviceOrgId || serviceOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return row
}

async function assertTaskServiceCreatable(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  serviceId: string,
): Promise<Response | null> {
  const serviceOrgId = await resolveEntityOrganizationId(db, 'service', serviceId)
  if (serviceOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  const denied = await assertCanCreateOr403(c, 'service', serviceId)
  if (denied) return denied
  return assertNotSystemOwnedOr403(c, 'service', serviceId)
}

async function assertTaskServiceWritable(
  c: Context<AppEnv>,
  serviceId: string,
): Promise<Response | null> {
  const denied = await assertCanOr403(c, 'organization:manage', 'service', serviceId)
  if (denied) return denied
  return assertNotSystemOwnedOr403(c, 'service', serviceId)
}

async function assertTaskCreateCapacity(
  c: Context<AppEnv>,
  db: Db,
  serviceId: string,
  name: string,
): Promise<Response | null> {
  const existing = await countTasksForService(db, serviceId)
  if (existing >= MAX_CRON_JOBS_PER_SERVICE) {
    return c.json({ error: 'task_limit_reached' }, 409)
  }
  if (await isTaskDisplayNameTaken(db, serviceId, name)) {
    return c.json({ error: TASK_NAME_IN_USE_ERROR }, 409)
  }
  return null
}

async function assertTaskRenameAvailable(
  c: Context<AppEnv>,
  db: Db,
  serviceId: string,
  name: string | undefined,
  taskId: string,
): Promise<Response | null> {
  if (name === undefined) return null
  if (await isTaskDisplayNameTaken(db, serviceId, name, taskId)) {
    return c.json({ error: TASK_NAME_IN_USE_ERROR }, 409)
  }
  return null
}

function rethrowUnlessTaskNameConflict(c: Context<AppEnv>, err: unknown): Response {
  if (isTaskUniqueViolation(err)) {
    return c.json({ error: TASK_NAME_IN_USE_ERROR }, 409)
  }
  throw err
}

export function registerTaskRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for task routes')
  }
  const secrets = opts.secrets

  router.use('/tasks', createSessionMiddleware(secrets))
  router.use('/tasks/:id', createSessionMiddleware(secrets))

  router.get('/tasks', async (c) => {
    const ctx = await requireTaskRequestContext(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId, userId } = ctx

    const filters = parseTaskListFilters(c)
    if (filters instanceof Response) return filters

    const visibleIds = await listVisible(db, {
      kind: 'service',
      userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ tasks: [] })
    }

    const serviceIds = await resolveListedServiceIds(c, db, visibleIds, filters)
    if (serviceIds instanceof Response) return serviceIds

    const tasks = await listTasksForServices(db, serviceIds)
    return c.json({ tasks })
  })

  router.get('/tasks/:id', async (c) => {
    const ctx = await requireTaskRequestContext(c)
    if (ctx instanceof Response) return ctx

    const row = await loadTaskInOrganization(
      c,
      ctx.db,
      ctx.organizationId,
      c.req.param('id'),
    )
    if (row instanceof Response) return row

    const denied = await assertCanReadOr403(c, 'service', row.serviceId)
    if (denied) return denied

    return c.json({ task: row })
  })

  router.post('/tasks', async (c) => {
    const ctx = await requireTaskRequestContext(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const serviceId = requireStringField(c, body, 'serviceId')
    if (serviceId instanceof Response) return serviceId
    const invalidServiceId = invalidTaskIdResponse(c, serviceId, 'query')
    if (invalidServiceId) return invalidServiceId

    const denied = await assertTaskServiceCreatable(c, db, organizationId, serviceId)
    if (denied) return denied

    const fields = parseTaskCreateFields(c, body)
    if (fields instanceof Response) return fields

    const conflict = await assertTaskCreateCapacity(c, db, serviceId, fields.name)
    if (conflict) return conflict

    try {
      const { id } = await createTask(db, { serviceId, ...fields })
      return c.json({ ok: true, id })
    } catch (err) {
      return rethrowUnlessTaskNameConflict(c, err)
    }
  })

  router.patch('/tasks/:id', async (c) => {
    const ctx = await requireTaskRequestContext(c)
    if (ctx instanceof Response) return ctx
    const { db, organizationId } = ctx

    const row = await loadTaskInOrganization(c, db, organizationId, c.req.param('id'))
    if (row instanceof Response) return row

    const denied = await assertTaskServiceWritable(c, row.serviceId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const updateFields = buildTaskPatchFields(c, body)
    if (updateFields instanceof Response) return updateFields

    const renameConflict = await assertTaskRenameAvailable(
      c,
      db,
      row.serviceId,
      updateFields.name,
      row.id,
    )
    if (renameConflict) return renameConflict

    try {
      await updateTask(db, row.id, updateFields)
      return c.json({ ok: true })
    } catch (err) {
      return rethrowUnlessTaskNameConflict(c, err)
    }
  })

  router.delete('/tasks/:id', async (c) => {
    const ctx = await requireTaskRequestContext(c)
    if (ctx instanceof Response) return ctx

    const row = await loadTaskInOrganization(
      c,
      ctx.db,
      ctx.organizationId,
      c.req.param('id'),
    )
    if (row instanceof Response) return row

    const denied = await assertTaskServiceWritable(c, row.serviceId)
    if (denied) return denied

    await deleteTask(ctx.db, row.id)
    return c.json({ ok: true })
  })
}
