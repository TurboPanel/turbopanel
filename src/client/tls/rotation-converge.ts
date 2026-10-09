/**
 * Organization CA rotation convergence: backfill deferred `managed.apply`
 * command ids, mark gone targets skipped, and decide when retire may proceed.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { command, managed, replica, server } from '../../db/schema.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  enqueuePreparedManagedApply,
  isPrepareError,
  prepareManagedApplyPayloads,
} from '../../features/managed/apply-prepare.ts'
import { getManagedEngineSpec } from '../../features/managed/index.ts'
import { parseManagedRowOptions } from '../../features/managed/options.ts'
import { parseManagedResidual } from '../../features/managed/serialize.ts'
import type {
  CaRotationResultRow,
  OrganizationRotationMember,
  OrganizationRotationTargets,
} from './changeover-fanout.ts'
import { enumerateOrganizationRotationTargets } from './changeover-fanout.ts'

export const CA_ROTATION_TARGET_GONE = 'target_gone'

const PENDING_STATUSES = new Set(['queued', 'dispatching', 'sent', 'acked', 'running'])

export function rotationApplyRowKey(managedId: string, serverId: string): string {
  return `${managedId}:${serverId}`
}

function findApplyRow(
  rows: readonly CaRotationResultRow[],
  managedId: string,
  serverId: string
): CaRotationResultRow | undefined {
  return rows.find(
    (row) => row.kind === 'apply' && row.managedId === managedId && row.serverId === serverId
  )
}

export function rotationRowConverged(
  row: CaRotationResultRow,
  effectiveStatus: string,
  effectiveError?: string
): boolean {
  if (row.status === 'skipped' && row.error === CA_ROTATION_TARGET_GONE) {
    return true
  }
  if (effectiveError === CA_ROTATION_TARGET_GONE) return true
  if (effectiveStatus === 'succeeded') return true
  if (row.kind === 'binding' && effectiveStatus === 'failed') {
    return effectiveError === CA_ROTATION_TARGET_GONE
  }
  if (!row.commandId && (row.kind === 'apply' || row.kind === 'ingress')) {
    return false
  }
  if (row.commandId) {
    return effectiveStatus === 'succeeded'
  }
  return false
}

export function rotationConvergedForRetire(
  rows: readonly CaRotationResultRow[],
  records: readonly { id: string; status: string; error?: string | null }[]
): boolean {
  const byId = new Map(records.map((record) => [record.id, record]))
  for (const row of rows) {
    const record = row.commandId ? byId.get(row.commandId) : undefined
    const effectiveStatus = record?.status ?? row.status
    const effectiveError = record?.error ?? row.error ?? undefined
    if (!rotationRowConverged(row, effectiveStatus, effectiveError)) {
      return false
    }
  }
  return true
}

export function rotationResultReason(params: {
  row: CaRotationResultRow
  effectiveStatus: string
  effectiveError?: string
}): string | undefined {
  const { row, effectiveStatus, effectiveError } = params
  if (effectiveStatus === 'succeeded') return undefined
  if (row.status === 'skipped' && row.error === CA_ROTATION_TARGET_GONE) {
    return 'Skipped because the managed cluster, member, or server no longer exists.'
  }
  if (effectiveError === CA_ROTATION_TARGET_GONE) {
    return 'Skipped because the managed cluster, member, or server no longer exists.'
  }
  if (effectiveStatus === 'failed' && effectiveError) {
    return `Failed: ${effectiveError}`
  }
  if (!row.commandId && row.kind === 'apply' && effectiveStatus === 'queued') {
    return 'Waiting for a managed apply command to be enqueued for this cluster member.'
  }
  if (PENDING_STATUSES.has(effectiveStatus) || effectiveStatus === 'queued') {
    return 'Waiting for the command to finish.'
  }
  if (effectiveError) return effectiveError
  return undefined
}

type TargetExistence = {
  managedIds: Set<string>
  serverIds: Set<string>
  members: Set<string>
}

async function loadRotationTargetExistence(
  db: Db,
  organizationId: string,
  targets: OrganizationRotationTargets,
  rowRefs: { serverIds: readonly string[]; managedIds: readonly string[] }
): Promise<TargetExistence> {
  const managedIds = [...new Set([...targets.managedIds, ...rowRefs.managedIds])]
  const serverIds = [...new Set([...targets.members.map((m) => m.serverId), ...rowRefs.serverIds])]

  const managedRows =
    managedIds.length === 0
      ? []
      : await db.select({ id: managed.id }).from(managed).where(inArray(managed.id, managedIds))
  const serverRows =
    serverIds.length === 0
      ? []
      : await db
          .select({ id: server.id })
          .from(server)
          .where(and(inArray(server.id, serverIds), eq(server.organizationId, organizationId)))
  const memberRows =
    managedIds.length === 0
      ? []
      : await db
          .select({ managedId: replica.managedId, serverId: replica.serverId })
          .from(replica)
          .where(inArray(replica.managedId, managedIds))

  const members = new Set<string>()
  for (const row of memberRows) {
    members.add(rotationApplyRowKey(row.managedId, row.serverId))
  }
  return {
    managedIds: new Set(managedRows.map((row) => row.id)),
    serverIds: new Set(serverRows.map((row) => row.id)),
    members,
  }
}

function targetGoneForApplyMember(
  existence: TargetExistence,
  member: OrganizationRotationMember
): boolean {
  if (!existence.managedIds.has(member.managedId)) return true
  if (!existence.serverIds.has(member.serverId)) return true
  return !existence.members.has(rotationApplyRowKey(member.managedId, member.serverId))
}

async function findRotationApplyCommand(
  db: Db,
  params: {
    managedId: string
    serverId: string
    rotationStartedAt: string
  }
): Promise<{ id: string; status: string; error: string | null } | null> {
  const [row] = await db
    .select({
      id: command.id,
      status: command.status,
      error: command.errorMessage,
    })
    .from(command)
    .where(
      and(
        eq(command.name, 'managed.apply'),
        eq(command.serverId, params.serverId),
        sql`${command.context}->>'managedId' = ${params.managedId}`,
        sql`${command.createdAt} >= ${params.rotationStartedAt}`
      )
    )
    .orderBy(desc(command.createdAt))
    .limit(1)
  return row ?? null
}

function markRowSkipped(row: CaRotationResultRow): CaRotationResultRow {
  return {
    ...row,
    status: 'skipped',
    error: CA_ROTATION_TARGET_GONE,
    commandId: undefined,
  }
}

function upsertApplyRow(
  rows: CaRotationResultRow[],
  managedId: string,
  serverId: string,
  patch: Partial<CaRotationResultRow>
): void {
  const existing = findApplyRow(rows, managedId, serverId)
  if (existing) {
    Object.assign(existing, patch)
    return
  }
  rows.push({
    serverId,
    kind: 'apply',
    managedId,
    status: patch.status ?? 'queued',
    ...patch,
  })
}

function skipRowForGoneTarget(row: CaRotationResultRow): void {
  row.status = 'skipped'
  row.error = CA_ROTATION_TARGET_GONE
  row.commandId = undefined
}

function applyRowTargetGone(row: CaRotationResultRow, existence: TargetExistence): boolean {
  const managedId = row.managedId
  if (!managedId) return false
  if (!existence.managedIds.has(managedId)) return true
  if (!existence.serverIds.has(row.serverId)) return true
  return !existence.members.has(rotationApplyRowKey(managedId, row.serverId))
}

function reconcileIngressRow(row: CaRotationResultRow, existence: TargetExistence): void {
  if (!existence.serverIds.has(row.serverId)) {
    skipRowForGoneTarget(row)
  }
}

function reconcileBindingRow(row: CaRotationResultRow, existence: TargetExistence): void {
  if (row.status === 'failed' && row.error !== CA_ROTATION_TARGET_GONE) {
    return
  }
  if (row.managedId && !existence.managedIds.has(row.managedId)) {
    skipRowForGoneTarget(row)
    return
  }
  if (!existence.serverIds.has(row.serverId)) {
    skipRowForGoneTarget(row)
  }
}

function reconcileApplyRow(row: CaRotationResultRow, existence: TargetExistence): void {
  if (applyRowTargetGone(row, existence)) {
    Object.assign(row, markRowSkipped(row))
  }
}

function reconcileIngressAndBindingRows(
  rows: CaRotationResultRow[],
  existence: TargetExistence
): void {
  for (const row of rows) {
    if (row.kind === 'ingress') {
      reconcileIngressRow(row, existence)
      continue
    }
    if (row.kind === 'binding') {
      reconcileBindingRow(row, existence)
      continue
    }
    if (row.kind === 'apply') {
      reconcileApplyRow(row, existence)
    }
  }
}

async function backfillOneApplyCommandId(
  db: Db,
  row: CaRotationResultRow,
  rotationStartedAt: string
): Promise<void> {
  if (row.kind !== 'apply' || !row.managedId || row.commandId) return
  if (row.status === 'skipped') return
  const match = await findRotationApplyCommand(db, {
    managedId: row.managedId,
    serverId: row.serverId,
    rotationStartedAt,
  })
  if (!match) return
  row.commandId = match.id
  if (match.status === 'failed' && match.error?.includes(CA_ROTATION_TARGET_GONE)) {
    Object.assign(row, markRowSkipped(row))
  }
}

async function backfillApplyCommandIds(
  db: Db,
  rows: CaRotationResultRow[],
  rotationStartedAt: string
): Promise<void> {
  await Promise.all(rows.map((row) => backfillOneApplyCommandId(db, row, rotationStartedAt)))
}

function primaryApplySucceeded(
  rows: readonly CaRotationResultRow[],
  records: Map<string, { status: string }>,
  managedId: string,
  primaryServerId: string | null
): boolean {
  if (!primaryServerId) return true
  const primaryRow = findApplyRow(rows, managedId, primaryServerId)
  if (!primaryRow?.commandId) return false
  const status = records.get(primaryRow.commandId)?.status ?? primaryRow.status
  return status === 'succeeded'
}

async function loadManagedPrimaryServerId(db: Db, managedId: string): Promise<string | null> {
  const [row] = await db
    .select({ serverId: managed.serverId })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  return row?.serverId ?? null
}

async function enqueueRotationApplyMembers(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    actorId: string
    organizationId: string
    managedId: string
    serverIds: readonly string[]
  }
): Promise<CaRotationResultRow[]> {
  const [managedRow] = await db
    .select({
      id: managed.id,
      environmentId: managed.environmentId,
      serverId: managed.serverId,
      engine: managed.engine,
      metadata: managed.metadata,
      options: managed.options,
    })
    .from(managed)
    .where(eq(managed.id, params.managedId))
    .limit(1)
  if (!managedRow?.serverId) {
    return params.serverIds.map((serverId) => ({
      serverId,
      kind: 'apply',
      managedId: params.managedId,
      status: 'failed',
      error: CA_ROTATION_TARGET_GONE,
    }))
  }
  const spec = managedRow.engine ? getManagedEngineSpec(managedRow.engine) : null
  if (!spec) {
    return params.serverIds.map((serverId) => ({
      serverId,
      kind: 'apply',
      managedId: params.managedId,
      status: 'failed',
      error: 'managed_apply_unavailable',
    }))
  }
  const parsed = parseManagedRowOptions(spec, managedRow.options)
  if (!parsed) {
    return params.serverIds.map((serverId) => ({
      serverId,
      kind: 'apply',
      managedId: params.managedId,
      status: 'failed',
      error: 'managed_settings_invalid',
    }))
  }
  const residual = parseManagedResidual(managedRow.metadata)
  const prepared = await prepareManagedApplyPayloads(c, db, {
    managedRow,
    spec,
    settings: parsed.settings,
    databases: parsed.databases,
    serverId: managedRow.serverId,
    environmentId: managedRow.environmentId,
    organizationId: params.organizationId,
    rootUsername: residual.rootUsername ?? spec.rootUsername,
  })
  if (isPrepareError(prepared)) {
    return params.serverIds.map((serverId) => ({
      serverId,
      kind: 'apply',
      managedId: params.managedId,
      status: 'failed',
      error: prepared.kind,
    }))
  }
  const want = new Set(params.serverIds)
  const members = prepared.members.filter((member) => want.has(member.serverId))
  if (members.length === 0) {
    return []
  }
  const enqueued = await enqueuePreparedManagedApply(c, db, commandQueue, {
    userId: params.actorId,
    managedId: params.managedId,
    members,
    updateManagedStatus: false,
  })
  if (enqueued instanceof Response) {
    return params.serverIds.map((serverId) => ({
      serverId,
      kind: 'apply',
      managedId: params.managedId,
      status: 'failed',
      error: 'Command queue unavailable',
    }))
  }
  return enqueued.map((entry) => ({
    serverId: entry.serverId,
    kind: 'apply' as const,
    managedId: params.managedId,
    status: entry.status,
    commandId: entry.commandId,
    error: entry.error,
  }))
}

/**
 * Reconcile stored fan-out rows (gone targets, command backfill) without enqueueing.
 */
