/**
 * "Allow external access to the databases on this server": one yes/no per
 * server, default no.
 *
 * One ProxySQL runs per server and fronts every managed cluster on it (members
 * placed there plus clusters a service on it is bound to). It publishes one
 * pair of listener ports for all of them, and has no per-user source rule, so
 * "who can connect from outside" is a fact about the server, not about one
 * cluster.
 *
 * - **No** (the default): the listener is published on the server's own
 *   loopback address only. Sites run by a site owner's Linux user dial
 *   `127.0.0.1` on the ProxySQL port (13306 MySQL/MariaDB, 15432 Postgres), and
 *   bound containers dial ProxySQL by name over the managed Docker network,
 *   which needs no publish. Nothing off the machine can connect.
 * - **Yes**: the listener is published on every address of the server. The
 *   server's firewall and the network rules decide who can then reach it.
 *
 * The setting lives on the server (`server.options.managedExternalAccess`).
 * Saving it queues an ingress reconcile for that server; until the server
 * confirms, `pendingSince` stays set and a sweep re-sends it, because a "no"
 * that never reached the host would leave the databases exposed.
 *
 * Out of scope here, on purpose: per-login source restrictions.
 */

import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { command, managed, replica, server } from '../../db/schema.ts'
import { consumerServerIdsForManaged } from '../bindings/resolve-endpoint.ts'
import { getManagedEngineSpec } from './index.ts'
import { enqueueManagedIngressReconcile } from './ingress-desired.ts'
import { loadBoundManagedIdsForServer } from './ingress-bound-consumers.ts'
import { managedIngressPortForEngine } from './ingress-ports.ts'
import { loadManagedIngressPorts } from './load-org-defaults.ts'
import { parseManagedSettings } from './options.ts'
import {
  MANAGED_EXTERNAL_ACCESS_KEY,
  type ManagedExternalAccess,
  readManagedExternalAccess,
} from './external-access-setting.ts'
import type { ManagedEngineCode } from './types.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { forEachSequential } from '../../lib/sequential.ts'

export { loadBoundManagedIdsForServer } from './ingress-bound-consumers.ts'

export {
  MANAGED_EXTERNAL_ACCESS_KEY,
  type ManagedExternalAccess,
  parseManagedExternalAccess,
  readManagedExternalAccess,
} from './external-access-setting.ts'

async function loadServerSetting(db: Db, serverId: string): Promise<ManagedExternalAccess> {
  const [row] = await db
    .select({ options: server.options, pendingAt: server.externalAccessPendingAt })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return readManagedExternalAccess(row?.options, row?.pendingAt)
}

export async function loadManagedExternalAccess(
  db: Db,
  serverId: string
): Promise<ManagedExternalAccess> {
  return await loadServerSetting(db, serverId)
}

