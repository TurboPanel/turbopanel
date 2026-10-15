/**
 * SSL minimum under external access.
 *
 * While any server that fronts a cluster allows external access, that cluster's
 * effective client SSL mode must be at least
 * {@link MANAGED_SSL_MINIMUM_WITH_EXTERNAL_ACCESS} (`require`): a listener
 * published on every address must never take a plaintext session. Three saves
 * can break that, and each is refused here with a 409 and a plain message:
 *
 * - a weak per-service mode (or clearing it onto a weak org default),
 * - a weak organization default that a fronted, inheriting cluster follows,
 * - turning the server switch on while a cluster it fronts is weak.
 *
 * Each check runs with its write inside {@link withManagedTlsPolicyLock}, so two
 * of these saves can never pass their checks at the same time.
 *
 * "Fronts" means exactly what the ingress builder sends a server's ProxySQL:
 * `loadFrontedManagedIds` (one server) and `loadManagedFrontendServerIds` (one
 * cluster, filtered to that same set).
 *
 * Data can still end up weak under external access without passing a save
 * (a binding, replica or placement change, or rows older than this rule). Two
 * things cover that: the ingress payload refuses plaintext (`clusterRequireTls`
 * with the server's switch), and {@link resolveEffectiveManagedSsl} raises the
 * mode the connection string, binding variables and the Connect view show.
 */

import { eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, managed, project, server } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  loadFrontedManagedIds,
  loadFrontendServerSettings,
  loadManagedExternalAccess,
} from './external-access.ts'
import { getManagedEngineSpec } from './index.ts'
import { loadManagedOrgDefaults } from './load-org-defaults.ts'
import { parseManagedRowOptions } from './options.ts'
import {
  isWeakManagedSslMode,
  type ManagedSslMode,
  MANAGED_SSL_MINIMUM_WITH_EXTERNAL_ACCESS,
  resolveManagedSslMode,
} from './ssl.ts'
import type { ManagedSettings } from './settings.ts'
import type { ManagedEngineCode } from './types.ts'

/** A per-service mode would let clients skip SSL on a server that allows external access. */
export const MANAGED_SSL_EXTERNAL_ACCESS_MINIMUM = 'managed_ssl_external_access_minimum'
/** An org default would let an inheriting, externally reachable cluster skip SSL. */
export const MANAGED_SSL_DEFAULT_EXTERNAL_ACCESS_MINIMUM =
  'managed_ssl_default_external_access_minimum'
/** External access cannot be turned on while a cluster on the server lets clients skip SSL. */
export const EXTERNAL_ACCESS_WEAK_SSL = 'external_access_weak_ssl'

export type ManagedTlsMinimumRefusal =
  | { error: typeof MANAGED_SSL_EXTERNAL_ACCESS_MINIMUM; message: string; servers: string[] }
  | {
      error: typeof MANAGED_SSL_DEFAULT_EXTERNAL_ACCESS_MINIMUM
      message: string
      databases: string[]
    }
  | {
      error: typeof EXTERNAL_ACCESS_WEAK_SSL
      message: string
      /** The server owner's own databases, by name. */
      databases: string[]
      /** Databases of other organizations on the server (granted placements): a count, no names. */
      otherDatabases: number
    }

type ClusterSslRow = {
  managedId: string
  name: string
  organizationId: string
  /** The service's own mode; `undefined` follows the org default. */
  configured: ManagedSslMode | undefined
}

/** How the picker names {@link MANAGED_SSL_MINIMUM_WITH_EXTERNAL_ACCESS}. */
const MINIMUM_LABEL = 'Require'

/** One lock for every save that could break the minimum; held to the end of the transaction. */
const MANAGED_TLS_POLICY_LOCK = 'managed-tls-policy'

/**
 * Run `fn` in a transaction that first takes the managed SSL policy lock.
 *
 * The three refusals each check state another one writes (a cluster's mode,
 * an org default, a server's switch), across rows of different tables, so a
 * row lock on any one of them would not serialize the other two. One
 * transaction-scoped advisory lock does; these saves are rare, so the global
 * scope costs nothing.
 */
