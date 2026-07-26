import { inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { PreloadedFleetPresenceData } from '../../daemon/cell/server-status.ts'
import { readProjectionsForServers } from '../../daemon/cell/postgres-projection.ts'
import { resolveColocatedServerId, readLocalMachineId } from '../authn/install-state.ts'
import { server } from '../../lib/db/schema.ts'

export type ResolveColocatedServerIdSetOptions = {
  /**
   * Org-scoped visible server lists already filter to assigned organization rows.
   * Skip the broader unassigned canonical lookup from `resolveColocatedServerId`.
   */
  orgScoped?: boolean
  /** Reuse rows/projections from a single fleet-presence preload. */
  preloaded?: PreloadedFleetPresenceData
}

/** Server ids for daemons co-located with this control plane instance. */
export async function resolveColocatedServerIdSet(
  db: Db,
  _registry: DaemonCellRegistry | undefined,
  serverIds: string[],
  options: ResolveColocatedServerIdSetOptions = {},
): Promise<Set<string>> {
  const colocated = new Set<string>()
  if (serverIds.length === 0) return colocated

  if (!options.orgScoped) {
    const canonical = await resolveColocatedServerId(db)
    if (canonical && serverIds.includes(canonical)) {
      colocated.add(canonical)
    }
  }

  const projections = options.preloaded?.projections
    ?? await readProjectionsForServers(db, serverIds)
  for (const id of serverIds) {
    if (projections.get(id)?.remoteAddress === '__direct__') {
      colocated.add(id)
    }
  }

  const localMachineId = await readLocalMachineId()
  if (localMachineId) {
    const rows = options.preloaded?.rows
      ?? await db
        .select({ id: server.id, machineId: server.machineId })
        .from(server)
        .where(inArray(server.id, serverIds))
    for (const row of rows) {
      if (row.machineId === localMachineId) {
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
