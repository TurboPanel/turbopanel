import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { audit, server } from '../../db/schema.ts'
import { recordAudit } from '../audit/audit-records.ts'
import { logWarn } from '../../lib/logger.ts'

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

/** `server.trust_level` once a daemon proved itself with its own key (same as `DAEMON_PROOF_TRUST_LEVEL`). */
const PROVEN_TRUST_LEVEL = 2

/**
 * The trust level every gate reads: `server.trust_level`, or 2 when a signed
 * pin report naming a key has verified for this server. That report is only
 * taken after a verified attach proof, so it proves the server held its key
 * and a pin even where raising the level failed; a server that proved that
 * once is never accepted at a lower level again. An `unsafe` report (empty
 * pin) proves nothing about a pin and does not count.
 */
export function effectiveTrustLevel(row: {
  trustLevel: number | null
  trustPinFingerprint?: string | null
  trustPinReportedAt?: Date | string | null
}): number {
  const level = row.trustLevel ?? 0
  const pinProven = row.trustPinReportedAt != null && (row.trustPinFingerprint ?? '') !== ''
  return pinProven ? Math.max(level, PROVEN_TRUST_LEVEL) : level
}

const TRUST_DOWNGRADE_AUDIT_ACTION = 'server.trust_downgrade.refused'

/** How long one refused downgrade audit row stands for later ones of the same server. */
export const TRUST_DOWNGRADE_AUDIT_WINDOW_MS = 60 * 60 * 1000

/** Where a downgrade was refused: the sign-in request or the socket's attach proof. */
export type TrustDowngradeStage = 'auth-session' | 'attach'

/**
 * Record that a server which proved its key was refused for coming in without
 * that proof (`server.trust_downgrade.refused`): a missing request signature
 * on `/auth/session`, or a missing attach proof on the socket. Something on
 * the path removed it, or the host runs an older daemon again. Written only
 * after the daemon's own proof verified, so nobody else can add rows, and at
 * most one row per server per {@link TRUST_DOWNGRADE_AUDIT_WINDOW_MS} because
 * the daemon keeps retrying. Never throws. True when a row was written.
 */
export async function recordTrustDowngradeRefused(
  db: Db,
  serverId: string,
  refusal: { stage: TrustDowngradeStage; reason: string },
  deps: { audit?: typeof recordAudit; nowMs?: number } = {}
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    if (!row) return false
    const since = new Date(
      (deps.nowMs ?? Date.now()) - TRUST_DOWNGRADE_AUDIT_WINDOW_MS
    ).toISOString()
    const [recent] = await db
      .select({ id: audit.id })
      .from(audit)
      .where(
        and(
          row.organizationId === null
            ? isNull(audit.organizationId)
            : eq(audit.organizationId, row.organizationId),
          gt(audit.createdAt, since),
          eq(audit.action, TRUST_DOWNGRADE_AUDIT_ACTION),
          eq(audit.targetId, serverId)
        )
      )
      .limit(1)
    if (recent) return false
    await (deps.audit ?? recordAudit)(db, {
      organizationId: row.organizationId,
      actorUserId: null,
      action: TRUST_DOWNGRADE_AUDIT_ACTION,
      targetType: 'server',
      targetId: serverId,
      context: { stage: refusal.stage, reason: refusal.reason },
    })
    return true
  } catch (err) {
    logWarn(
      'daemon',
      `trust downgrade audit failed for ${serverId}: ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}
