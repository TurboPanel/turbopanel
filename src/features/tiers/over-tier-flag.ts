/**
 * The server-record side of the session tier check (`checkServerLicenseEntitlement`
 * in `daemon/api-routes.ts`): a server the organization's purchased sizes no
 * longer cover is still let in, and `server.metadata.overTier` records when it
 * first went over and the rank it needs. The stamp is written once and kept
 * while the server stays over, so `since` is the date it went over; it is
 * removed once the server is covered again. One single-key `jsonb_set` (or key
 * removal) statement, so a concurrent write to another metadata key is never
 * stomped.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'

export type OverTierMetadata = { since: string; requiredRank: number }

/** The stamp on a server's metadata, or `null` when it is not over its tier. */
export function readOverTierStamp(serverMetadata: unknown): OverTierMetadata | null {
  if (typeof serverMetadata !== 'object' || serverMetadata === null) return null
  const stamp = (serverMetadata as Record<string, unknown>).overTier
  if (typeof stamp !== 'object' || stamp === null) return null
  const { since, requiredRank } = stamp as Record<string, unknown>
  return typeof since === 'string' && typeof requiredRank === 'number'
    ? { since, requiredRank }
    : null
}

/**
 * Stamp the server as over its tier (`requiredRank` set) or clear the stamp
 * (`requiredRank` null). `serverMetadata` is the record the caller already
 * loaded, so the common case (covered, not stamped) costs no query.
 */
export async function recordOverTier(
  db: Db,
  serverId: string,
  requiredRank: number | null,
  serverMetadata: unknown
): Promise<void> {
  const stamped = readOverTierStamp(serverMetadata)
  if (requiredRank === null) {
    if (stamped === null) return
    await db.execute(sql`
      UPDATE server SET metadata = metadata - 'overTier'
      WHERE id = ${serverId}::uuid AND metadata ? 'overTier'
    `)
    return
  }
  if (stamped !== null) return
  const stamp = JSON.stringify({ since: new Date().toISOString(), requiredRank })
  await db.execute(sql`
    UPDATE server
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{overTier}', ${stamp}::jsonb)
    WHERE id = ${serverId}::uuid AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'overTier')
  `)
}
