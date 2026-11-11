/**
 * Wires `healStaleTunnelTable` to the database and the table sender. Called
 * from the command consumer after a `server.tunnel.routes` command succeeded;
 * never throws (a failure is logged and leaves the command's outcome alone).
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { healStaleTunnelTable, staleTunnelTableWarning } from './stale-table-note.ts'
import { bumpTunnelGeneration, readStoredTunnelGeneration } from './table-generation.ts'
import { organization } from '../../db/schema.ts'
import { syncServerTunnelRoutes, type TunnelSyncDeps } from './sync.ts'

export async function healStaleTunnelTableOf(
  db: Db,
  record: { id: string; type: string; serverId: string },
  result: unknown,
  deps: TunnelSyncDeps | null
): Promise<void> {
  if (staleTunnelTableWarning(record.type, result) === undefined) return
  try {
    await healStaleTunnelTable(record, result, {
      organizationOf: async (serverId) => {
        const [row] = await db
          .select({ organizationId: server.organizationId })
          .from(server)
          .where(eq(server.id, serverId))
          .limit(1)
        // Without the queue and secrets nothing can be sent, so nothing is raised either.
        return deps === null ? undefined : (row?.organizationId ?? undefined)
      },
      sentGeneration: async (organizationId) => {
        const [row] = await db
          .select({ options: organization.options })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .limit(1)
        return readStoredTunnelGeneration(row?.options)?.generation
      },
      bump: (organizationId) => bumpTunnelGeneration(db, organizationId),
      resend: async (organizationId, serverId) => {
        if (deps === null) return
        await syncServerTunnelRoutes(db, deps, { organizationId, serverId, force: true })
      },
    })
  } catch (err) {
    compatLogWarn(
      'tunnel-sync',
      `server ${record.serverId}: raising the table generation failed: ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }
}