function rotationRowRefs(rows: readonly CaRotationResultRow[]): {
  serverIds: string[]
  managedIds: string[]
} {
  const serverIds: string[] = []
  const managedIds: string[] = []
  for (const row of rows) {
    serverIds.push(row.serverId)
    if (row.managedId) managedIds.push(row.managedId)
  }
  return { serverIds, managedIds }
}

export async function reconcileCaRotationResults(
  db: Db,
  organizationId: string,
  rows: CaRotationResultRow[],
  rotationStartedAt: string
): Promise<CaRotationResultRow[]> {
  const targets = await enumerateOrganizationRotationTargets(db, organizationId)
  const existence = await loadRotationTargetExistence(
    db,
    organizationId,
    targets,
    rotationRowRefs(rows)
  )
  const next = rows.map((row) => ({ ...row }))
  reconcileIngressAndBindingRows(next, existence)
  await backfillApplyCommandIds(db, next, rotationStartedAt)
  return next
}

function membersByManagedId(
  members: readonly OrganizationRotationMember[]
): Map<string, OrganizationRotationMember[]> {
  const byManaged = new Map<string, OrganizationRotationMember[]>()
  for (const member of members) {
    const list = byManaged.get(member.managedId) ?? []
    list.push(member)
    byManaged.set(member.managedId, list)
  }
  return byManaged
}