async function writeManagedExternalAccess(
  db: Db,
  serverId: string,
  setting: ManagedExternalAccess
): Promise<void> {
  await db
    .update(server)
    .set({
      options: sql`COALESCE(${server.options}, '{}'::jsonb) || ${JSON.stringify({
        [MANAGED_EXTERNAL_ACCESS_KEY]: { enabled: setting.enabled },
      })}::jsonb`,
      externalAccessPendingAt: setting.pendingSince ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(server.id, serverId))
}

/**
 * Save the setting and remember that the server has been asked to listen this
 * way. Returns the `pendingSince` mark it wrote.
 */
export async function saveManagedExternalAccess(
  db: Db,
  serverId: string,
  enabled: boolean
): Promise<string> {
  const pendingSince = new Date().toISOString()
  await writeManagedExternalAccess(db, serverId, { enabled, pendingSince })
  return pendingSince
}

/**
 * Forget the "asked, not confirmed" mark if it was set at or before `through`.
 *
 * One conditional UPDATE that removes only `pendingSince` and never writes
 * `enabled`: a PUT that lands between a read and this write can neither be
 * reverted nor lose its own (newer) mark.
 */
export async function clearManagedExternalAccessPendingThrough(
  db: Db,
  serverId: string,
  through: string
): Promise<void> {
  await db
    .update(server)
    .set({ externalAccessPendingAt: null })
    .where(
      and(
        eq(server.id, serverId),
        isNotNull(server.externalAccessPendingAt),
        lte(server.externalAccessPendingAt, through)
      )
    )
}

/**
 * A server confirmed an ingress reconcile. Whatever it was asked before that
 * command was created is now applied there.
 */
export async function confirmManagedExternalAccessForServer(
  db: Db,
  params: Readonly<{ serverId: string; commandCreatedAt: string }>
): Promise<void> {
  await clearManagedExternalAccessPendingThrough(db, params.serverId, params.commandCreatedAt)
}

/** Every managed cluster the server's ProxySQL fronts: members placed there plus bound clusters. */
export async function loadFrontedManagedIds(db: Db, serverId: string): Promise<string[]> {
  const memberRows = await db
    .select({ managedId: replica.managedId })
    .from(replica)
    .where(eq(replica.serverId, serverId))

  // Server-owner org, matching the reconcile builder: one ProxySQL per host
  // belongs to the org that owns the host, whoever placed clusters on it.
  const [serverRow] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)

  const ids = new Set(memberRows.map((row) => row.managedId))
  if (serverRow?.organizationId) {
    for (const boundId of await loadBoundManagedIdsForServer(
      db,
      serverId,
      serverRow.organizationId
    )) {
      ids.add(boundId)
    }
  }
  return [...ids]
}

/**
 * Every server whose ProxySQL fronts the cluster: its members, plus the
 * servers its bound consumers place on whose {@link loadFrontedManagedIds}
 * includes it. A consumer's server fronts only bindings of the server owner's
 * organization (the ingress builder's rule), so a consumer server is kept only
 * when the ingress there would actually carry this cluster.
 */
export async function loadManagedFrontendServerIds(db: Db, managedId: string): Promise<string[]> {
  const members = await db
    .select({ serverId: replica.serverId })
    .from(replica)
    .where(eq(replica.managedId, managedId))
  const memberIds = new Set(members.map((row) => row.serverId))
  const fronting = new Set(memberIds)
  const consumers = (await consumerServerIdsForManaged(db, managedId)).filter(
    (serverId) => !memberIds.has(serverId)
  )
  await forEachSequential(consumers, async (serverId) => {
    if ((await loadFrontedManagedIds(db, serverId)).includes(managedId)) fronting.add(serverId)
  })
  return [...fronting]
}

/**
 * The listener ports the server's ProxySQL publishes when external access is
 * allowed (one per protocol family a fronted cluster uses; the host-owner
 * organization's ports, defaults 15432 / 13306). Empty when it is not.
 * Read by the firewall derivation.
 */
export async function loadHostIngressListeners(
  db: Db,
  serverId: string
): Promise<{ external: boolean; ports: number[] }> {
  const { enabled } = await loadManagedExternalAccess(db, serverId)
  if (!enabled) return { external: false, ports: [] }
  const managedIds = await loadFrontedManagedIds(db, serverId)
  if (managedIds.length === 0) return { external: false, ports: [] }
  const [owner] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!owner?.organizationId) return { external: false, ports: [] }
  const ingressPorts = await loadManagedIngressPorts(db, owner.organizationId)
  const rows = await db
    .select({ engine: managed.engine, options: managed.options })
    .from(managed)
    .where(inArray(managed.id, managedIds))
  const ports = new Set<number>()
  for (const row of rows) {
    const engine = (row.engine ?? 'postgres') as ManagedEngineCode
    const spec = getManagedEngineSpec(engine)
    if (!spec || parseManagedSettings(spec, row.options) === null) continue
    ports.add(managedIngressPortForEngine(engine, spec.defaultPort, ingressPorts))
  }
  return { external: true, ports: [...ports].toSorted((a, b) => a - b) }
}

export type ManagedExternalAccessServerView = {
  id: string
  name: string
  enabled: boolean
  /** The server has been asked to listen this way and has not confirmed yet. */
  pending: boolean
  /** Other clusters on the server that the setting also covers. */
  otherClusters: number
}

