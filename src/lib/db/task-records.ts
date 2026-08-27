import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { nowIso } from '../commands/ids.ts'
import { isValidDisplayName, normalizeDisplayName } from '../display-name-format.ts'
import { task } from './schema.ts'

export const TASK_CONCURRENCY_POLICIES = ['allow', 'forbid', 'replace'] as const

export type TaskConcurrencyPolicy = typeof TASK_CONCURRENCY_POLICIES[number]

type TaskDbRow = typeof task.$inferSelect

export type TaskRecord = {
  id: string
  serviceId: string
  name: string
  schedule: string
  command: string
  timezone: string | null
  isEnabled: boolean
  concurrencyPolicy: TaskConcurrencyPolicy
  timeoutSeconds: number | null
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

export type TaskUpdateFields = {
  name?: string
  schedule?: string
  command?: string
  timezone?: string | null
  isEnabled?: boolean
  concurrencyPolicy?: TaskConcurrencyPolicy
  timeoutSeconds?: number | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

const TASK_UNIQUE_INDEX = 'uniq_task_service_name'

export type ParseTaskNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string }

/** Parse/normalize a task label. Schema has no name-format CHECK. */
export function parseTaskNameInput(value: unknown): ParseTaskNameResult {
  if (typeof value !== 'string') {
    return { ok: false, error: 'Invalid request' }
  }
  const name = normalizeDisplayName(value)
  if (!isValidDisplayName(name)) {
    return { ok: false, error: 'Invalid request' }
  }
  return { ok: true, name }
}

function requireTaskName(value: unknown): string {
  const parsed = parseTaskNameInput(value)
  if (!parsed.ok) {
    throw new TypeError(parsed.error)
  }
  return parsed.name
}

function asConcurrencyPolicy(value: string): TaskConcurrencyPolicy {
  if ((TASK_CONCURRENCY_POLICIES as readonly string[]).includes(value)) {
    return value as TaskConcurrencyPolicy
  }
  throw new TypeError(`unexpected concurrency policy: ${value}`)
}

export function serializeTask(row: TaskDbRow): TaskRecord {
  return {
    id: row.id,
    serviceId: row.serviceId,
    name: row.name,
    schedule: row.schedule,
    command: row.command,
    timezone: row.timezone,
    isEnabled: row.isEnabled,
    concurrencyPolicy: asConcurrencyPolicy(row.concurrencyPolicy),
    timeoutSeconds: row.timeoutSeconds,
    metadata: row.metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function sortTaskRecords(records: TaskRecord[]): TaskRecord[] {
  return [...records].sort((a, b) => a.name.localeCompare(b.name))
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

export function isTaskUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes(TASK_UNIQUE_INDEX)
}

export async function listTasksForService(
  db: Db,
  serviceId: string,
): Promise<TaskRecord[]> {
  const rows = await db
    .select()
    .from(task)
    .where(eq(task.serviceId, serviceId))

  return sortTaskRecords(rows.map(serializeTask))
}

export async function listTasksForServices(
  db: Db,
  serviceIds: readonly string[],
): Promise<TaskRecord[]> {
  if (serviceIds.length === 0) return []

  const rows = await db
    .select()
    .from(task)
    .where(inArray(task.serviceId, [...serviceIds]))

  return sortTaskRecords(rows.map(serializeTask))
}

export async function getTask(
  db: Db,
  id: string,
): Promise<TaskRecord | null> {
  const [row] = await db.select().from(task).where(eq(task.id, id)).limit(1)
  return row ? serializeTask(row) : null
}

export async function createTask(
  db: Db,
  values: {
    serviceId: string
    name: string
    schedule: string
    command: string
    timezone?: string | null
    isEnabled?: boolean
    concurrencyPolicy?: TaskConcurrencyPolicy
    timeoutSeconds?: number | null
    metadata?: Record<string, unknown> | null
    options?: Record<string, unknown> | null
  },
): Promise<{ id: string }> {
  const name = requireTaskName(values.name)
  const [inserted] = await db
    .insert(task)
    .values({
      serviceId: values.serviceId,
      name,
      schedule: values.schedule,
      command: values.command,
      ...(values.timezone !== undefined ? { timezone: values.timezone } : {}),
      ...(values.isEnabled !== undefined ? { isEnabled: values.isEnabled } : {}),
      ...(values.concurrencyPolicy !== undefined
        ? { concurrencyPolicy: values.concurrencyPolicy }
        : {}),
      ...(values.timeoutSeconds !== undefined ? { timeoutSeconds: values.timeoutSeconds } : {}),
      ...(values.metadata !== undefined && values.metadata !== null
        ? { metadata: values.metadata }
        : {}),
      ...(values.options !== undefined && values.options !== null
        ? { options: values.options }
        : {}),
      updatedAt: nowIso(),
    })
    .returning({ id: task.id })

  if (!inserted) {
    throw new TypeError('task insert returned no row')
  }
  return { id: inserted.id }
}

export async function updateTask(
  db: Db,
  id: string,
  fields: TaskUpdateFields,
): Promise<void> {
  const patch: TaskUpdateFields = { ...fields }
  if (patch.name !== undefined) {
    patch.name = requireTaskName(patch.name)
  }
  await db.update(task).set(patch).where(eq(task.id, id))
}

export async function deleteTask(db: Db, id: string): Promise<void> {
  await db.delete(task).where(eq(task.id, id))
}

export async function countTasksForService(
  db: Db,
  serviceId: string,
): Promise<number> {
  const rows = await db
    .select({ id: task.id })
    .from(task)
    .where(eq(task.serviceId, serviceId))
  return rows.length
}
