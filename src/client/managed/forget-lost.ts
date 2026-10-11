/**
 * `POST /environments/:id/managed/forget-lost`: forget a managed database
 * whose hosts are all lost (offline for good, e.g. a dead motherboard).
 *
 * A normal delete sends `managed.destroy` to the database's hosts and refuses
 * while they are offline, and removing a member needs the primary's host. With
 * every host gone there was no supported way out, and a host that holds the
 * only copy (or the primary) also blocks `DELETE /servers/:id?forgetResources`.
 *
 * Forgetting only removes the panel's records: the bindings (and their
 * variables, with `?detach=true`), the member, container and managed rows, the
 * backup records (the files were on the lost hosts), and the commands still
 * waiting for those hosts. Nothing is sent to the lost hosts. The servers that
 * stay up get `managed.ingress.reconcile` / `managed.ha.reconcile` so their
 * proxy and Orchestrator settings stop naming the forgotten database.
 *
 * Refused when any host of the database is online (stored flag or live
 * connection, re-checked under row lock): then a working copy exists and the
 * owner must delete it, or promote / disaster-recover a copy on a working host.
 */

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDaemonCellRegistry } from '../../db/connection.ts'
import { backup, command, environment, managed, project, replica, server } from '../../db/schema.ts'
import { isServerConnectedStoredOrLive } from '../../daemon/cell/server-status.ts'
import {
  type BindingImpactService,
  detachBindingsForManaged,
  listBindingImpactForManaged,
} from '../../features/bindings/impact.ts'
import { consumerServerIdsForManaged } from '../../features/bindings/resolve-endpoint.ts'
import { cancelNonTerminalCommand } from '../../features/commands/command-records.ts'
import { isNoopCommandQueue } from '../../features/commands/noop-command-queue.ts'
import { getCommandQueue } from '../../features/commands/queue.ts'
import { TERMINAL_COMMAND_STATUSES } from '../../features/commands/types.ts'
import {
  haReconcileEnqueuer,
  listOrganizationOrchestratorServerIds,
} from '../../features/managed/ha-desired.ts'
import { serverHostsManagedHa } from '../../features/managed/ha-policy.ts'
import { enqueueManagedIngressReconcile } from '../../features/managed/ingress-desired.ts'
import { recordAuditAndNotify } from '../../features/notifications/audit-bridge.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { parseJsonBody } from '../shared.ts'
import {
  clearPendingNullIdContainersForEnvironment,
  deleteManagedRuntimeRows,
} from './runtime-rows.ts'

export const MANAGED_HOST_ONLINE_CODE = 'managed_host_online'
export const MANAGED_FORGET_CONFIRM_MISMATCH_CODE = 'managed_forget_confirm_mismatch'

export const MANAGED_FORGET_CONFIRM_MISMATCH_MESSAGE =
  'To forget this database, type its project name exactly as `confirmName`.'

const FORGET_COMMAND_ERROR = 'The database was forgotten because its hosts are lost.'

/** Cap on the backup records copied into the audit entry. */
const AUDIT_BACKUP_CAP = 50

export function managedHostOnlineMessage(serverNames: readonly string[]): string {
  const hosts = serverNames.map((name) => `"${name}"`).join(', ')
  return `This database still has a copy on a host that is online (${hosts}). Forget is only for a database whose hosts are all lost. Delete the database instead, or promote a copy on a working host (or use disaster recovery) and then remove the lost member.`
}

type LostServer = { id: string; name: string }

type BackupEvidence = {
  backupId: string
  serverId: string | null
  path: string
  sizeBytes: number
  createdAt: string
  database: string | null
}

export type ForgetLostScope = {
  db: Db
  environmentId: string
  auth: { userId: string; organizationId: string }
  row: { id: string; name: string | null; engine: string; serverId: string | null; status: string | null }
}

class HostCameBackError extends Error {
  readonly servers: LostServer[]
  constructor(servers: LostServer[]) {
    super('host came back during forget')
    this.name = 'HostCameBackError'
    this.servers = servers
  }
}

class BindingsAppearedError extends Error {
  constructor() {
    super('bindings appeared during forget')
    this.name = 'BindingsAppearedError'
  }
}

