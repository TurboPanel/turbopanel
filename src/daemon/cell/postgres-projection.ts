import type { Db } from '../../db.ts'
import { server } from '../../lib/db/schema.ts'
import { eq } from 'drizzle-orm'
import type { ServerMetadata } from '../../lib/db/server-metadata.ts'
import { touchServerMetadata } from '../../server-registry.ts'
import type { DaemonCellSnapshot } from './contracts.ts'

function nowTs(): string {
  return new Date().toISOString()
}

/**
 * Write-through: keep Postgres `server.metadata` aligned with the cell snapshot
 * for operational fields the snapshot owns.
 */
export async function touchServerMetadataFromSnapshot(
  db: Db,
  serverId: string,
  snapshot: DaemonCellSnapshot,
): Promise<void> {
  await touchServerMetadata(db, serverId, {
    hostname: snapshot.hostname,
    machineId: snapshot.machineId,
  })

  if (snapshot.lastHeartbeatAt) {
    await db.update(server).set({
      lastSeenAt: snapshot.lastHeartbeatAt,
      updatedAt: nowTs(),
    }).where(eq(server.id, serverId))
  }

  const operationalPatch: Partial<ServerMetadata> & Record<string, unknown> = {}
  if (snapshot.remoteAddress) operationalPatch.remoteAddress = snapshot.remoteAddress

  if (Object.keys(operationalPatch).length === 0) return

  const rows = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const current = (rows[0]?.metadata ?? {}) as ServerMetadata
  await db.update(server).set({
    metadata: { ...current, ...operationalPatch },
    updatedAt: nowTs(),
  }).where(eq(server.id, serverId))
}
