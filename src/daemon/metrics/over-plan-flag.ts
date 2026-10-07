/**
 * The server-record side of the over-plan check (`over-plan.ts`): stamp
 * `server.metadata.overPlan` when a sample's sizes are past the licensed box
 * size, clear it once they are not. The sample itself is stored either way.
 * One `metadata ||` statement, so a concurrent write to another key is never
 * stomped, and the stamp is refreshed at most hourly while the server stays
 * over so a steady over-plan server does not write its row every minute.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { ExtendedSizes } from '../../contracts/metrics-contract.ts'
import { evaluateOverPlan, isOverPlan } from './over-plan.ts'

const OVER_PLAN_REFRESH_SECONDS = 3600

export type OverPlanMetadata = { at: string; memory: boolean; cpu: boolean }

/** The stamp on a server's metadata, or `null` when it is not flagged. */
export function readOverPlanStamp(serverMetadata: unknown): OverPlanMetadata | null {
  if (typeof serverMetadata !== 'object' || serverMetadata === null) return null
  const stamp = (serverMetadata as Record<string, unknown>).overPlan
  if (typeof stamp !== 'object' || stamp === null) return null
  const { at, memory, cpu } = stamp as Record<string, unknown>
  return typeof at === 'string' ? { at, memory: memory === true, cpu: cpu === true } : null
}

/**
 * Flag or unflag the server from one durable sample's sizes. `serverMetadata`
 * is the record the ingest route already loaded, so the common case (not over
 * plan, not flagged) costs no query at all.
 */
export async function recordOverPlan(
  db: Db,
  serverId: string,
  tierRank: number | null | undefined,
  sizes: ExtendedSizes | undefined,
  serverMetadata: unknown
): Promise<void> {
  const result = evaluateOverPlan(tierRank, sizes)
  const stamped = readOverPlanStamp(serverMetadata)
  if (!isOverPlan(result)) {
    if (stamped === null) return
    await db.execute(sql`
      UPDATE server SET metadata = metadata - 'overPlan'
      WHERE id = ${serverId}::uuid AND metadata ? 'overPlan'
    `)
    return
  }
  const unchanged =
    stamped !== null &&
    stamped.memory === result!.memory &&
    stamped.cpu === result!.cpu &&
    Date.now() - Date.parse(stamped.at) < OVER_PLAN_REFRESH_SECONDS * 1000
  if (unchanged) return
  const stamp = JSON.stringify({ at: new Date().toISOString(), ...result })
  await db.execute(sql`
    UPDATE server
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('overPlan', ${stamp}::jsonb)
    WHERE id = ${serverId}::uuid
  `)
}
