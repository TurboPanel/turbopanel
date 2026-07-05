import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { nowIso } from '../commands/ids.ts'
import type { CommandStatus } from '../commands/types.ts'
import { command } from './schema.ts'

type CommandDbRow = typeof command.$inferSelect

type CommandMetadata = {
  error?: string | null
  createdAt?: string
  updatedAt?: string
  queuedAt?: string | null
  dispatchStartedAt?: string | null
  sentAt?: string | null
  ackedAt?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  expiresAt?: string | null
}

export type CommandRecord = {
  id: string
  serverId: string
  actorEntityType: string
  actorEntityId: string
  type: string
  status: CommandStatus
  payload: unknown
  result: unknown | null
  error: string | null
  attempts: number
  createdAt: string
  updatedAt: string
  queuedAt: string | null
  dispatchStartedAt: string | null
  sentAt: string | null
  ackedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  expiresAt: string | null
}

type CreateCommandRecordParams = {
  serverId: string
  actorEntityType: string
  actorEntityId: string
  type: string
  payload: unknown
  expiresAt?: string
}

type ListServerCommandsParams = {
  serverId: string
  limit?: number
}

type CommandTransitionPatch = {
  status: CommandStatus
  result?: unknown
  error?: string
  attempts?: number
  queuedAt?: string
  dispatchStartedAt?: string
  sentAt?: string
  ackedAt?: string
  startedAt?: string
  finishedAt?: string
}

const STATUS_TIMESTAMP_FIELD: Partial<
  Record<CommandStatus, keyof CommandTransitionPatch>
> = {
  queued: 'queuedAt',
  dispatching: 'dispatchStartedAt',
  sent: 'sentAt',
  acked: 'ackedAt',
  running: 'startedAt',
  succeeded: 'finishedAt',
  failed: 'finishedAt',
  timed_out: 'finishedAt',
  cancelled: 'finishedAt',
}

const LIFECYCLE_TIMESTAMP_FIELDS = [
  'queuedAt',
  'dispatchStartedAt',
  'sentAt',
  'ackedAt',
  'startedAt',
  'finishedAt',
] as const

export function serializeCommandRecord(row: CommandDbRow): CommandRecord {
  const meta = (row.metadata ?? {}) as CommandMetadata
  return {
    id: row.id,
    serverId: row.serverId,
    actorEntityType: row.actorEntityType,
    actorEntityId: row.actorEntityId,
    type: row.name,
    status: (row.status ?? 'queued') as CommandStatus,
    payload: row.payload,
    result: row.result ?? null,
    error: meta.error ?? null,
    attempts: row.attempts ?? 0,
    createdAt: meta.createdAt ?? '',
    updatedAt: meta.updatedAt ?? '',
    queuedAt: meta.queuedAt ?? null,
    dispatchStartedAt: meta.dispatchStartedAt ?? null,
    sentAt: meta.sentAt ?? null,
    ackedAt: meta.ackedAt ?? null,
    startedAt: meta.startedAt ?? null,
    finishedAt: meta.finishedAt ?? null,
    expiresAt: meta.expiresAt ?? null,
  }
}

export async function createCommandRecord(
  db: Db,
  params: CreateCommandRecordParams,
): Promise<CommandRecord> {
  const now = nowIso()
  const metadata: CommandMetadata = {
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
  }

  const rows = await db
    .insert(command)
    .values({
      serverId: params.serverId,
      actorEntityType: params.actorEntityType,
      actorEntityId: params.actorEntityId,
      name: params.type,
      status: 'queued',
      attempts: 0,
      payload: params.payload,
      metadata,
    })
    .returning()

  const row = rows[0]
  if (!row) {
    throw new Error('Failed to create command record')
  }
  return serializeCommandRecord(row)
}

export async function getCommandRecord(
  db: Db,
  commandId: string,
): Promise<CommandRecord | null> {
  const rows = await db
    .select()
    .from(command)
    .where(eq(command.id, commandId))
    .limit(1)
  const row = rows[0]
  return row ? serializeCommandRecord(row) : null
}

export async function listServerCommands(
  db: Db,
  params: ListServerCommandsParams,
): Promise<CommandRecord[]> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)

  const rows = await db
    .select()
    .from(command)
    .where(eq(command.serverId, params.serverId))
    .orderBy(sql`${command.metadata}->>'createdAt' DESC`)
    .limit(limit)

  return rows.map(serializeCommandRecord)
}

export async function transitionCommand(
  db: Db,
  commandId: string,
  patch: CommandTransitionPatch,
): Promise<CommandRecord | null> {
  const now = nowIso()
  const metadataPatch: Record<string, unknown> = {
    updatedAt: now,
  }

  if (patch.error !== undefined) {
    metadataPatch.error = patch.error
  }

  for (const field of LIFECYCLE_TIMESTAMP_FIELDS) {
    const value = patch[field]
    if (value !== undefined) {
      metadataPatch[field] = value
    }
  }

  const statusField = STATUS_TIMESTAMP_FIELD[patch.status]
  if (statusField && patch[statusField] === undefined) {
    metadataPatch[statusField] = now
  }

  const rows = await db
    .update(command)
    .set({
      status: patch.status,
      ...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
      ...(patch.result === undefined ? {} : { result: patch.result }),
      metadata: sql`${command.metadata} || ${JSON.stringify(metadataPatch)}::jsonb`,
    })
    .where(eq(command.id, commandId))
    .returning()

  const row = rows[0]
  return row ? serializeCommandRecord(row) : null
}
