/**
 * What has to happen when a cluster's exposure setting changes.
 *
 * The exposure setting only says where the database's shared ProxySQL listens
 * (see `access-scope.ts`). The listener itself lives on each server, so saving
 * the setting is not enough: every server that fronts the cluster has to be
 * told the new addresses, or it keeps listening where it was. This module owns
 * the "did it change", "can it be applied" and "tell the servers" steps for the
 * settings route.
 */

import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { command, managed, replica, server } from '../../db/schema.ts'
import { consumerServerIdsForManaged } from '../bindings/resolve-endpoint.ts'
import { preflightManagedApplyInfrastructure } from './apply-prepare.ts'
import type { ManagedApplyPrepareError } from './apply-prepare.ts'
import { enqueueManagedIngressReconcile } from './ingress-desired.ts'
import { requestedExposureScope } from './host-exposure.ts'
import type { ManagedSettings } from './settings.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { firstSequential, forEachSequential } from '../../lib/sequential.ts'

/** True when the two settings ask for a different host listener. */
export function managedExposureChanged(
  before: ManagedSettings['exposure'],
  after: ManagedSettings['exposure']
): boolean {
  return requestedExposureScope(before) !== requestedExposureScope(after)
}

/** A stored row that enabled exposure without naming a scope (made before `local` was the default). */
function storedExposureNamesNoScope(storedOptions: unknown): boolean {
  if (typeof storedOptions !== 'object' || storedOptions === null) return false
  const settings = (storedOptions as { settings?: unknown }).settings
  if (typeof settings !== 'object' || settings === null) return false
  const exposure = (settings as { exposure?: unknown }).exposure
  if (typeof exposure !== 'object' || exposure === null) return false
  const { enabled, scope } = exposure as { enabled?: unknown; scope?: unknown }
  return enabled === true && scope === undefined
}

/**
 * Whether saving these settings must tell the servers the listener addresses.
 *
 * Not only when the effective scope changed: a stored row with no scope reads
 * as `local` but may still be published on every interface (it was created
 * public), and a server that never confirmed an earlier push is still waiting.
 * The reconcile is idempotent, so a push that changes nothing restarts nothing.
 */
export function managedExposureNeedsPush(
  params: Readonly<{
    before: ManagedSettings['exposure']
    after: ManagedSettings['exposure']
    storedOptions: unknown
    metadata: unknown
  }>
): boolean {
  return (
    managedExposureChanged(params.before, params.after) ||
    storedExposureNamesNoScope(params.storedOptions) ||
    Object.keys(readManagedExposurePending(params.metadata)).length > 0
  )
}

/** Every server whose ProxySQL fronts the cluster: its members and bound consumers. */
export async function loadManagedFrontendServerIds(db: Db, managedId: string): Promise<string[]> {
  const members = await db
    .select({ serverId: replica.serverId })
    .from(replica)
    .where(eq(replica.managedId, managedId))
  const consumers = await consumerServerIdsForManaged(db, managedId)
  return [...new Set([...members.map((row) => row.serverId), ...consumers])]
}

/**
 * Refuse a new scope before it is saved when one of the servers has no address
 * for it (a datacenter or TurboFabric scope on a server without one), or cannot
 * be sent commands. Saving it anyway would leave the old listener in place with
 * the screen claiming otherwise.
 */
export async function preflightManagedExposureChange(
  c: Context,
  db: Db,
  params: Readonly<{ serverIds: readonly string[]; scope: ManagedSettings['exposure']['scope'] }>
): Promise<ManagedApplyPrepareError | null> {
  // One server at a time: the first refusal is the one reported.
  return (
    (await firstSequential(params.serverIds, async (serverId) => {
      const failure = await preflightManagedApplyInfrastructure(c, db, {
        serverId,
        scope: params.scope,
      })
      return failure ?? undefined
    })) ?? null
  )
}

export type ManagedExposureReconcileOutcome = {
  queuedServerIds: string[]
  failedServerIds: string[]
}

