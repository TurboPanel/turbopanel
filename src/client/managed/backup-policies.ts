/**
 * Scheduled backup policies for a managed engine: request parsing,
 * serialization and the route bodies behind
 * `/environments/:id/managed/backup-policies`.
 *
 * Authorization happens before any of this (`authorizeManagedRequest` in
 * `manage` mode: org owners and managers). Every write that changes what a
 * host runs pushes the engine's server a full policy set
 * (`server.backups.reconcile`, best-effort — the outcome is reported, never
 * turned into an error, because the write itself has already succeeded).
 */

import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import type { ManagedContext } from './context.ts'
import {
  type BackupPolicyPatch,
  type BackupPolicyRow,
  type BackupRunRecord,
  deleteBackupPolicy,
  findBackupPolicyForManaged,
  insertManagedBackupPolicy,
  latestBackupRuns,
  listBackupPoliciesForManaged,
  listBackupRuns,
  MAX_BACKUP_POLICIES_PER_MANAGED,
  MAX_BACKUP_RUNS_PAGE,
  updateBackupPolicy,
} from '../../features/backups/policy-records.ts'
import {
  type BackupsReconcileOutcome,
  enqueueBackupsReconcile,
} from '../../features/backups/reconcile.ts'
import {
  describeBackupSchedule,
  isValidBackupTimezone,
  normalizeBackupScheduleInput,
  translateBackupSchedule,
} from '../../features/backups/schedules.ts'
import { MAX_BACKUP_POLICY_RETENTION_KEEP } from '../../features/backups/vocabulary.ts'

const MAX_POLICY_NAME_LENGTH = 64
const DEFAULT_RUNS_PAGE = 20

export type BackupPolicyScope = {
  db: Db
  auth: { userId: string; organizationId: string }
  ctx: ManagedContext
  row: { id: string; serverId: string | null }
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; field: string; detail: string }

function invalid<T>(field: string, detail: string): FieldResult<T> {
  return { ok: false, field, detail }
}

function invalidResponse(c: Context<AppEnv>, result: { field: string; detail: string }): Response {
  if (result.field === 'schedule') {
    return c.json({ error: 'backup_schedule_invalid', detail: result.detail }, 400)
  }
  if (result.field === 'timezone') {
    return c.json({ error: 'backup_timezone_invalid', detail: result.detail }, 400)
  }
  return c.json({ error: 'backup_policy_invalid', field: result.field, detail: result.detail }, 400)
}

function parseName(value: unknown): FieldResult<string> {
  if (typeof value !== 'string') return invalid('name', 'name is required')
  const name = value.trim()
  if (name.length === 0 || name.length > MAX_POLICY_NAME_LENGTH) {
    return invalid('name', `name must be 1 to ${MAX_POLICY_NAME_LENGTH} characters`)
  }
  return { ok: true, value: name }
}

function parseRetentionKeep(value: unknown, maxKeep: number): FieldResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maxKeep) {
    return invalid('retentionKeep', `retentionKeep must be a whole number from 1 to ${maxKeep}`)
  }
  return { ok: true, value }
}

function parseEnabled(value: unknown): FieldResult<boolean> {
  if (typeof value !== 'boolean') return invalid('enabled', 'enabled must be true or false')
  return { ok: true, value }
}

function parseTimezone(value: unknown): FieldResult<string | null> {
  if (value === null) return { ok: true, value: null }
  if (!isValidBackupTimezone(value)) {
    return invalid('timezone', 'timezone must be an IANA zone name, or null for host time')
  }
  return { ok: true, value }
}

/** Normalize the schedule, then prove it translates for the (possibly new) timezone. */
function parseSchedule(value: unknown, timezone: string | null): FieldResult<string> {
  const normalized = normalizeBackupScheduleInput(value)
  if (!normalized.ok) return invalid('schedule', normalized.error)
  const translated = translateBackupSchedule(normalized.value, timezone)
  if (!translated.ok) return invalid('schedule', translated.error)
  return { ok: true, value: normalized.value }
}

