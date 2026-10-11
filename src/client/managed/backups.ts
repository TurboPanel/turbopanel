import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type {
  ManagedBackupCommandPayload,
  ManagedRestoreCommandPayload,
} from '../../contracts/commands/schemas.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import type { ManagedContext } from './context.ts'
import { enqueueTypedCommand } from '../../features/managed/apply-prepare.ts'
import type { ManagedRowOptions } from '../../features/managed/options.ts'
import { defaultBackupDatabase } from '../../features/managed/default-backup-database.ts'
import type { ManagedBackupRecord } from '../../features/backups/backup-records.ts'

/** Mirrors `COMMAND_TIMEOUT_MS['managed.backup' | 'managed.restore']` in `../../features/commands/consumer.ts`. */
const BACKUP_COMMAND_EXPIRES_MS = 1_800_000

export type ManagedBackupApiError =
  | { kind: 'managed_backup_unsupported' }
  | {
      kind: 'backup_not_found'
    }

export function mapManagedBackupApiError(
  c: Context<AppEnv>,
  error: ManagedBackupApiError
): Response {
  switch (error.kind) {
    case 'managed_backup_unsupported':
      return c.json({ error: 'managed_backup_unsupported' }, 400)
    case 'backup_not_found':
      return c.json({ error: 'backup_not_found' }, 404)
  }
}

export function isManagedBackupApiError(value: unknown): value is ManagedBackupApiError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/** List/API projection: internal `serverId` is `storedOnServerId` on the wire. */
export type ManagedBackupListItem = Omit<ManagedBackupRecord, 'serverId'> & {
  storedOnServerId?: string
}

export function toManagedBackupListItem(record: ManagedBackupRecord): ManagedBackupListItem {
  const { serverId, ...rest } = record
  return serverId === undefined ? rest : { ...rest, storedOnServerId: serverId }
}

/**
 * Artifact host when known; otherwise the current primary (legacy rows, or
 * after that server was deleted).
 */
export function resolveManagedBackupArtifactServerId(
  record: Pick<ManagedBackupRecord, 'serverId'>,
  fallbackServerId: string
): string {
  return record.serverId ?? fallbackServerId
}

export function backupOnOtherServerMessage(serverName: string): string {
  return (
    `This backup is stored on ${serverName} (it was the primary when the backup ran). ` +
    'It can only be restored on that server. Take a new backup on the current primary, or switch back first.'
  )
}

/**
 * Restores run on the current primary, which only has the file when it is
 * still the host that made it. Refuse before any status flip or enqueue.
 */
export async function refuseRestoreIfBackupOnOtherServer(
  c: Context<AppEnv>,
  db: Db,
  record: ManagedBackupRecord,
  targetServerId: string
): Promise<Response | null> {
  if (record.serverId === undefined || record.serverId === targetServerId) {
    return null
  }
  const [host] = await db
    .select({ name: server.name })
    .from(server)
    .where(eq(server.id, record.serverId))
    .limit(1)
  return c.json(
    {
      error: 'backup_on_other_server',
      message: backupOnOtherServerMessage(host?.name ?? 'another server'),
    },
    409
  )
}

