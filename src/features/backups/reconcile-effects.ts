/**
 * What a succeeded `server.backups.reconcile` command writes: each policy's
 * next run, as the host's timers report it, so the panel can show it before
 * the policy's first run report arrives. Only policies the command itself
 * carried are touched (the payload is the control plane's own), never one a
 * host merely names in its result.
 */

import { eq, sql } from 'drizzle-orm'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { Db } from '../../db/connection.ts'
import { retention } from '../../db/schema.ts'
import {
  parseBackupsReconcilePayload,
  parseBackupsReconcileResult,
} from '../../contracts/commands/schemas.ts'

type ReconcileCommandRecord = { id: string; type: string; payload: unknown }

/** The `(policyId, nextRunAt)` pairs the host reported for policies the command sent. */
export function reportedNextRuns(
  payload: unknown,
  result: unknown
): Array<{ policyId: string; nextRunAt: string }> {
  const sent = new Set(parseBackupsReconcilePayload(payload).policies.map((p) => p.policyId))
  const out: Array<{ policyId: string; nextRunAt: string }> = []
  for (const next of parseBackupsReconcileResult(result).nextRuns) {
    if (next.nextRunAt !== undefined && sent.has(next.policyId)) {
      out.push({ policyId: next.policyId, nextRunAt: next.nextRunAt })
    }
  }
  return out
}

export async function applyBackupsReconcileSideEffect(
  db: Db,
  record: ReconcileCommandRecord,
  result: unknown
): Promise<void> {
  if (record.type !== 'server.backups.reconcile') return
  try {
    await Promise.all(
      reportedNextRuns(record.payload, result).map((next) =>
        db
          .update(retention)
          // A report is not an edit: keep `updated_at` as the operator left it.
          .set({ nextRunAt: next.nextRunAt, updatedAt: sql`${retention.updatedAt}` })
          .where(eq(retention.id, next.policyId))
      )
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn(
      'command-consumer',
      `backups reconcile side effect failed for command ${record.id}: ${message}`
    )
  }
}