/** Retention for a managed engine: the engine's own cap, within the table's bound. */
function maxRetentionKeep(ctx: ManagedContext): number | null {
  const backup = ctx.spec.backup
  if (!backup) return null
  return Math.min(backup.maxRetentionKeep, MAX_BACKUP_POLICY_RETENTION_KEEP)
}

type CreateInput = {
  name: string
  schedule: string
  timezone: string | null
  retentionKeep: number
  isEnabled: boolean
}

function parseCreateBody(body: Record<string, unknown>, maxKeep: number): FieldResult<CreateInput> {
  const name = parseName(body.name)
  if (!name.ok) return name
  const timezone = parseTimezone(body.timezone ?? null)
  if (!timezone.ok) return timezone
  const schedule = parseSchedule(body.schedule, timezone.value)
  if (!schedule.ok) return schedule
  const retentionKeep = parseRetentionKeep(body.retentionKeep, maxKeep)
  if (!retentionKeep.ok) return retentionKeep
  const enabled = parseEnabled(body.enabled ?? true)
  if (!enabled.ok) return enabled
  return {
    ok: true,
    value: {
      name: name.value,
      schedule: schedule.value,
      timezone: timezone.value,
      retentionKeep: retentionKeep.value,
      isEnabled: enabled.value,
    },
  }
}

/** Fields that change what the host runs; a name-only edit pushes nothing. */
function patchTouchesHost(patch: BackupPolicyPatch): boolean {
  return (
    patch.schedule !== undefined ||
    patch.timezone !== undefined ||
    patch.retentionKeep !== undefined ||
    patch.isEnabled !== undefined
  )
}

function parsePatchSchedule(
  body: Record<string, unknown>,
  current: BackupPolicyRow,
  patch: BackupPolicyPatch
): FieldResult<void> {
  if (body.timezone !== undefined) {
    const timezone = parseTimezone(body.timezone)
    if (!timezone.ok) return timezone
    patch.timezone = timezone.value
  }
  const timezone = patch.timezone === undefined ? current.timezone : patch.timezone
  // A timezone change re-validates the stored schedule against the new zone.
  const scheduleInput = body.schedule === undefined ? current.schedule : body.schedule
  const schedule = parseSchedule(scheduleInput, timezone)
  if (!schedule.ok) return schedule
  if (body.schedule !== undefined) patch.schedule = schedule.value
  return { ok: true, value: undefined }
}

function parsePatchBody(
  body: Record<string, unknown>,
  current: BackupPolicyRow,
  maxKeep: number
): FieldResult<BackupPolicyPatch> {
  const patch: BackupPolicyPatch = {}
  if (body.name !== undefined) {
    const name = parseName(body.name)
    if (!name.ok) return name
    patch.name = name.value
  }
  if (body.retentionKeep !== undefined) {
    const keep = parseRetentionKeep(body.retentionKeep, maxKeep)
    if (!keep.ok) return keep
    patch.retentionKeep = keep.value
  }
  if (body.enabled !== undefined) {
    const enabled = parseEnabled(body.enabled)
    if (!enabled.ok) return enabled
    patch.isEnabled = enabled.value
  }
  if (body.schedule !== undefined || body.timezone !== undefined) {
    const schedule = parsePatchSchedule(body, current, patch)
    if (!schedule.ok) return schedule
  }
  return { ok: true, value: patch }
}

function serializeRun(run: BackupRunRecord) {
  return {
    runId: run.runId,
    serverId: run.serverId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    error: run.error,
    backupId: run.backupId,
  }
}