/**
 * Queue one ingress reconcile per fronting server so the new addresses reach
 * the hosts now, not whenever the next unrelated apply happens to run.
 */
export async function enqueueManagedExposureReconcile(
  c: Context,
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{ serverIds: readonly string[]; userId: string }>
): Promise<ManagedExposureReconcileOutcome> {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!secretsConfig || !dataEncryptionSecrets) {
    return { queuedServerIds: [], failedServerIds: [...params.serverIds] }
  }
  const outcome: ManagedExposureReconcileOutcome = { queuedServerIds: [], failedServerIds: [] }
  await forEachSequential(params.serverIds, async (serverId) => {
    const result = await enqueueManagedIngressReconcile(db, commandQueue, {
      serverId,
      actorType: 'user',
      actorId: params.userId,
      secretsConfig,
      dataEncryptionSecrets,
    })
    if (result.ok) outcome.queuedServerIds.push(serverId)
    else if (result.reason !== 'not_needed') outcome.failedServerIds.push(serverId)
  })
  return outcome
}

/**
 * Servers that have been asked to listen the new way but have not confirmed it,
 * as `{ serverId: when it was asked }`. Kept in `managed.metadata` (merged with
 * the other keys there) so a failed or expired push stays visible and is
 * retried; a successful ingress reconcile built after the mark clears it.
 */
export type ManagedExposurePending = Record<string, string>

const EXPOSURE_PENDING_KEY = 'exposurePending'

/** How long a queued ingress reconcile is valid; mirrors `MANAGED_INGRESS_RECONCILE_TTL_MS`. */
const INGRESS_RECONCILE_VALID_MS = 5 * 60_000

export function readManagedExposurePending(metadata: unknown): ManagedExposurePending {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return {}
  const raw = (metadata as Record<string, unknown>)[EXPOSURE_PENDING_KEY]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const pending: ManagedExposurePending = {}
  for (const [serverId, since] of Object.entries(raw)) {
    if (typeof since === 'string') pending[serverId] = since
  }
  return pending
}

async function writeManagedExposurePending(
  db: Db,
  managedId: string,
  pending: ManagedExposurePending
): Promise<void> {
  await db
    .update(managed)
    .set({
      metadata: sql`COALESCE(${managed.metadata}, '{}'::jsonb) || ${JSON.stringify({
        [EXPOSURE_PENDING_KEY]: pending,
      })}::jsonb`,
    })
    .where(eq(managed.id, managedId))
}

async function loadManagedMetadata(db: Db, managedId: string): Promise<unknown> {
  const [row] = await db
    .select({ metadata: managed.metadata })
    .from(managed)
    .where(eq(managed.id, managedId))
    .limit(1)
  return row?.metadata
}

/** Remember that these servers were asked to listen the new way. */
export async function markManagedExposurePending(
  db: Db,
  managedId: string,
  serverIds: readonly string[]
): Promise<void> {
  const pending = readManagedExposurePending(await loadManagedMetadata(db, managedId))
  const since = new Date().toISOString()
  for (const serverId of serverIds) pending[serverId] = since
  await writeManagedExposurePending(db, managedId, pending)
}

/** Forget servers that turned out to have nothing to reconcile. */
export async function unmarkManagedExposurePending(
  db: Db,
  managedId: string,
  serverIds: readonly string[]
): Promise<void> {
  if (serverIds.length === 0) return
  const pending = readManagedExposurePending(await loadManagedMetadata(db, managedId))
  for (const serverId of serverIds) delete pending[serverId]
  await writeManagedExposurePending(db, managedId, pending)
}

async function loadManagedRowsWithExposurePending(
  db: Db
): Promise<Array<{ id: string; pending: ManagedExposurePending }>> {
  const rows = await db
    .select({ id: managed.id, metadata: managed.metadata })
    .from(managed)
    .where(sql`${managed.metadata} -> ${EXPOSURE_PENDING_KEY} IS NOT NULL`)
  return rows
    .map((row) => ({ id: row.id, pending: readManagedExposurePending(row.metadata) }))
    .filter((row) => Object.keys(row.pending).length > 0)
}