export async function withManagedTlsPolicyLock<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${MANAGED_TLS_POLICY_LOCK}, 0))`
    )
    return await fn(tx)
  })
}

function listNames(names: readonly string[]): string {
  return names.join(', ')
}

function sortNames(names: readonly string[]): string[] {
  return names.toSorted((a, b) => a.localeCompare(b))
}

async function loadClusterSslRows(
  db: Db,
  where: { managedIds: readonly string[] } | { organizationId: string }
): Promise<ClusterSslRow[]> {
  if ('managedIds' in where && where.managedIds.length === 0) return []
  const rows = await db
    .select({
      managedId: managed.id,
      name: managed.name,
      engine: managed.engine,
      options: managed.options,
      projectName: project.name,
      organizationId: project.organizationId,
    })
    .from(managed)
    .innerJoin(environment, eq(managed.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(
      'managedIds' in where
        ? inArray(managed.id, [...where.managedIds])
        : eq(project.organizationId, where.organizationId)
    )
  return rows.map((row) => {
    const spec = getManagedEngineSpec((row.engine ?? 'postgres') as ManagedEngineCode)
    const parsed = spec ? parseManagedRowOptions(spec, row.options) : null
    return {
      managedId: row.managedId,
      name: row.name?.trim() || row.projectName || row.managedId,
      organizationId: row.organizationId,
      configured: parsed?.settings.ssl.mode,
    }
  })
}

/** Names of the servers fronting `managedId` that allow external access. */
export async function loadExternalAccessServerNamesFronting(
  db: Db,
  managedId: string
): Promise<string[]> {
  return sortNames(
    (await loadFrontendServerSettings(db, managedId))
      .filter((row) => row.setting.enabled)
      .map((row) => row.name)
  )
}

export type EffectiveManagedSsl = {
  mode: ManagedSslMode
  /** The resolved mode let clients skip SSL and was raised to the minimum for external access. */
  raisedForExternalAccess: boolean
}

/**
 * The mode a connection string, binding variables and the Connect view should
 * use: service override → org default → platform, raised to
 * {@link MANAGED_SSL_MINIMUM_WITH_EXTERNAL_ACCESS} while a server fronting the
 * cluster allows external access (its listener refuses plaintext then, so a
 * weaker mode would hand clients a setting that cannot connect).
 */
export async function resolveEffectiveManagedSsl(
  db: Db,
  params: Readonly<{
    managedId: string
    configured: ManagedSslMode | undefined
    organizationDefault: ManagedSslMode | undefined
  }>
): Promise<EffectiveManagedSsl> {
  const mode = resolveManagedSslMode(params.configured, params.organizationDefault)
  if (!isWeakManagedSslMode(mode)) return { mode, raisedForExternalAccess: false }
  if ((await loadExternalAccessServerNamesFronting(db, params.managedId)).length === 0) {
    return { mode, raisedForExternalAccess: false }
  }
  return { mode: MANAGED_SSL_MINIMUM_WITH_EXTERNAL_ACCESS, raisedForExternalAccess: true }
}

/**
 * Saving a cluster's mode (`configured`, `undefined` = follow the org
 * default): refused when the result would let clients skip SSL while a server
 * fronting the cluster allows external access.
 */
export async function checkManagedSslModeForExternalAccess(
  db: Db,
  params: Readonly<{
    managedId: string
    configured: ManagedSslMode | undefined
    organizationDefault: ManagedSslMode | undefined
  }>
): Promise<ManagedTlsMinimumRefusal | null> {
  const effective = resolveManagedSslMode(params.configured, params.organizationDefault)
  if (!isWeakManagedSslMode(effective)) return null
  const servers = await loadExternalAccessServerNamesFronting(db, params.managedId)
  if (servers.length === 0) return null
  return {
    error: MANAGED_SSL_EXTERNAL_ACCESS_MINIMUM,
    message: `External access is on for ${listNames(servers)}, so connections to this database must use SSL. Choose ${MINIMUM_LABEL} or stronger, or turn external access off on that server first.`,
    servers,
  }
}

/**
 * Saving an organization default: refused when it would let clients skip SSL
 * and a cluster of the organization that follows the default (no mode of its
 * own) is fronted by a server that allows external access.
 */
export async function checkOrgDefaultSslModeForExternalAccess(
  db: Db,
  params: Readonly<{ organizationId: string; sslMode: ManagedSslMode | undefined }>
): Promise<ManagedTlsMinimumRefusal | null> {
  if (!isWeakManagedSslMode(resolveManagedSslMode(undefined, params.sslMode))) return null
  const inheriting = (
    await loadClusterSslRows(db, { organizationId: params.organizationId })
  ).filter((row) => row.configured === undefined)
  const exposed: string[] = []
  await forEachSequential(inheriting, async (row) => {
    if ((await loadExternalAccessServerNamesFronting(db, row.managedId)).length > 0) {
      exposed.push(row.name)
    }
  })
  if (exposed.length === 0) return null
  const databases = sortNames(exposed)
  return {
    error: MANAGED_SSL_DEFAULT_EXTERNAL_ACCESS_MINIMUM,
    message: `External access is on for a server that runs ${listNames(databases)}, and they follow the organization default, so the default must use SSL. Choose ${MINIMUM_LABEL} or stronger, or give those databases their own SSL mode first.`,
    databases,
  }
}

/**
 * A new cluster has no mode of its own and follows the org default. Created on
 * a server that allows external access while that default lets clients skip
 * SSL, it gets its own mode set to the minimum instead, so a create is never
 * refused for a setting the create form cannot change.
 */
export async function pinSslMinimumOnExternalAccessServer(
  db: Db,
  params: Readonly<{
    settings: ManagedSettings
    organizationDefault: ManagedSslMode | undefined
    serverId: string
  }>
): Promise<ManagedSettings> {
  const { settings } = params
  if (!isWeakManagedSslMode(resolveManagedSslMode(settings.ssl.mode, params.organizationDefault))) {
    return settings
  }
  if (!(await loadManagedExternalAccess(db, params.serverId)).enabled) return settings
  return { ...settings, ssl: { mode: MANAGED_SSL_MINIMUM_WITH_EXTERNAL_ACCESS } }
}

function describeWeakDatabases(databases: readonly string[], otherDatabases: number): string {
  const others =
    otherDatabases === 1
      ? '1 database of another organization'
      : `${otherDatabases} databases of other organizations`
  if (databases.length === 0) return others
  return otherDatabases === 0 ? listNames(databases) : `${listNames(databases)}, and ${others}`
}

/**
 * Turning external access on for `serverId`: refused while any cluster its
 * ProxySQL fronts resolves (with its own organization's default) to a mode
 * that lets clients skip SSL. Names the server owner's own databases and
 * counts the rest, so another organization's names never leak.
 */
export async function checkExternalAccessForWeakSslModes(
  db: Db,
  serverId: string
): Promise<ManagedTlsMinimumRefusal | null> {
  const clusters = await loadClusterSslRows(db, {
    managedIds: await loadFrontedManagedIds(db, serverId),
  })
  const orgDefaults = new Map<string, ManagedSslMode | undefined>()
  await forEachSequential(
    [...new Set(clusters.map((row) => row.organizationId))],
    async (organizationId) => {
      orgDefaults.set(organizationId, (await loadManagedOrgDefaults(db, organizationId)).sslMode)
    }
  )
  const weak = clusters.filter((row) =>
    isWeakManagedSslMode(resolveManagedSslMode(row.configured, orgDefaults.get(row.organizationId)))
  )
  if (weak.length === 0) return null
  const [owner] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const own = weak.filter((row) => row.organizationId === owner?.organizationId)
  const databases = sortNames(own.map((row) => row.name))
  const otherDatabases = weak.length - own.length
  return {
    error: EXTERNAL_ACCESS_WEAK_SSL,
    message: `These databases on this server still accept connections without SSL: ${describeWeakDatabases(databases, otherDatabases)}. Set them to ${MINIMUM_LABEL} or stronger before allowing external access.`,
    databases,
    otherDatabases,
  }
}