export function serializeBackupPolicy(row: BackupPolicyRow, lastRun: BackupRunRecord | null) {
  return {
    id: row.id,
    name: row.name,
    targetKind: row.targetKind,
    managedId: row.managedId,
    schedule: row.schedule,
    preset: describeBackupSchedule(row.schedule),
    timezone: row.timezone,
    retentionKeep: row.retentionKeep,
    enabled: row.isEnabled,
    automatic: row.createdBy === null,
    nextRunAt: row.nextRunAt,
    lastRun: lastRun ? serializeRun(lastRun) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function pushPolicySet(
  c: Context<AppEnv>,
  scope: BackupPolicyScope
): Promise<BackupsReconcileOutcome> {
  return await enqueueBackupsReconcile(
    scope.db,
    c.get('commandQueue'),
    { actorType: 'user', actorId: scope.auth.userId },
    [scope.row.serverId]
  )
}

export async function listBackupPoliciesResponse(
  c: Context<AppEnv>,
  db: Db,
  managedId: string
): Promise<Response> {
  const rows = await listBackupPoliciesForManaged(db, managedId)
  const latest = await latestBackupRuns(
    db,
    rows.map((row) => row.id)
  )
  return c.json({
    policies: rows.map((row) => serializeBackupPolicy(row, latest.get(row.id) ?? null)),
  })
}

export async function createBackupPolicyResponse(
  c: Context<AppEnv>,
  scope: BackupPolicyScope,
  body: Record<string, unknown>
): Promise<Response> {
  if (body.targetKind !== undefined && body.targetKind !== 'managed') {
    return c.json({ error: 'backup_target_unsupported' }, 400)
  }
  const maxKeep = maxRetentionKeep(scope.ctx)
  if (maxKeep === null) return c.json({ error: 'managed_backup_unsupported' }, 400)

  const parsed = parseCreateBody(body, maxKeep)
  if (!parsed.ok) return invalidResponse(c, parsed)

  const existing = await listBackupPoliciesForManaged(scope.db, scope.row.id)
  if (existing.length >= MAX_BACKUP_POLICIES_PER_MANAGED) {
    return c.json({ error: 'backup_policy_limit', limit: MAX_BACKUP_POLICIES_PER_MANAGED }, 409)
  }

  const row = await insertManagedBackupPolicy(scope.db, {
    ...parsed.value,
    organizationId: scope.auth.organizationId,
    managedId: scope.row.id,
    createdBy: scope.auth.userId,
  })
  const reconcile = await pushPolicySet(c, scope)
  return c.json({ policy: serializeBackupPolicy(row, null), reconcile }, 201)
}

export async function updateBackupPolicyResponse(
  c: Context<AppEnv>,
  scope: BackupPolicyScope,
  policyId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const current = await findBackupPolicyForManaged(scope.db, scope.row.id, policyId)
  if (!current) return c.json({ error: 'backup_policy_not_found' }, 404)
  const maxKeep = maxRetentionKeep(scope.ctx)
  if (maxKeep === null) return c.json({ error: 'managed_backup_unsupported' }, 400)

  const parsed = parsePatchBody(body, current, maxKeep)
  if (!parsed.ok) return invalidResponse(c, parsed)
  if (Object.keys(parsed.value).length === 0) {
    return c.json({ policy: serializeBackupPolicy(current, null), reconcile: null })
  }

  const row = (await updateBackupPolicy(scope.db, policyId, parsed.value)) ?? current
  const reconcile = patchTouchesHost(parsed.value) ? await pushPolicySet(c, scope) : null
  return c.json({ policy: serializeBackupPolicy(row, null), reconcile })
}

export async function deleteBackupPolicyResponse(
  c: Context<AppEnv>,
  scope: BackupPolicyScope,
  policyId: string
): Promise<Response> {
  const current = await findBackupPolicyForManaged(scope.db, scope.row.id, policyId)
  if (!current) return c.json({ error: 'backup_policy_not_found' }, 404)
  await deleteBackupPolicy(scope.db, policyId)
  const reconcile = await pushPolicySet(c, scope)
  return c.json({ ok: true, reconcile })
}

function parseRunsLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RUNS_PAGE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) return DEFAULT_RUNS_PAGE
  return Math.min(value, MAX_BACKUP_RUNS_PAGE)
}

export async function listBackupRunsResponse(
  c: Context<AppEnv>,
  db: Db,
  managedId: string,
  policyId: string
): Promise<Response> {
  const policy = await findBackupPolicyForManaged(db, managedId, policyId)
  if (!policy) return c.json({ error: 'backup_policy_not_found' }, 404)
  const runs = await listBackupRuns(db, policyId, parseRunsLimit(c.req.query('limit')))
  return c.json({ runs: runs.map(serializeRun) })
}