/**
 * A server confirmed an ingress reconcile. Every cluster it was told about
 * before that command was created is now applied there.
 */
export async function clearManagedExposurePendingForServer(
  db: Db,
  params: Readonly<{ serverId: string; commandCreatedAt: string }>
): Promise<void> {
  const commandTime = Date.parse(params.commandCreatedAt)
  const rows = await loadManagedRowsWithExposurePending(db)
  await forEachSequential(rows, async (row) => {
    const since = row.pending[params.serverId]
    if (since === undefined || Date.parse(since) > commandTime) return
    delete row.pending[params.serverId]
    await writeManagedExposurePending(db, row.id, row.pending)
  })
}

/**
 * Re-push the listener addresses to servers that were asked but never
 * confirmed (an unreconcilable payload that has since been fixed, or a server
 * that was offline past the command's validity). Connected servers only, and
 * not while an earlier push is still valid.
 */
export async function runManagedExposurePendingSweep(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{ secretsConfig: SecretsConfig; dataEncryptionSecrets: DerivedSecretsConfig }>
): Promise<{ enqueued: number }> {
  const rows = await loadManagedRowsWithExposurePending(db)
  const serverIds = [...new Set(rows.flatMap((row) => Object.keys(row.pending)))]
  if (serverIds.length === 0) return { enqueued: 0 }

  const connected = await db
    .select({ id: server.id })
    .from(server)
    .where(and(inArray(server.id, serverIds), eq(server.isConnected, true)))
  const cutoff = new Date(Date.now() - INGRESS_RECONCILE_VALID_MS).toISOString()
  const inFlight = await db
    .select({ serverId: command.serverId })
    .from(command)
    .where(
      and(
        inArray(
          command.serverId,
          connected.map((row) => row.id)
        ),
        eq(command.name, 'managed.ingress.reconcile'),
        gte(command.createdAt, cutoff)
      )
    )
  const busy = new Set(inFlight.map((row) => row.serverId))

  let enqueued = 0
  await forEachSequential(
    connected.filter((row) => !busy.has(row.id)),
    async ({ id }) => {
      const result = await enqueueManagedIngressReconcile(db, commandQueue, {
        serverId: id,
        actorType: 'system',
        actorId: id,
        secretsConfig: params.secretsConfig,
        dataEncryptionSecrets: params.dataEncryptionSecrets,
      })
      if (result.ok) enqueued += 1
    }
  )
  return { enqueued }
}

/** Display names of servers (name, else hostname, else id) for plain-words messages. */
export async function loadServerLabels(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, string>> {
  if (serverIds.length === 0) return new Map()
  const rows = await db
    .select({ id: server.id, name: server.name, hostname: server.hostname })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  return new Map(rows.map((row) => [row.id, row.name || row.hostname || row.id]))
}

/** Plain-words refusal for a scope a server cannot use, naming the server. */
export function describeExposureRefusal(
  refusal: ManagedApplyPrepareError,
  serverLabel: string
): { error: string; message: string } | null {
  switch (refusal.kind) {
    case 'datacenter_ip_required':
      return {
        error: refusal.kind,
        message: `Server ${serverLabel} has no datacenter address, so the Datacenter scope cannot be used on it. Give it one, or pick another scope.`,
      }
    case 'fabric_address_required':
      return {
        error: refusal.kind,
        message: `Server ${serverLabel} has no TurboFabric address, so the TurboFabric scope cannot be used on it. Join it to the fabric, or pick another scope.`,
      }
    case 'daemon_key_unavailable':
      return {
        error: refusal.kind,
        message: `Server ${serverLabel} is not ready to receive changes yet. Try again once it is online.`,
      }
    default:
      return null
  }
}

/** The message for a push that could not be built or queued for these servers. */
export function describeFailedExposurePush(serverLabels: readonly string[]): string {
  return `Saved, but ${serverLabels.join(', ')} could not be told the new setting yet, so it still listens the old way. It is retried automatically once the server can take it; press Apply to try now.`
}
