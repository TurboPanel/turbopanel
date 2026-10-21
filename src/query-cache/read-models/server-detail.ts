import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
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

export type ServerDetailRow = {
  id: string
  name: string | null
  organizationId: string
  licenseId: string | null
  /** Declared `server.machine_class`; null until pinned or inferred physical. */
  machineClass: string | null
  options: typeof server.$inferSelect.options
  createdAt: string
}

export type ServerDetailDisplayPayload = {
  row: ServerDetailRow
  presence: ServerFleetPresence | null
  colocatedWithInstance: boolean
}

/**
 * Approved cached read model: single-server detail display/projection data.
 *
 * **Cached connection (`readDb` / `HYPERDRIVE_CACHED` / Redis):** only statement #1
 * — the detail-row `SELECT` — runs here via `serverDetailCachedRead`. Do not move
 * presence, colocated, or authorization queries onto `readDb`.
 *
 * **Primary connection (`db` / `HYPERDRIVE`):** statement #2 — one shared
 * `loadServerRowsForFleetPresence` SELECT — feeds both `resolveFleetPresence` and
 * org-scoped `resolveColocatedServerIdSet` via preloaded rows/projections.
 *
 * SQL executed (read-only SELECT only; no transactions, mutations, or stable/
 * volatile PostgreSQL functions such as `now()`, `random()`, `nextval()`,
 * `clock_timestamp()`):
 *   1. `SELECT server.id, name, organization_id, license.id, machine_class,
 *      options, created_at FROM server LEFT JOIN license ON
 *      license.server_id = server.id WHERE server.id = :serverId AND
 *      server.organization_id = :organizationId`
 *   2. `SELECT id, daemon, metadata, hostname, machine_key, connected,
 *      status_changed_at FROM server WHERE id IN (:serverIds)`
 *      (shared preload for presence + org-scoped colocated enrichment)
 *
 * Cached SELECT (#1) reads no auth/session/secret columns — only the listed
 * display/projection fields — and contains none of the stable/volatile
 * functions above. Never select `daemon` / auth columns on the cached path.
 * `options` is passed through {@link redactServerOptions} before it is returned
 * (and therefore before it is cached), so a secret-bearing key left on the jsonb
 * by an older control plane never reaches Redis.
 */
function buildDetailRowQuery(readDb: CachedReadDb, input: DetailInput) {
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
    .where(and(eq(server.id, input.serverId), eq(server.organizationId, input.organizationId)))
    .limit(1)
}

type DetailInput = { organizationId: string; serverId: string; stamp: string }

/**
 * Registered cached read: statement #1 above. Redaction runs on the result, so
 * the self-hosted copy stores the redacted row.
 */
export const serverDetailCachedRead = defineCachedRead({
  id: 'server-detail',
  build: (readDb: CachedReadDb, input: DetailInput) => buildDetailRowQuery(readDb, input),
  transform: (rows, _input: DetailInput): ServerDetailRow | null => {
    const first = rows[0] as (ServerDetailRow & { _v?: string }) | undefined
    if (!first) return null
    const detail = withoutVersionStamp(first)
    return { ...detail, options: redactServerOptions(detail.options) }
  },
  samples: [{ organizationId: 'org-1', serverId: 'srv-1', stamp: 'stamp-a' }],
})

async function resolveServerDetailEnrichment(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string,
  rows: ServerFleetPresenceRow[]
): Promise<Pick<ServerDetailDisplayPayload, 'presence' | 'colocatedWithInstance'>> {
  const preloaded = {
    rows,
    projections: buildProjectionsFromDaemonRows(rows),
  }

  const [presenceMap, colocatedIds] = await Promise.all([
    resolveFleetPresence(db, registry, [serverId], { preloaded }),
    resolveColocatedServerIdSet(db, registry, [serverId], {
      orgScoped: true,
      preloaded,
    }),
  ])

  return {
    presence: presenceMap.get(serverId) ?? null,
    colocatedWithInstance: colocatedIds.has(serverId),
  }
}

export async function cachedServerDetailReadModel(
  c: Context,
  opts: {
    organizationId: string
    serverId: string
  }
): Promise<ServerDetailDisplayPayload | null> {
  const db = getDb(c)
  if (!db) {
    throw new Error('Database unavailable')
  }

  const { organizationId, serverId } = opts
  const registry = getDaemonCellRegistry(c)

  // Primary connection first: the row's last change is the version stamp, so
  // an edit changes the cache key at once. A server that is gone ends here.
  const loaded = await loadServerRowsForFleetPresence(db, [serverId])
  const current = loaded[0]
  if (!current) return null
  const stamp = versionStamp([current.id, current.updatedAt])
  const row = await serverDetailCachedRead(c, { organizationId, serverId, stamp })

  if (!row) return null

  const enrichment = await resolveServerDetailEnrichment(db, registry, serverId, loaded)

  return {
    row,
    ...enrichment,
  }
}
