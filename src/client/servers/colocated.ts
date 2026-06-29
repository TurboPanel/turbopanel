import { inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import { readProjectionsForServers } from '../../daemon/cell/postgres-projection.ts'
import { resolveColocatedServerId, readLocalMachineId } from '../authn/install-state.ts'
import type { ServerMetadata } from '../../lib/db/server-metadata.ts'
import { server } from '../../lib/db/schema.ts'

/** Server ids for daemons co-located with this control plane instance. */
export async function resolveColocatedServerIdSet(
  db: Db,
  _registry: DaemonCellRegistry | undefined,
  serverIds: string[],
): Promise<Set<string>> {
  const colocated = new Set<string>()
  if (serverIds.length === 0) return colocated

  const canonical = await resolveColocatedServerId(db)
  if (canonical && serverIds.includes(canonical)) {
    colocated.add(canonical)
  }

  const projections = await readProjectionsForServers(db, serverIds)
  for (const id of serverIds) {
    if (projections.get(id)?.remoteAddress === '__direct__') {
      colocated.add(id)
    }
  }

  const localMachineId = await readLocalMachineId()
  if (localMachineId) {
    const rows = await db
      .select({ id: server.id, metadata: server.metadata })
      .from(server)
      .where(inArray(server.id, serverIds))
    for (const row of rows) {
      const metadata = (row.metadata ?? {}) as ServerMetadata
      if (metadata.machineId === localMachineId) {
        colocated.add(row.id)
      }
    }
  }

  return colocated
}

export function isColocatedWithInstance(
  serverId: string,
  colocatedIds: Set<string>,
): boolean {
  return colocatedIds.has(serverId)
}
