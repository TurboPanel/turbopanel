/**
 * Backups of one storage copy: scheduled policies
 * (`/storage/:id/copies/:copyId/backup-policies`) and manual backups
 * (`/storage/:id/copies/:copyId/backups`). The copy's bytes are archived live
 * (no pause) on the copy's own server; see `features/backups/copy-targets.ts`
 * for which copies can be backed up and from where.
 *
 * Every route requires `manage` on the storage (org owners and managers, the
 * same bar as a managed engine's backups), and the copy must belong to that
 * storage.
 *
 * Restore (`…/backups/:backupId/restore`) replaces the copy's contents with
 * one archive. The host stops the containers that mount the copy for the
 * swap and starts them again; see `storage.restore` in
 * `features/commands/payload-contracts.md`.
 */

import type { Hono, Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { parseJsonBody } from '../shared.ts'
import type { Db } from '../../db/connection.ts'
import { isUuid } from '../../features/principals/store.ts'
import type {
  CopyBackupSource,
  StorageBackupCommandPayload,
  StorageRestoreCommandPayload,
} from '../../contracts/commands/schemas.ts'
import {
  type CopyTargetRow,
  loadCopyTarget,
  resolveCopyBackupSource,
} from '../../features/backups/copy-targets.ts'
import { MAX_BACKUP_POLICY_RETENTION_KEEP } from '../../features/backups/vocabulary.ts'
import {
  type ArchiveRecord,
  findArchiveById,
  listArchives,
} from '../../features/backups/archive-records.ts'
import { enqueueTypedCommand } from '../../features/managed/apply-prepare.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { assertTargetServerOnline } from '../managed/context.ts'
import {
  type BackupPolicyTargetScope,
  createPolicyForTarget,
  deletePolicyForTarget,
  listPoliciesForTarget,
  listRunsForTarget,
  updatePolicyForTarget,
} from '../managed/backup-policies.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import { requireStorageForNested, resolveStorageSessionContext } from './routes.ts'

/** Mirrors `COMMAND_TIMEOUT_MS['storage.backup' | 'storage.restore']` in `../../features/commands/consumer.ts`. */
const STORAGE_COMMAND_EXPIRES_MS = 1_800_000

const POLICIES_PATH = '/storage/:id/copies/:copyId/backup-policies'
const POLICY_PATH = `${POLICIES_PATH}/:policyId`
const POLICY_RUNS_PATH = `${POLICY_PATH}/runs`
const BACKUPS_PATH = '/storage/:id/copies/:copyId/backups'
const BACKUP_PATH = `${BACKUPS_PATH}/:backupId`
const RESTORE_PATH = `${BACKUP_PATH}/restore`

type CopyScope = {
  db: Db
  auth: { userId: string; organizationId: string }
  copy: CopyTargetRow
}

/** Session, org, `manage` on the storage, and the copy under it (404 when it is not that storage's). */
async function loadCopyScope(c: Context<AppEnv>): Promise<CopyScope | Response> {
  const ctx = await resolveStorageSessionContext(c)
  if (ctx instanceof Response) return ctx
  const storageId = c.req.param('id') as string
  const storageRow = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
  if (storageRow instanceof Response) return storageRow

  const copyId = c.req.param('copyId') as string
  if (!isUuid(copyId)) return c.json({ error: 'Not found' }, 404)
  const copy = await loadCopyTarget(ctx.db, copyId)
  if (copy?.storageId !== storageId) return c.json({ error: 'Not found' }, 404)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  return { db: ctx.db, auth: { userId: session.userId, organizationId: ctx.orgId }, copy }
}

function policyScope(scope: CopyScope): BackupPolicyTargetScope {
  return {
    db: scope.db,
    auth: scope.auth,
    target: { kind: 'copy', copyId: scope.copy.copyId },
    serverId: scope.copy.serverId,
    maxRetentionKeep: MAX_BACKUP_POLICY_RETENTION_KEEP,
  }
}

function unsupported(c: Context<AppEnv>, detail: string): Response {
  return c.json({ error: 'backup_target_unsupported', detail }, 400)
}

/** `bk_<32 hex chars>`, the id the daemon's artifact filename uses. */
function generateBackupId(): string {
  return `bk_${crypto.randomUUID().replaceAll('-', '')}`
}

/** The copy's server, online, with somewhere to queue the command. */
async function resolveDispatch(
  c: Context<AppEnv>,
  scope: CopyScope
): Promise<{ serverId: string; queue: CommandQueue } | Response> {
  const serverId = scope.copy.serverId
  if (!serverId) return c.json({ error: 'server_placement_required' }, 409)
  const offline = await assertTargetServerOnline(c, scope.db, serverId)
  if (offline) return offline
  const queue = assertDispatchInfrastructure(c)
  if (queue instanceof Response) return queue
  return { serverId, queue }
}

type StorageCommand =
  | { type: 'storage.backup'; payload: StorageBackupCommandPayload }
  | { type: 'storage.restore'; payload: StorageRestoreCommandPayload }

async function enqueueStorageCommand(
  c: Context<AppEnv>,
  scope: CopyScope,
  command: StorageCommand
): Promise<Response> {
  const dispatch = await resolveDispatch(c, scope)
  if (dispatch instanceof Response) return dispatch
  const { payload } = command
  const enqueued = await enqueueTypedCommand(c, scope.db, dispatch.queue, {
    userId: scope.auth.userId,
    serverId: dispatch.serverId,
    type: command.type,
    payload,
    expiresAtMs: STORAGE_COMMAND_EXPIRES_MS,
  })
  if (enqueued instanceof Response) return enqueued
  return c.json({
    ok: true,
    backupId: payload.backupId,
    commandId: enqueued.commandId,
    serverId: enqueued.serverId,
  })
}

/** Which archive, and how to verify it: always from the `archive` row, never the request. */
export function buildStorageRestorePayload(
  source: CopyBackupSource,
  record: Pick<ArchiveRecord, 'id' | 'checksum' | 'policyId'>
): StorageRestoreCommandPayload {
  const payload: StorageRestoreCommandPayload = {
    ...source,
    backupId: record.id,
    checksum: record.checksum,
  }
  if (record.policyId) payload.policyId = record.policyId
  return payload
}

function registerPolicyRoutes(router: Hono<AppEnv>): void {
  router.get(POLICIES_PATH, async (c) => {
    const scope = await loadCopyScope(c)
    if (scope instanceof Response) return scope
    return await listPoliciesForTarget(c, scope.db, { kind: 'copy', copyId: scope.copy.copyId })
  })

  router.post(POLICIES_PATH, async (c) => {
    const scope = await loadCopyScope(c)
    if (scope instanceof Response) return scope
    const source = resolveCopyBackupSource(scope.copy)
    if (!source.ok) return unsupported(c, source.error)
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    return await createPolicyForTarget(c, policyScope(scope), body)
  })

  router.patch(POLICY_PATH, async (c) => {
    const scope = await loadCopyScope(c)
    if (scope instanceof Response) return scope
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    return await updatePolicyForTarget(c, policyScope(scope), c.req.param('policyId'), body)
  })

  router.delete(POLICY_PATH, async (c) => {
    const scope = await loadCopyScope(c)
    if (scope instanceof Response) return scope
    return await deletePolicyForTarget(c, policyScope(scope), c.req.param('policyId'))
  })

  router.get(POLICY_RUNS_PATH, async (c) => {
    const scope = await loadCopyScope(c)
    if (scope instanceof Response) return scope
    return await listRunsForTarget(
      c,
      scope.db,
      { kind: 'copy', copyId: scope.copy.copyId },
      c.req.param('policyId')
    )
  })
}

function registerManualBackupRoutes(router: Hono<AppEnv>): void {
  router.get(BACKUPS_PATH, async (c) => {
    const scope = await loadCopyScope(c)
    if (scope instanceof Response) return scope
    return c.json({ backups: await listArchives(scope.db, scope.copy.copyId) })
  })

  router.post(BACKUPS_PATH, async (c) => {
    const scope = await loadCopyScope(c)
    if (scope instanceof Response) return scope
    const source = resolveCopyBackupSource(scope.copy)
    if (!source.ok) return unsupported(c, source.error)
    return await enqueueStorageCommand(c, scope, {
      type: 'storage.backup',
      payload: { ...source.source, action: 'create', backupId: generateBackupId() },
    })
  })

  router.delete(BACKUP_PATH, async (c) => {
    const scope = await loadCopyScope(c)
    if (scope instanceof Response) return scope
    const backupId = decodeURIComponent(c.req.param('backupId'))
    const record = await findArchiveById(scope.db, scope.copy.copyId, backupId)
    if (!record) return c.json({ error: 'backup_not_found' }, 404)
    const source = resolveCopyBackupSource(scope.copy)
    if (!source.ok) return unsupported(c, source.error)
    const payload: StorageBackupCommandPayload = {
      ...source.source,
      action: 'delete',
      backupId: record.id,
    }
    if (record.policyId) payload.policyId = record.policyId
    return await enqueueStorageCommand(c, scope, { type: 'storage.backup', payload })
  })

  // The archive's checksum and retention come from its row, never the body:
  // the host refuses an artifact whose sha256 differs before stopping anything.
  router.post(RESTORE_PATH, async (c) => {
    const scope = await loadCopyScope(c)
    if (scope instanceof Response) return scope
    const backupId = decodeURIComponent(c.req.param('backupId'))
    const record = await findArchiveById(scope.db, scope.copy.copyId, backupId)
    if (!record) return c.json({ error: 'backup_not_found' }, 404)
    const source = resolveCopyBackupSource(scope.copy)
    if (!source.ok) return unsupported(c, source.error)
    return await enqueueStorageCommand(c, scope, {
      type: 'storage.restore',
      payload: buildStorageRestorePayload(source.source, record),
    })
  })
}

export function registerStorageBackupRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts): void {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for storage backup routes')
  }
  const session = createSessionMiddleware(opts.secrets)
  for (const path of [
    POLICIES_PATH,
    POLICY_PATH,
    POLICY_RUNS_PATH,
    BACKUPS_PATH,
    BACKUP_PATH,
    RESTORE_PATH,
  ]) {
    router.use(path, session)
  }
  registerPolicyRoutes(router)
  registerManualBackupRoutes(router)
}
