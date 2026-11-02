import { and, eq, isNotNull, or, sql } from 'drizzle-orm'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import { key, server } from '../../db/schema.ts'

/** Most servers closed per pass; normally there are none. */
export const STALE_KEY_SWEEP_LIMIT = 100

/**
 * Connected servers whose socket was opened with a key that is no longer the
 * server's active key: the key was revoked, or replaced (the projected attach
 * `keyId` differs from the key on file). One read; no Durable Object is woken
 * unless a row comes back.
 */
export async function listConnectedServersWithStaleKey(
  db: Db,
  limit = STALE_KEY_SWEEP_LIMIT
): Promise<string[]> {
  const projectedKeyId = sql<string | null>`${server.daemon} -> 'projection' ->> 'keyId'`
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .innerJoin(key, eq(key.serverId, server.id))
    .where(
      and(
        eq(server.isConnected, true),
        or(
          isNotNull(key.revokedAt),
          and(isNotNull(projectedKeyId), sql`${projectedKeyId} <> ${key.id}::text`)
        )
      )
    )
    .limit(limit)
  return rows.map((row) => row.id)
}

/**
 * The hosted re-check of open sockets, run from the once-a-minute cron: a
 * socket whose key was revoked or replaced closes within a minute, with no
 * per-cell alarm. Self-hosted checks the key on every inbound frame and ping
 * instead. Returns how many servers were told to drop their socket.
 */
export async function closeSocketsWithStaleKeys(
  db: Db,
  registry: DaemonCellRegistry
): Promise<number> {
  const serverIds = await listConnectedServersWithStaleKey(db)
  let closed = 0
  for (const serverId of serverIds) {
    const cell = registry.getCell(serverId)
    if (!cell.dropDaemonConnection) continue
    await cell.dropDaemonConnection('stale-key')
    closed += 1
  }
  return closed
}
