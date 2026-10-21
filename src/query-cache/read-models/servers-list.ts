import type { Context } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { getDb, getDaemonCellRegistry, type Db } from '../../db/connection.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import type { ServerFleetPresence } from '../../daemon/cell/server-status.ts'
import {
  buildProjectionsFromDaemonRows,
  loadServerRowsForFleetPresence,
  type ServerFleetPresenceRow,
} from '../../daemon/cell/postgres-projection.ts'
import { license, server } from '../../db/schema.ts'
import { redactServerOptions } from '../../features/servers/server-metadata.ts'
import { resolveColocatedServerIdSet } from '../../client/servers/colocated.ts'
import {
  defineCachedRead,
  versionStamp,
  versionStampColumn,
  withoutVersionStamp,
  type CachedReadDb,
} from '../cached-read.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'

export type ServersListRow = {
  id: string
  name: string | null
  organizationId: string
  licenseId: string | null
  /** Declared `server.machine_class`; null until pinned or inferred physical. */
  machineClass: string | null
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
 * **Cached connection (`readDb` / `HYPERDRIVE_CACHED` / Redis):** only statement #1
 * — the list-rows `SELECT` — runs here via `serversListCachedRead`. Do not move
 * presence, colocated, or authorization queries onto `readDb`.
 *
 * **Primary connection (`db` / `HYPERDRIVE`):** statement #2 — one shared
 * `loadServerRowsForFleetPresence` SELECT — feeds both `resolveFleetPresence` and
 * org-scoped `resolveColocatedServerIdSet` via preloaded rows/projections
 * (`resolveServersListEnrichment` / `buildProjectionsFromDaemonRows`).
 *
 * SQL executed (read-only SELECT only; no transactions, mutations, or stable/
 * volatile PostgreSQL functions such as `now()`, `random()`, `nextval()`,
 * `clock_timestamp()`):
 *   1. `SELECT server.id, name, organization_id, license.id, machine_class,
 *      options, created_at FROM server LEFT JOIN license ON
 *      license.server_id = server.id WHERE server.id IN (:visibleIds)
 *      ORDER BY created_at`
 *   2. `SELECT id, daemon, metadata, hostname, machine_key, connected,
 *      status_changed_at FROM server WHERE id IN (:serverIds)`
 *      (shared preload for presence + org-scoped colocated enrichment)
 *
 * Cached SELECT (#1) reads no auth/session/secret columns — only the listed
 * display/projection fields — and contains none of the stable/volatile
 * functions above. `options` is passed through {@link redactServerOptions}
 * before it is returned (and therefore before it is cached), so a secret-bearing
 * key left on the jsonb by an older control plane never reaches Redis.
 */
type ListInput = { organizationId: string; ids: string[]; stamp: string }

function buildListRowsQuery(readDb: CachedReadDb, input: ListInput) {
  return readDb
    .select({
      id: server.id,
      name: server.name,
      organizationId: server.organizationId,
      licenseId: license.id,
      machineClass: server.machineClass,
      options: server.options,
      createdAt: server.createdAt,
      _v: versionStampColumn(input.stamp),
    })
    .from(server)
    .leftJoin(license, eq(license.serverId, server.id))
    .where(inArray(server.id, input.ids))
    .orderBy(server.createdAt)
}

/**
 * Registered cached read: statement #1 above. Redaction runs on the result, so
 * the self-hosted copy stores the redacted rows (what goes into Redis is what
 * goes to the client).
 */
export const serversListCachedRead = defineCachedRead({
  id: 'servers-list',
  scope: (input: ListInput) => [input.organizationId],
  build: (readDb: CachedReadDb, input: ListInput) => buildListRowsQuery(readDb, input),
  transform: (rows, _input: ListInput): ServersListRow[] =>
    (rows as Array<ServersListRow & { _v?: string }>).map((row) => {
      const plain = withoutVersionStamp(row)
      return { ...plain, options: redactServerOptions(plain.options) }
    }),
  samples: [
    { organizationId: 'org-1', ids: ['srv-1'], stamp: 'stamp-a' },
    { organizationId: 'org-1', ids: ['srv-1', 'srv-2', 'srv-3'], stamp: 'stamp-b' },
  ],
})

async function resolveServersListEnrichment(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverIds: string[],
  loaded: ServerFleetPresenceRow[]
): Promise<Pick<ServersListDisplayPayload, 'presence' | 'colocatedIds'>> {
  // The rows were read on the primary connection to make the version stamp;
  // reuse them. Only if the cached rows name a server they lack (one created
  // in between) is the statement run again.
  const wanted = new Set(serverIds)
  const kept = loaded.filter((row) => wanted.has(row.id))
  const rows =
    kept.length === new Set(serverIds).size
      ? kept
      : await loadServerRowsForFleetPresence(db, serverIds)
  const preloaded = {
    rows,
    projections: buildProjectionsFromDaemonRows(rows),
  }

  const [presenceMap, colocatedIds] = await Promise.all([
    resolveFleetPresence(db, registry, serverIds, { preloaded }),
    resolveColocatedServerIdSet(db, registry, serverIds, {
      orgScoped: true,
      preloaded,
    }),
  ])

  return {
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
  }
): Promise<ServersListDisplayPayload> {
  const db = getDb(c)
  if (!db) {
    throw new Error('Database unavailable')
  }

  const { organizationId, visibleIds } = opts
  // Canonical order so the same set of ids always builds the same statement.
  const sortedVisibleIds = [...visibleIds].sort((a, b) => a.localeCompare(b))
  if (sortedVisibleIds.length === 0) {
    return { rows: [], presence: [], colocatedIds: [] }
  }
  const registry = getDaemonCellRegistry(c)

  // Primary connection first: it gives the version stamp (id + last change of
  // each row), so an edit changes the cache key at once.
  const loaded = await loadServerRowsForFleetPresence(db, sortedVisibleIds)
  const stamp = versionStamp(
    [...loaded].sort((a, b) => a.id.localeCompare(b.id)).flatMap((row) => [row.id, row.updatedAt])
  )
  const rows = await serversListCachedRead(c, { organizationId, ids: sortedVisibleIds, stamp })

  if (rows.length === 0) {
    return { rows: [], presence: [], colocatedIds: [] }
  }

  const serverIds = rows.map((row) => row.id)
  const enrichment = await resolveServersListEnrichment(db, registry, serverIds, loaded)

  return {
    rows,
    ...enrichment,
  }
}
