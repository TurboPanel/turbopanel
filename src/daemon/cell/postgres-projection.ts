import type { Db } from '../../db.ts'
import { server } from '../../lib/db/schema.ts'
import { eq } from 'drizzle-orm'
import type { ServerMetadata } from '../../lib/db/server-metadata.ts'
import { touchServerMetadata } from '../../server-registry.ts'
import { touchDaemonSessionLastUsed } from '../authn/daemon-session-db.ts'
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

  const operationalPatch: Partial<ServerMetadata> & Record<string, unknown> = {}
  if (snapshot.remoteAddress) operationalPatch.remoteAddress = snapshot.remoteAddress
  if (snapshot.connectedAt) operationalPatch.connectedAt = snapshot.connectedAt
  if (snapshot.lastHeartbeatAt) {
    operationalPatch.lastHeartbeatAt = snapshot.lastHeartbeatAt
  }

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

/** Thin wrapper around {@link touchDaemonSessionLastUsed} for heartbeat paths. */
export async function touchDaemonSessionFromHeartbeat(
  db: Db,
  sessionId: string,
): Promise<void> {
  await touchDaemonSessionLastUsed(db, sessionId)
}
