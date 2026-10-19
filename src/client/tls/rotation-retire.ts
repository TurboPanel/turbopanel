/**
 * Retiring the previous Organization CA generation once a rotation has
 * converged, by an owner (`POST /tls/ca/retire`) or by the sweep once the
 * rotation's `retire_by` deadline has passed.
 *
 * The previous generation may only stop being trusted when nothing still needs
 * it: every live target converged, and no active leaf is still signed by an
 * older generation. A leaf an owner marked stale (or the sweep did, for a
 * server gone for weeks) no longer holds the retire back.
 */
import { and, asc, eq, isNotNull, lte, or, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { changeover, leaf, tls } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { listCommandRecordsByIds } from '../../features/commands/command-records.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { reconcileOrganizationOrchestratorTrust } from './changeover-fanout.ts'
import { loadLatestCaRotation, updateCaRotationJournal } from './changeover-lease.ts'
import { systemRotationContext } from './system-context.ts'
import {
  enumerateOrganizationRotationTargets,
  parseCaRotationResults,
} from './changeover-fanout.ts'
import { persistSyncedRotationResults, rotationConvergedForRetire } from './rotation-converge.ts'

export type RetireRefusal =
  'no_pending_rotation' | 'ca_rotation_not_converged' | 'ca_leaves_outstanding'

export type RetireOutcome =
  { ok: true; rotationId: string } | { ok: false; reason: RetireRefusal; outstanding?: number }

export type RetireDeps = Readonly<{
  /** `null` when this context has no command queue: trust is not re-sent after the retire. */
  commandQueue: CommandQueue | null
  secretsConfig: SecretsConfig | null
  dataEncryptionSecrets: DerivedSecretsConfig | null
}>

/**
 * Leaves that still need the previous generation: active ones still signed by
 * an older generation, and ones marked stale because their server was offline
 * whose server is connected again (the sweep brings those back and renews them;
 * retiring first would leave a connected server with a certificate nothing
 * trusts). Leaves an owner marked stale, or that nothing uses, do not count.
 */
export async function countLeavesOnOlderGeneration(
  db: Db,
  organizationId: string,
  activeGeneration: number
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(leaf)
    .where(
      and(
        eq(leaf.organizationId, organizationId),
        sql`${leaf.caGeneration} IS DISTINCT FROM ${activeGeneration}`,
        or(
          eq(leaf.state, 'active'),
          and(
            eq(leaf.staleCause, 'offline'),
            sql`${leaf.serverId} IN (SELECT id FROM server WHERE is_connected)`
          )
        )
      )
    )
  return Number(row?.n ?? 0)
}

async function revokeRetiredOrganizationCas(db: Db, organizationId: string): Promise<void> {
  const now = new Date().toISOString()
  await db
    .update(tls)
    .set({ caState: 'revoked', status: 'revoked', updatedAt: now })
    .where(
      and(
        eq(tls.organizationId, organizationId),
        eq(tls.source, 'organization_ca'),
        eq(tls.caState, 'retired')
      )
    )
}

/**
 * After retire the trust bundle holds only the active generation: send it to
 * every Orchestrator host so none keeps trusting the retired CA. Skipped (and
 * logged) when this context has no command queue or secrets; never fails the
 * retire, which has already completed.
 */
async function reconcileOrchestratorTrustAfterRetire(
  db: Db,
  organizationId: string,
  actor: Readonly<{ actorType: 'user' | 'system'; actorId: string }>,
  deps: RetireDeps
): Promise<void> {
  if (!deps.commandQueue || !deps.secretsConfig || !deps.dataEncryptionSecrets) {
    compatLogWarn(
      'tls-rotation',
      `orchestrator trust reconcile skipped after retire organizationId=${organizationId}: no command queue or secrets`
    )
    return
  }
  await reconcileOrganizationOrchestratorTrust(db, deps.commandQueue, {
    organizationId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    secretsConfig: deps.secretsConfig,
    dataEncryptionSecrets: deps.dataEncryptionSecrets,
  })
}

/**
 * Retire the previous generation of the organization's pending rotation.
 * `enqueueGaps` lets an owner's request queue the applies a member is still
 * missing; the sweep leaves that to the owner and only retires a rotation that
 * has already converged.
 */
export async function retireAwaitingRotation(
  c: Context<AppEnv>,
  db: Db,
  params: {
    organizationId: string
    actorType: 'user' | 'system'
    actorId: string
    enqueueGaps: boolean
    deps: RetireDeps
  }
): Promise<RetireOutcome> {
  const { organizationId } = params
  const journal = await loadLatestCaRotation(db, organizationId)
  if (journal?.state !== 'awaiting_retire') {
    return { ok: false, reason: 'no_pending_rotation' }
  }

  const synced = await persistSyncedRotationResults(c, db, {
    organizationId,
    rotationId: journal.id,
    actorId: params.actorId,
    startedAt: journal.startedAt,
    rows: parseCaRotationResults(journal.results),
    enqueueGaps: params.enqueueGaps,
  })
  const commandIds = synced.flatMap((row) => (row.commandId ? [row.commandId] : []))
  const records = await listCommandRecordsByIds(db, commandIds)
  const targets = await enumerateOrganizationRotationTargets(db, organizationId)
  if (!rotationConvergedForRetire(synced, records, targets.members)) {
    return { ok: false, reason: 'ca_rotation_not_converged' }
  }

  const outstanding = await countLeavesOnOlderGeneration(db, organizationId, journal.toCaGeneration)
  if (outstanding > 0) {
    return { ok: false, reason: 'ca_leaves_outstanding', outstanding }
  }

  await revokeRetiredOrganizationCas(db, organizationId)
  await updateCaRotationJournal(db, journal.id, {
    state: 'completed',
    completedAt: new Date().toISOString(),
  })
  await reconcileOrchestratorTrustAfterRetire(
    db,
    organizationId,
    { actorType: params.actorType, actorId: params.actorId },
    params.deps
  )
  return { ok: true, rotationId: journal.id }
}

export type OverdueRetireResult = { checked: number; retired: number }

/** Max overdue rotations looked at per sweep tick. */
export const OVERDUE_RETIRE_BATCH = 10

/**
 * Retire every rotation whose `retire_by` deadline has passed and that has
 * converged with no active leaf left on an older generation. One that has not
 * stays `awaiting_retire`; the Organization CA card says what it waits on.
 */
export async function retireOverdueRotations(
  db: Db,
  deps: RetireDeps,
  nowMs = Date.now()
): Promise<OverdueRetireResult> {
  const due = await db
    .select({ organizationId: changeover.organizationId, id: changeover.id })
    .from(changeover)
    .where(
      and(
        eq(changeover.state, 'awaiting_retire'),
        isNotNull(changeover.retireBy),
        lte(changeover.retireBy, new Date(nowMs).toISOString())
      )
    )
    .orderBy(asc(changeover.retireBy))
    .limit(OVERDUE_RETIRE_BATCH)
  const result: OverdueRetireResult = { checked: due.length, retired: 0 }
  const context = systemRotationContext(deps)
  for (const row of due) {
    try {
      const outcome = await retireAwaitingRotation(context, db, {
        organizationId: row.organizationId,
        actorType: 'system',
        actorId: row.organizationId,
        enqueueGaps: false,
        deps,
      })
      if (!outcome.ok) continue
      result.retired += 1
      await recordAudit(db, {
        organizationId: row.organizationId,
        actorUserId: null,
        action: 'tls.ca.retire',
        targetType: 'organization',
        targetId: row.organizationId,
        context: { rotationId: outcome.rotationId, by: 'deadline' },
      })
    } catch (err) {
      compatLogWarn(
        'tls-rotation',
        `overdue retire failed organizationId=${row.organizationId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return result
}