/** `bk_<32 hex chars>` — satisfies the daemon/instance shared `SAFE_BACKUP_ID_RE` charset. */
function generateBackupId(): string {
  return `bk_${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * Body `database` must already be a database configured on this managed
 * instance; when omitted, default to the first configured (initial) database
 * that is not a MySQL-family system schema.
 */
export function resolveBackupDatabase(
  options: ManagedRowOptions,
  requested: unknown,
  engine?: string
): string | null {
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !options.databases.includes(requested)) {
      return null
    }
    return requested
  }
  return defaultBackupDatabase(options.databases, engine)
}

/** Clamp `settings.backups.retentionKeep` (or the engine default) to the engine's `maxRetentionKeep`. */
function resolveRetentionKeep(ctx: ManagedContext, options: ManagedRowOptions): number | undefined {
  const backup = ctx.spec.backup
  if (!backup) return undefined
  const requested = options.settings.backups?.retentionKeep ?? backup.defaultRetentionKeep
  return Math.min(requested, backup.maxRetentionKeep)
}

export function buildManagedBackupCreatePayload(
  ctx: ManagedContext,
  managedId: string,
  options: ManagedRowOptions,
  database: string
): { payload: ManagedBackupCommandPayload; backupId: string } | ManagedBackupApiError {
  const backup = ctx.spec.backup
  if (!backup) return { kind: 'managed_backup_unsupported' }

  const backupId = generateBackupId()
  const payload: ManagedBackupCommandPayload = {
    managedId,
    engine: ctx.spec.engine,
    action: 'create',
    backupId,
    artifactExtension: backup.artifactExtension,
    scope: 'database',
    database,
  }
  const retentionKeep = resolveRetentionKeep(ctx, options)
  if (retentionKeep !== undefined) payload.retentionKeep = retentionKeep

  return { payload, backupId }
}

export function buildManagedBackupDeletePayload(
  ctx: ManagedContext,
  managedId: string,
  record: ManagedBackupRecord
): { payload: ManagedBackupCommandPayload } | ManagedBackupApiError {
  const backup = ctx.spec.backup
  if (!backup) return { kind: 'managed_backup_unsupported' }

  const payload: ManagedBackupCommandPayload = {
    managedId,
    engine: ctx.spec.engine,
    action: 'delete',
    backupId: record.id,
    artifactExtension: backup.artifactExtension,
    scope: record.database !== undefined ? 'database' : 'instance',
  }
  if (record.database !== undefined) payload.database = record.database
  // A scheduled backup lives in its own policy directory on the host: without
  // the policy id the daemon looks in the manual-backup directory, removes
  // nothing and still reports success.
  if (record.retentionId !== undefined) payload.policyId = record.retentionId
  return { payload }
}

export function buildManagedRestorePayload(
  ctx: ManagedContext,
  managedId: string,
  record: ManagedBackupRecord
): { payload: ManagedRestoreCommandPayload } | ManagedBackupApiError {
  const backup = ctx.spec.backup
  if (!backup) return { kind: 'managed_backup_unsupported' }

  const payload: ManagedRestoreCommandPayload = {
    managedId,
    engine: ctx.spec.engine,
    backupId: record.id,
    artifactExtension: backup.artifactExtension,
    checksum: record.checksum,
    sizeBytes: record.sizeBytes,
  }
  if (record.database !== undefined) payload.database = record.database
  // A scheduled backup lives in its own policy directory on the host, so the
  // daemon needs the policy id to find it. It comes from the stored row, never
  // from the request.
  if (record.retentionId !== undefined) payload.policyId = record.retentionId
  return { payload }
}

/**
 * Read-only — never flips `managed.status`. A failed/timed-out backup must
 * never mark a healthy engine as `failed` (see `consumer.ts`
 * `applyManagedFailedSideEffect`).
 */
export async function enqueueManagedBackup(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    payload: ManagedBackupCommandPayload
  }
): Promise<{ ok: true; commandId: string; status: 'queued'; serverId: string } | Response> {
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.backup',
    payload: params.payload,
    expiresAtMs: BACKUP_COMMAND_EXPIRES_MS,
  })
}

/**
 * Mutates the running engine, so — like `managed.apply` — flips
 * `managed.status` to `'applying'` before enqueue.
 */
export async function enqueueManagedRestore(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    userId: string
    serverId: string
    managedId: string
    payload: ManagedRestoreCommandPayload
  }
): Promise<{ ok: true; commandId: string; status: 'queued'; serverId: string } | Response> {
  return enqueueTypedCommand(c, db, commandQueue, {
    userId: params.userId,
    serverId: params.serverId,
    type: 'managed.restore',
    payload: params.payload,
    expiresAtMs: BACKUP_COMMAND_EXPIRES_MS,
    managedId: params.managedId,
    setApplying: true,
  })
}
