import type { Context } from 'hono'
import { inArray } from 'drizzle-orm'
import { getDb, getDaemonCellRegistry, getQueryCache, type Db } from '../../db.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import type { ServerFleetPresence } from '../../daemon/cell/server-status.ts'
import { server } from '../../lib/db/schema.ts'
import { resolveColocatedServerIdSet } from '../../client/servers/colocated.ts'
import { runApprovedCachedReadModel } from '../cached-query.ts'

export type ServersListRow = {
  id: string
  displayName: string | null
  organizationId: string
  licenseId: string | null
  options: typeof server.$inferSelect.options
  createdAt: string
}

export type ServersListDisplayPayload = {
  rows: ServersListRow[]
  presence: ServerFleetPresence[]
  colocatedIds: string[]
}

/**
 * Approved cached read model: servers tab list display/projection data.
 *
 * SQL executed (read-only SELECT only; no transactions, mutations, or volatile
 * PostgreSQL functions):
 *   1. `SELECT id, display_name, organization_id, license_id, options, created_at
 *      FROM server WHERE id IN (:visibleIds) ORDER BY created_at`
 *   2. `SELECT id, daemon, metadata FROM server WHERE id IN (:visibleIds)`
 *      (via `resolveFleetPresence` default Postgres path)
 *   3. `SELECT id, daemon FROM server WHERE id IN (:visibleIds)`
 *      (via `readProjectionsForServers` inside fleet presence / colocated helpers)
 *   4. Colocated resolution may issue additional `SELECT` on `server` for machine id
 *      matching when a local machine id is available.
 */
export async function loadServersListDisplayData(
  db: Db,
  visibleIds: string[],
  registry: ReturnType<typeof getDaemonCellRegistry>,
): Promise<ServersListDisplayPayload> {
  if (visibleIds.length === 0) {
    return { rows: [], presence: [], colocatedIds: [] }
  }

  const rows = await db
    .select({
      id: server.id,
      displayName: server.displayName,
      organizationId: server.organizationId,
      licenseId: server.licenseId,
      options: server.options,
      createdAt: server.createdAt,
    })
    .from(server)
    .where(inArray(server.id, visibleIds))
    .orderBy(server.createdAt)

  const serverIds = rows.map((row) => row.id)
  const [presenceMap, colocatedIds] = await Promise.all([
    resolveFleetPresence(db, registry, serverIds),
    resolveColocatedServerIdSet(db, registry, serverIds),
  ])

  return {
    rows,
    presence: [...presenceMap.values()],
    colocatedIds: [...colocatedIds],
  }
}

export async function cachedServersListReadModel(
  c: Context,
  opts: {
    userId: string
    organizationId: string
    visibleIds: string[]
  },
): Promise<ServersListDisplayPayload> {
  const db = getDb(c)
  if (!db) {
    throw new Error('Database unavailable')
  }

  const { userId, organizationId, visibleIds } = opts
  const visibleIdsKey = [...visibleIds].sort().join(',')
  const registry = getDaemonCellRegistry(c)
  const cache = getQueryCache(c)

  return runApprovedCachedReadModel(
    cache,
    db,
    'servers-list',
    [userId, organizationId, visibleIdsKey],
    (readDb) => loadServersListDisplayData(readDb, visibleIds, registry),
  )
}