class ManagedGoneError extends Error {
  constructor() {
    super('managed row gone during forget')
    this.name = 'ManagedGoneError'
  }
}

/** Servers holding a member of this database: every member row plus the placement pin. */
async function loadMemberServerIds(
  db: Db,
  managedId: string,
  pinnedServerId: string | null
): Promise<string[]> {
  const rows = await db
    .select({ serverId: replica.serverId })
    .from(replica)
    .where(eq(replica.managedId, managedId))
  const ids = new Set(rows.map((row) => row.serverId))
  if (pinnedServerId) ids.add(pinnedServerId)
  return [...ids].toSorted((a, b) => a.localeCompare(b))
}

async function loadServerNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (ids.length === 0) return names
  const rows = await db
    .select({ id: server.id, name: server.name, hostname: server.hostname })
    .from(server)
    .where(inArray(server.id, [...ids]))
  for (const row of rows) names.set(row.id, row.name ?? row.hostname ?? row.id)
  return names
}

/** Member servers that are online right now (stored flag or a live connection). */
async function findOnlineServers(
  c: Context<AppEnv>,
  db: Db,
  serverIds: readonly string[]
): Promise<string[]> {
  if (serverIds.length === 0) return []
  const registry = getDaemonCellRegistry(c)
  const rows = await db
    .select({ id: server.id, isConnected: server.isConnected })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  const online: string[] = []
  await forEachSequential(rows, async (row) => {
    if (await isServerConnectedStoredOrLive(db, registry, row.id, row.isConnected)) {
      online.push(row.id)
    }
  })
  return online
}

async function loadProjectName(db: Db, environmentId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: project.name })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(eq(environment.id, environmentId))
    .limit(1)
  return row?.name ?? null
}

function readConfirmName(body: Record<string, unknown>): string | null {
  return typeof body.confirmName === 'string' ? body.confirmName.trim() : null
}

async function hostOnlineResponse(
  c: Context<AppEnv>,
  db: Db,
  onlineIds: readonly string[]
): Promise<Response> {
  const names = await loadServerNames(db, onlineIds)
  const servers = onlineIds.map((id) => ({ id, name: names.get(id) ?? id }))
  return c.json(
    {
      error: MANAGED_HOST_ONLINE_CODE,
      message: managedHostOnlineMessage(servers.map((row) => row.name)),
      servers,
    },
    409
  )
}

/**
 * Who has to hear about the forget once the rows are gone: the app hosts that
 * reach the database through their local proxy, and (for a database the
 * Orchestrator watches) every Orchestrator host of the organization. The lost
 * hosts are left out: a command queued for them would wait forever.
 */
async function captureReconcileTargets(
  db: Db,
  managedId: string,
  organizationId: string,
  lostServerIds: ReadonlySet<string>
): Promise<{ ingressServerIds: string[]; haServerIds: string[] }> {
  const consumerIds = await consumerServerIdsForManaged(db, managedId)
  const memberRows = await db
    .select({
      serverId: replica.serverId,
      role: replica.role,
      replicaClass: replica.replicaClass,
      engine: managed.engine,
    })
    .from(replica)
    .innerJoin(managed, eq(managed.id, replica.managedId))
    .where(eq(replica.managedId, managedId))
  const haServerIds = serverHostsManagedHa(memberRows)
    ? await listOrganizationOrchestratorServerIds(db, [
        ...new Set([
          organizationId,
          ...(await loadServerOrganizationIds(db, [...lostServerIds])),
        ]),
      ])
    : []
  const keep = (id: string) => !lostServerIds.has(id)
  return {
    ingressServerIds: [...new Set(consumerIds)].filter(keep).toSorted(),
    haServerIds: haServerIds.filter(keep),
  }
}

async function loadServerOrganizationIds(db: Db, serverIds: readonly string[]): Promise<string[]> {
  if (serverIds.length === 0) return []
  const rows = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  return rows.flatMap((row) => (row.organizationId ? [row.organizationId] : []))
}

/**
 * The delete itself, in one transaction: lock the database row, then its
 * hosts, re-read `is_connected` under the lock (a host that reconnected after
 * the live check still refuses), and drop bindings, container rows, members
 * and the managed row. Backup records go with the managed row (`backup` has no
 * state column to mark them lost), so they are read first and kept in the
 * audit entry.
 */
