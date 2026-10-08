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

import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { command, managed, replica, server } from '../../db/schema.ts'
import { consumerServerIdsForManaged } from '../bindings/resolve-endpoint.ts'
import { getManagedEngineSpec } from './index.ts'
import { enqueueManagedIngressReconcile } from './ingress-desired.ts'
import { loadBoundManagedIdsForServer } from './ingress-bound-consumers.ts'
import { managedIngressPortForEngine } from './ingress-ports.ts'
import { loadManagedIngressPorts } from './load-org-defaults.ts'
import { parseManagedRowOptions } from './options.ts'
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

async function loadServerOptions(db: Db, serverId: string): Promise<unknown> {
  const [row] = await db
    .select({ options: server.options })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row?.options
}

export async function loadManagedExternalAccess(
  db: Db,
  serverId: string
): Promise<ManagedExternalAccess> {
  return readManagedExternalAccess(await loadServerOptions(db, serverId))
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
        [MANAGED_EXTERNAL_ACCESS_KEY]: setting,
      })}::jsonb`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(server.id, serverId))
}

/** Save the setting and remember that the server has been asked to listen this way. */
export async function saveManagedExternalAccess(
  db: Db,
  serverId: string,
  enabled: boolean
): Promise<void> {
  await writeManagedExternalAccess(db, serverId, {
    enabled,
    pendingSince: new Date().toISOString(),
  })
}

/** Forget the "asked, not confirmed" mark (the server has nothing to reconcile). */
export async function clearManagedExternalAccessPending(db: Db, serverId: string): Promise<void> {
  const current = await loadManagedExternalAccess(db, serverId)
  if (current.pendingSince === undefined) return
  await writeManagedExternalAccess(db, serverId, { enabled: current.enabled })
}

/**
 * A server confirmed an ingress reconcile. Whatever it was asked before that
 * command was created is now applied there.
 */
export async function confirmManagedExternalAccessForServer(
  db: Db,
  params: Readonly<{ serverId: string; commandCreatedAt: string }>
): Promise<void> {
  const current = await loadManagedExternalAccess(db, params.serverId)
  if (current.pendingSince === undefined) return
  if (Date.parse(current.pendingSince) > Date.parse(params.commandCreatedAt)) return
  await writeManagedExternalAccess(db, params.serverId, { enabled: current.enabled })
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
    if (!spec || !parseManagedRowOptions(spec, row.options)) continue
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

/**
 * The setting on every server that fronts `managedId`, with how many other
 * clusters share each one. The cluster screens show this and warn on it.
 */
export async function loadManagedExternalAccessView(
  db: Db,
  managedId: string
): Promise<ManagedExternalAccessServerView[]> {
  const serverIds = await loadManagedFrontendServerIds(db, managedId)
  if (serverIds.length === 0) return []
  const rows = await db
    .select({
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      options: server.options,
    })
    .from(server)
    .where(inArray(server.id, serverIds))
  const views: ManagedExternalAccessServerView[] = []
  await forEachSequential(rows, async (row) => {
    const setting = readManagedExternalAccess(row.options)
    const fronted = await loadFrontedManagedIds(db, row.id)
    views.push({
      id: row.id,
      name: row.name || row.hostname || row.id,
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

/** How long a queued ingress reconcile is valid; mirrors `MANAGED_INGRESS_RECONCILE_TTL_MS`. */
const INGRESS_RECONCILE_VALID_MS = 5 * 60_000

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
    .select({ id: server.id })
    .from(server)
    .where(
      and(
        eq(server.isConnected, true),
        sql`${server.options} -> ${MANAGED_EXTERNAL_ACCESS_KEY} -> 'pendingSince' IS NOT NULL`
      )
    )
  if (connected.length === 0) return { enqueued: 0 }

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
      else if (result.reason === 'not_needed') await clearManagedExternalAccessPending(db, id)
    }
  )
  return { enqueued }
}

/** The message for a push that could not be built or queued. */
export function describeFailedExternalAccessPush(serverLabel: string): string {
  return `Saved, but ${serverLabel} could not be told the new setting yet, so it still listens the old way. It is retried automatically once the server can take it.`
}
