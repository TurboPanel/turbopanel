/**
 * The latest resolved v5 metrics-capability plan of a server, kept on the
 * server row (`server.capability`, see `../../db/schema.ts`): `generation`,
 * `planHash`, `plan` and `appliedAt`. It is overwritten in place, so there is
 * no history; the plan can always be recomputed from the box size and the
 * hardware. Written lazily whenever a resolved plan is needed —
 * `POST /api/daemon/v1/metrics` (`../../daemon/api-routes.ts`) calls this on
 * every ingest — and a `capability-plan-update` cell push follows when the
 * generation actually changes.
 *
 * {@link recordCapabilityPlanGenerationIfChanged} hashes the resolved plan
 * (`computeMetricsCapabilityPlanHash`) and compares it against the stored
 * hash: an unchanged plan is a no-op, a changed (or first-ever) plan is
 * written with `generation = previous + 1` (or `0`).
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import {
  computeMetricsCapabilityPlanHash,
  type MetricsCapabilityPlan,
} from '../../contracts/capability-plan.ts'

export type CapabilityPlanGenerationRecord = {
  generation: number
  planHash: string
  plan: unknown
  appliedAt: string
}

export type CapabilityPlanGenerationWrite = {
  generation: number
  changed: boolean
}

/** A stored `server.capability` value, or `undefined` when it is absent or malformed. */
export function parseStoredCapability(value: unknown): CapabilityPlanGenerationRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (
    typeof raw.generation !== 'number' ||
    !Number.isInteger(raw.generation) ||
    typeof raw.planHash !== 'string' ||
    typeof raw.appliedAt !== 'string'
  ) {
    return undefined
  }
  return {
    generation: raw.generation,
    planHash: raw.planHash,
    plan: raw.plan ?? null,
    appliedAt: raw.appliedAt,
  }
}

/** The plan last recorded for a server, or `undefined` if none has been recorded yet. */
export async function getLatestCapabilityPlanGeneration(
  db: Pick<Db, 'select'>,
  serverId: string
): Promise<CapabilityPlanGenerationRecord | undefined> {
  const [row] = await db
    .select({ capability: server.capability })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return parseStoredCapability(row?.capability)
}

/**
 * Resolve the current plan's hash against the stored plan for `serverId`;
 * write a new generation only when it differs (or none has ever been
 * recorded). Returns the (possibly unchanged) current generation and whether
 * it was written.
 *
 * An unchanged plan (the common case) is answered by one unlocked read. Only
 * a differing plan opens a transaction that locks the server's row `FOR
 * UPDATE` first, serializing concurrent resolutions for the same server, and
 * re-reads under the lock so two callers with different plans cannot both
 * take the same next generation number.
 */
export async function recordCapabilityPlanGenerationIfChanged(
  db: Db,
  serverId: string,
  resolvedPlan: MetricsCapabilityPlan
): Promise<CapabilityPlanGenerationWrite> {
  const planHash = await computeMetricsCapabilityPlanHash(resolvedPlan)

  const unlocked = await getLatestCapabilityPlanGeneration(db, serverId)
  if (unlocked?.planHash === planHash) {
    return { generation: unlocked.generation, changed: false }
  }

  return await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ capability: server.capability })
      .from(server)
      .where(eq(server.id, serverId))
      .for('update')
      .limit(1)
    const latest = parseStoredCapability(locked?.capability)
    if (latest?.planHash === planHash) {
      return { generation: latest.generation, changed: false }
    }

    const generation = latest ? latest.generation + 1 : 0
    const value: CapabilityPlanGenerationRecord = {
      generation,
      planHash,
      plan: resolvedPlan,
      appliedAt: new Date().toISOString(),
    }
    await tx
      .update(server)
      .set({
        capability: sql`${JSON.stringify(value)}::jsonb`,
        // Not an edit of the server: keep the version stamp the cached screens read.
        updatedAt: sql`${server.updatedAt}`,
      })
      .where(eq(server.id, serverId))
    return { generation, changed: true }
  })
}
