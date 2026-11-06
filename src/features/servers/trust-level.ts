import { and, eq, isNull, lt, sql } from 'drizzle-orm'
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

/**
 * Record that this server's daemon signs its reports: set
 * `server.trust_reports_signed_at` the first time a signed report verifies.
 * One conditional update, a no-op once set; reset only when the identity key
 * is replaced or removed (`server-identity-db.ts`). From then on its unsigned
 * reports on a signed session are refused (`report-signature.ts`).
 * True when a row changed.
 */
export async function recordServerSignsReports(db: Db, serverId: string): Promise<boolean> {
  const rows = await db
    .update(server)
    .set({ trustReportsSignedAt: sql`now()` })
    .where(and(eq(server.id, serverId), isNull(server.trustReportsSignedAt)))
    .returning({ id: server.id })
  return rows.length > 0
}