function skipApplyMembersForGoneManaged(
  rows: CaRotationResultRow[],
  managedId: string,
  members: readonly OrganizationRotationMember[]
): void {
  for (const member of members) {
    upsertApplyRow(
      rows,
      managedId,
      member.serverId,
      markRowSkipped({
        serverId: member.serverId,
        kind: 'apply',
        managedId,
        status: 'queued',
      })
    )
  }
}

function applyRowStillPending(
  row: CaRotationResultRow | undefined,
  records: Map<string, { status: string }>
): boolean {
  if (!row?.commandId) return false
  const status = records.get(row.commandId)?.status ?? row.status
  if (status === 'succeeded') return false
  return PENDING_STATUSES.has(status) || status === 'queued'
}

async function collectMissingApplyServerIds(
  db: Db,
  params: {
    rows: CaRotationResultRow[]
    members: readonly OrganizationRotationMember[]
    existence: TargetExistence
    rotationStartedAt: string
    records: Map<string, { status: string }>
    primaryServerId: string | null
    primaryDone: boolean
  }
): Promise<string[]> {
  const backfillTasks = params.members.map(async (member) => {
    if (targetGoneForApplyMember(params.existence, member)) {
      upsertApplyRow(
        params.rows,
        member.managedId,
        member.serverId,
        markRowSkipped({
          serverId: member.serverId,
          kind: 'apply',
          managedId: member.managedId,
          status: 'queued',
        })
      )
      return null
    }
    let row = findApplyRow(params.rows, member.managedId, member.serverId)
    if (row?.status === 'skipped') return null

    if (!row?.commandId) {
      const match = await findRotationApplyCommand(db, {
        managedId: member.managedId,
        serverId: member.serverId,
        rotationStartedAt: params.rotationStartedAt,
      })
      if (match) {
        upsertApplyRow(params.rows, member.managedId, member.serverId, {
          commandId: match.id,
          status: 'queued',
        })
        row = findApplyRow(params.rows, member.managedId, member.serverId)
      }
    }

    if (applyRowStillPending(row, params.records)) return null

    const isPrimary = member.serverId === params.primaryServerId
    if (!isPrimary && !params.primaryDone) return null
    if (row?.commandId) return null
    return member.serverId
  })
  const resolved = await Promise.all(backfillTasks)
  return [...new Set(resolved.filter((serverId): serverId is string => serverId !== null))]
}