async function forgetRowsInTx(
  db: Db,
  params: Readonly<{
    environmentId: string
    managedId: string
    pinnedServerId: string | null
    checkedServerIds: ReadonlySet<string>
    detach: boolean
  }>
): Promise<{ backups: BackupEvidence[] }> {
  return await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.id, params.managedId))
      .for('update')
      .limit(1)
    if (!locked) throw new ManagedGoneError()

    const serverIds = await loadMemberServerIds(tx, params.managedId, params.pinnedServerId)
    const lockedServers = serverIds.length
      ? await tx
          .select({ id: server.id, name: server.name, isConnected: server.isConnected })
          .from(server)
          .where(inArray(server.id, serverIds))
          .orderBy(server.id)
          .for('update')
      : []
    const cameBack = lockedServers.filter(
      (row) => row.isConnected || !params.checkedServerIds.has(row.id)
    )
    if (cameBack.length > 0) {
      throw new HostCameBackError(cameBack.map((row) => ({ id: row.id, name: row.name ?? row.id })))
    }

    const backups = await tx
      .select({
        backupId: backup.backupId,
        serverId: backup.serverId,
        path: backup.path,
        sizeBytes: backup.sizeBytes,
        createdAt: backup.createdAt,
        database: backup.database,
      })
      .from(backup)
      .where(eq(backup.managedId, params.managedId))

    // Re-checked under the lock: a binding made after the first check must
    // not be dropped without the caller having acknowledged it.
    if (params.detach) {
      await detachBindingsForManaged(tx, params.managedId)
    } else if ((await listBindingImpactForManaged(tx, params.managedId)).count > 0) {
      throw new BindingsAppearedError()
    }
    await clearPendingNullIdContainersForEnvironment(tx, params.environmentId)
    await deleteManagedRuntimeRows(tx, params.environmentId, params.managedId)
    return { backups }
  })
}

/** Cancel what is still waiting for the lost hosts on this database's behalf. */
async function cancelCommandsForLostHosts(
  db: Db,
  managedId: string,
  lostServerIds: readonly string[]
): Promise<number> {
  if (lostServerIds.length === 0) return 0
  const rows = await db
    .select({ id: command.id })
    .from(command)
    .where(
      and(
        inArray(command.serverId, [...lostServerIds]),
        notInArray(command.status, [...TERMINAL_COMMAND_STATUSES]),
        sql`${command.context}->>'managedId' = ${managedId}`
      )
    )
  let cancelled = 0
  await forEachSequential(rows, async (row) => {
    const done = await cancelNonTerminalCommand(db, row.id, {
      error: FORGET_COMMAND_ERROR,
      errorCode: 'target_gone',
    })
    if (done) cancelled += 1
  })
  return cancelled
}

/** Best effort: a refusal is logged, never undoes the forget. */
async function enqueueSurvivorReconciles(
  c: Context<AppEnv>,
  db: Db,
  params: Readonly<{
    actorId: string
    managedId: string
    ingressServerIds: readonly string[]
    haServerIds: readonly string[]
  }>
): Promise<{ ingress: number; ha: number }> {
  const queued = { ingress: 0, ha: 0 }
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const commandQueue = getCommandQueue(c)
  if (
    !secretsConfig ||
    !dataEncryptionSecrets ||
    !commandQueue ||
    isNoopCommandQueue(commandQueue)
  ) {
    return queued
  }
  const base = {
    actorType: 'user' as const,
    actorId: params.actorId,
    secretsConfig,
    dataEncryptionSecrets,
  }
  await forEachSequential(params.ingressServerIds, async (serverId) => {
    try {
      const result = await enqueueManagedIngressReconcile(db, commandQueue, { ...base, serverId })
      if (result.ok) queued.ingress += 1
    } catch (err) {
      compatLogWarn(
        'managed',
        `ingress reconcile after forget failed managedId=${params.managedId} serverId=${serverId}: ${String(err)}`
      )
    }
  })
  await forEachSequential(params.haServerIds, async (serverId) => {
    try {
      const result = await haReconcileEnqueuer.enqueue(db, commandQueue, { ...base, serverId })
      if (result.ok) queued.ha += 1
    } catch (err) {
      compatLogWarn(
        'managed',
        `ha reconcile after forget failed managedId=${params.managedId} serverId=${serverId}: ${String(err)}`
      )
    }
  })
  return queued
}

