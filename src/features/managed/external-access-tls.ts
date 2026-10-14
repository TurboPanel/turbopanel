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
 * The ingress payload enforces the same rule on its own (`clusterRequireTls`
 * with the server's switch), so data that drifts past these checks still
 * refuses plaintext.
 */

import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, managed, project, server } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  loadFrontedManagedIds,
  loadManagedExternalAccess,
  loadManagedFrontendServerIds,
} from './external-access.ts'
import { readManagedExternalAccess } from './external-access-setting.ts'
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
      error: typeof MANAGED_SSL_DEFAULT_EXTERNAL_ACCESS_MINIMUM | typeof EXTERNAL_ACCESS_WEAK_SSL
      message: string
      databases: string[]
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

function listNames(names: readonly string[]): string {
  return names.join(', ')
}

function serverLabel(row: { id: string; name: string | null; hostname: string | null }): string {
  return row.name || row.hostname || row.id
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
  return rows
    .filter((row) => readManagedExternalAccess(row.options).enabled)
    .map(serverLabel)
    .toSorted((a, b) => a.localeCompare(b))
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
  const databases = exposed.toSorted((a, b) => a.localeCompare(b))
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

/**
 * Turning external access on for `serverId`: refused while any cluster its
 * ProxySQL fronts resolves (with its own organization's default) to a mode
 * that lets clients skip SSL. Lists those databases by name.
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
  const databases = clusters
    .filter((row) =>
      isWeakManagedSslMode(
        resolveManagedSslMode(row.configured, orgDefaults.get(row.organizationId))
      )
    )
    .map((row) => row.name)
    .toSorted((a, b) => a.localeCompare(b))
  if (databases.length === 0) return null
  return {
    error: EXTERNAL_ACCESS_WEAK_SSL,
    message: `These databases on this server still accept connections without SSL: ${listNames(databases)}. Set them to ${MINIMUM_LABEL} or stronger before allowing external access.`,
    databases,
  }
}
