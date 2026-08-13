import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { nowIso } from '../commands/ids.ts'
import { task } from './schema.ts'

/**
 * Scheduled instances of a logical service. Row identity and `created_at`
 * survive a re-plan (upsert on `(service_id, slot)`). A task whose `server_id`
 * is unchanged is rewritten only for `generation` (plus `desiredState` /
 * `updatedAt`) — this helper never re-homes a task the caller did not move.
 * The planner owns movement decisions by passing a different `serverId`.
 */
export const TASK_DESIRED_STATES = Object.freeze(
  ['running', 'stopped', 'removed'] as const,
)

export type TaskDesiredState = (typeof TASK_DESIRED_STATES)[number]

type TaskDbRow = typeof task.$inferSelect

export type TaskRecord = {
  id: string
  createdAt: string
  updatedAt: string
  metadata: unknown
  options: unknown
  environmentId: string
  serviceId: string
  serverId: string
  slot: number
  generation: number
  desiredState: TaskDesiredState
}

export type DesiredTaskInput = {
  serviceId: string
  serverId: string
  slot: number
  desiredState?: TaskDesiredState
}

function isTaskDesiredState(value: string): value is TaskDesiredState {
  return (TASK_DESIRED_STATES as readonly string[]).includes(value)
}

export function serializeTask(row: TaskDbRow): TaskRecord {
  const desiredState = isTaskDesiredState(row.desiredState) ? row.desiredState : 'running'
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata ?? null,
    options: row.options ?? null,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    serverId: row.serverId,
    slot: row.slot,
    generation: row.generation,
    desiredState,
  }
}

function sortTasks(records: TaskRecord[]): TaskRecord[] {
  return [...records].sort((a, b) => {
    const byService = a.serviceId.localeCompare(b.serviceId)
    if (byService !== 0) return byService
    return a.slot - b.slot
  })
}

function taskKey(serviceId: string, slot: number): string {
  return `${serviceId}:${String(slot)}`
}

export async function replaceEnvironmentTasks(
  db: Db,
  params: {
    environmentId: string
    generation: number
    tasks: readonly DesiredTaskInput[]
  },
): Promise<void> {
  const now = nowIso()
  const desiredKeys = new Set(
    params.tasks.map((item) => taskKey(item.serviceId, item.slot)),
  )

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: task.id,
        serviceId: task.serviceId,
        slot: task.slot,
      })
      .from(task)
      .where(eq(task.environmentId, params.environmentId))

    for (const item of params.tasks) {
      await tx
        .insert(task)
        .values({
          environmentId: params.environmentId,
          serviceId: item.serviceId,
          serverId: item.serverId,
          slot: item.slot,
          generation: params.generation,
          desiredState: item.desiredState ?? 'running',
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [task.serviceId, task.slot],
          set: {
            serverId: item.serverId,
            generation: params.generation,
            desiredState: item.desiredState ?? 'running',
            updatedAt: now,
          },
        })
    }

    const staleIds = existing
      .filter((row) => !desiredKeys.has(taskKey(row.serviceId, row.slot)))
      .map((row) => row.id)
    if (staleIds.length === 0) return

    await tx.delete(task).where(inArray(task.id, staleIds))
  })
}

export async function listEnvironmentTasks(
  db: Db,
  environmentId: string,
  opts?: { generation?: number },
): Promise<TaskRecord[]> {
  const filter = opts?.generation === undefined
    ? eq(task.environmentId, environmentId)
    : and(
      eq(task.environmentId, environmentId),
      eq(task.generation, opts.generation),
    )

  const rows = await db
    .select()
    .from(task)
    .where(filter)
    .orderBy(task.serviceId, task.slot)

  return sortTasks(rows.map(serializeTask))
}

export async function listTasksForServer(
  db: Db,
  params: { serverId: string; environmentId?: string },
): Promise<TaskRecord[]> {
  const filter = params.environmentId === undefined
    ? eq(task.serverId, params.serverId)
    : and(
      eq(task.serverId, params.serverId),
      eq(task.environmentId, params.environmentId),
    )

  const rows = await db
    .select()
    .from(task)
    .where(filter)
    .orderBy(task.serviceId, task.slot)

  return sortTasks(rows.map(serializeTask))
}