async function enqueueMissingAppliesForManagedCluster(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    organizationId: string
    actorId: string
    rows: CaRotationResultRow[]
    rotationStartedAt: string
    records: Map<string, { status: string }>
    existence: TargetExistence
    managedId: string
    members: readonly OrganizationRotationMember[]
  }
): Promise<void> {
  const { managedId, members, rows, existence } = params
  if (!existence.managedIds.has(managedId)) {
    skipApplyMembersForGoneManaged(rows, managedId, members)
    return
  }

  const primaryServerId = await loadManagedPrimaryServerId(db, managedId)
  const primaryDone = primaryApplySucceeded(rows, params.records, managedId, primaryServerId)
  const toEnqueue = await collectMissingApplyServerIds(db, {
    rows,
    members,
    existence,
    rotationStartedAt: params.rotationStartedAt,
    records: params.records,
    primaryServerId,
    primaryDone,
  })
  if (toEnqueue.length === 0) return

  const enqueued = await enqueueRotationApplyMembers(c, db, commandQueue, {
    actorId: params.actorId,
    organizationId: params.organizationId,
    managedId,
    serverIds: toEnqueue,
  })
  for (const entry of enqueued) {
    if (!entry.managedId) continue
    upsertApplyRow(rows, entry.managedId, entry.serverId, {
      status: entry.status,
      commandId: entry.commandId,
      error: entry.error,
    })
  }
}

/**
 * Enqueue apply commands for live rotation members that still lack a tracked command.
 */
export async function enqueueMissingCaRotationApplies(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    organizationId: string
    actorId: string
    rows: CaRotationResultRow[]
    rotationStartedAt: string
    commandRecords?: readonly { id: string; status: string }[]
  }
): Promise<CaRotationResultRow[]> {
  const targets = await enumerateOrganizationRotationTargets(db, params.organizationId)
  const rows = params.rows
  const existence = await loadRotationTargetExistence(
    db,
    params.organizationId,
    targets,
    rotationRowRefs(rows)
  )
  const records = new Map((params.commandRecords ?? []).map((record) => [record.id, record]))
  const byManaged = membersByManagedId(targets.members)

  await Promise.all(
    [...byManaged.entries()].map(([managedId, members]) =>
      enqueueMissingAppliesForManagedCluster(c, db, commandQueue, {
        organizationId: params.organizationId,
        actorId: params.actorId,
        rows,
        rotationStartedAt: params.rotationStartedAt,
        records,
        existence,
        managedId,
        members,
      })
    )
  )

  return rows
}