/** Each server fronting `managedId`, by display name, with its external access setting. */
export async function loadFrontendServerSettings(
  db: Db,
  managedId: string
): Promise<Array<{ id: string; name: string; setting: ManagedExternalAccess }>> {
  const serverIds = await loadManagedFrontendServerIds(db, managedId)
  if (serverIds.length === 0) return []
  const rows = await db
    .select({
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      options: server.options,
      pendingAt: server.externalAccessPendingAt,
    })
    .from(server)
    .where(inArray(server.id, serverIds))
  return rows.map((row) => ({
    id: row.id,
    name: row.name || row.hostname || row.id,
    setting: readManagedExternalAccess(row.options, row.pendingAt),
  }))
}

/**
 * The setting on every server that fronts `managedId`, with how many other
 * clusters share each one. The cluster screens show this and warn on it.
 */
export async function loadManagedExternalAccessView(
  db: Db,
  managedId: string
): Promise<ManagedExternalAccessServerView[]> {
  const views: ManagedExternalAccessServerView[] = []
  await forEachSequential(await loadFrontendServerSettings(db, managedId), async (row) => {
    const { setting } = row
    const fronted = await loadFrontedManagedIds(db, row.id)
    views.push({
      id: row.id,
      name: row.name,
      enabled: setting.enabled,
      pending: setting.pendingSince !== undefined,
      otherClusters: fronted.filter((id) => id !== managedId).length,
    })
  })
  return views
}

export type ManagedExternalAccessPushOutcome = 'queued' | 'not_needed' | 'failed'

/** Queue the ingress reconcile that carries the setting to the server now. */
export async function enqueueManagedExternalAccessReconcile(
  c: Context,
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{ serverId: string; userId: string }>
): Promise<ManagedExternalAccessPushOutcome> {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!secretsConfig || !dataEncryptionSecrets) return 'failed'
  const result = await enqueueManagedIngressReconcile(db, commandQueue, {
    serverId: params.serverId,
    actorType: 'user',
    actorId: params.userId,
    secretsConfig,
    dataEncryptionSecrets,
  })
  if (result.ok) return 'queued'
  return result.reason === 'not_needed' ? 'not_needed' : 'failed'
}

/**
 * Re-send the setting to servers that were asked but never confirmed (a payload
 * that could not be built and has since been fixed, or a server offline past
 * the command's validity). Connected servers only, and not while an earlier
 * push is still valid.
 */
export async function runManagedExternalAccessPendingSweep(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{ secretsConfig: SecretsConfig; dataEncryptionSecrets: DerivedSecretsConfig }>
): Promise<{ enqueued: number }> {
  const connected = await db
    .select({
      id: server.id,
      pendingSince: server.externalAccessPendingAt,
    })
    .from(server)
    .where(and(eq(server.isConnected, true), isNotNull(server.externalAccessPendingAt)))
  if (connected.length === 0) return { enqueued: 0 }

  const now = new Date().toISOString()
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
        gte(command.expiresAt, now)
      )
    )
  const busy = new Set(inFlight.map((row) => row.serverId))

  let enqueued = 0
  await forEachSequential(
    connected.filter((row) => !busy.has(row.id)),
    async ({ id, pendingSince }) => {
      if (!pendingSince) return
      const result = await enqueueManagedIngressReconcile(db, commandQueue, {
        serverId: id,
        actorType: 'system',
        actorId: id,
        secretsConfig: params.secretsConfig,
        dataEncryptionSecrets: params.dataEncryptionSecrets,
      })
      if (result.ok) enqueued += 1
      else if (result.reason === 'not_needed') {
        await clearManagedExternalAccessPendingThrough(db, id, pendingSince)
      }
    }
  )
  return { enqueued }
}

/** The message for a push that could not be built or queued. */
export function describeFailedExternalAccessPush(serverLabel: string): string {
  return `Saved, but ${serverLabel} could not be told the new setting yet, so it still listens the old way. It is retried automatically once the server can take it.`
}
