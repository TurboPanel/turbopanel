import { and, eq, lt } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'

/**
 * Raise `server.trust_level` to `level`; never lowers it. One conditional
 * update, a no-op once the server is already there. True when a row changed.
 */
export async function raiseServerTrustLevel(
  db: Db,
  serverId: string,
  level: number
): Promise<boolean> {
  const rows = await db
    .update(server)
    .set({ trustLevel: level })
    .where(and(eq(server.id, serverId), lt(server.trustLevel, level)))
    .returning({ id: server.id })
  return rows.length > 0
}