export async function handleManagedForgetLost(
  c: Context<AppEnv>,
  scope: ForgetLostScope
): Promise<Response> {
  const { db, environmentId, auth, row } = scope

  if (!getDaemonCellRegistry(c)) {
    return c.json({ error: 'Daemon cell registry unavailable' }, 503)
  }

  // Every host must be offline. Unlike the delete route, `applying` and an
  // in-flight recovery do not refuse here: with every host gone neither can
  // finish, and refusing would leave the owner stuck again.
  const memberServerIds = await loadMemberServerIds(db, row.id, row.serverId)
  const online = await findOnlineServers(c, db, memberServerIds)
  if (online.length > 0) return await hostOnlineResponse(c, db, online)

  const attached = await listBindingImpactForManaged(db, row.id)
  const detach = c.req.query('detach') === 'true'
  if (attached.count > 0 && !detach) {
    return c.json({ error: 'managed_has_bindings', services: attached.services }, 409)
  }

  const body = await parseJsonBody(c)
  if (body instanceof Response) return body
  const projectName = await loadProjectName(db, environmentId)
  const confirmName = readConfirmName(body)
  if (!projectName || confirmName !== projectName) {
    return c.json(
      {
        error: MANAGED_FORGET_CONFIRM_MISMATCH_CODE,
        message: MANAGED_FORGET_CONFIRM_MISMATCH_MESSAGE,
      },
      400
    )
  }

  const lostIds = new Set(memberServerIds)
  const names = await loadServerNames(db, memberServerIds)
  const lostServers: LostServer[] = memberServerIds.map((id) => ({
    id,
    name: names.get(id) ?? id,
  }))
  const targets = await captureReconcileTargets(db, row.id, auth.organizationId, lostIds)

  let backups: BackupEvidence[]
  try {
    const removed = await forgetRowsInTx(db, {
      environmentId,
      managedId: row.id,
      pinnedServerId: row.serverId,
      checkedServerIds: lostIds,
      detach,
    })
    backups = removed.backups
  } catch (err) {
    if (err instanceof ManagedGoneError) return c.json({ error: 'Not found' }, 404)
    if (err instanceof BindingsAppearedError) {
      const latest = await listBindingImpactForManaged(db, row.id)
      return c.json({ error: 'managed_has_bindings', services: latest.services }, 409)
    }
    if (err instanceof HostCameBackError) {
      return await hostOnlineResponse(
        c,
        db,
        err.servers.map((s) => s.id)
      )
    }
    throw err
  }

  const cancelledCommands = await cancelCommandsForLostHosts(db, row.id, memberServerIds)
  const reconcile = await enqueueSurvivorReconciles(c, db, {
    actorId: auth.userId,
    managedId: row.id,
    ...targets,
  })

  const backupsOnLiveHosts = backups.filter((b) => b.serverId && !lostIds.has(b.serverId))
  const detached: readonly BindingImpactService[] = attached.services
  const session = c.get('session')
  await recordAuditAndNotify(c, {
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    actorEmail: session?.email ?? null,
    action: 'managed.forget_lost',
    targetType: 'managed',
    targetId: row.id,
    context: {
      environmentId,
      projectName,
      databaseName: row.name ?? row.engine,
      engine: row.engine,
      status: row.status,
      lostServers,
      detachedServiceIds: detached.map((s) => s.serviceId),
      cancelledCommands,
      backupCount: backups.length,
      backups: backups.slice(0, AUDIT_BACKUP_CAP),
      reconcile,
    },
  })

  return c.json({
    forgotten: true as const,
    managedId: row.id,
    lostServers,
    backupsForgotten: backups.length,
    ...(backupsOnLiveHosts.length > 0
      ? {
          backupsLeftOnHosts: backupsOnLiveHosts.map((b) => ({
            backupId: b.backupId,
            serverId: b.serverId,
            path: b.path,
          })),
        }
      : {}),
    cancelledCommands,
    ...(detached.length > 0 ? { detached } : {}),
  })
}
