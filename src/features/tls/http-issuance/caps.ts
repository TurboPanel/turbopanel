/**
 * Organization-wide limits on server-placed orders, on top of the per-row
 * attempt rules in `attempts.ts`: how many new certificates one organization
 * may start in a day, and a pause for the whole organization once the
 * authority said it is rate limiting. Pure rules plus one read.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import { tls } from '../../../db/schema.ts'
import { isRateLimitReason } from './attempts.ts'
import { readHttpIssuanceState } from './state.ts'

const DAY_MS = 24 * 60 * 60_000

/** New certificates (first orders, not renewals) one organization may start in a day. */
export const NEW_CERTIFICATES_PER_DAY = 10

export type CapVerdict = { ok: true } | { ok: false; reason: 'daily_cap' | 'rate_limited' }

/** What the organization's server-placed rows say, reduced to the two rules. */
export type OrgOrderFacts = {
  /** Start time of each row's current request that is still a first certificate. */
  newStarts: readonly string[]
  /** Failed rows still waiting out a wait, with the reason they failed. */
  waiting: ReadonlyArray<{ nextAttemptAt: string; reason: string }>
}

/** Whether another new certificate may start now for the organization. */
export function mayStartNewCertificate(facts: OrgOrderFacts, now: Date): CapVerdict {
  const t = now.getTime()
  // An authority rate limit applies to the whole account, so one row hitting it pauses every new start.
  const limited = facts.waiting.some(
    (w) => Date.parse(w.nextAttemptAt) > t && isRateLimitReason(w.reason)
  )
  if (limited) return { ok: false, reason: 'rate_limited' }
  const today = facts.newStarts.filter((s) => Date.parse(s) > t - DAY_MS)
  return today.length >= NEW_CERTIFICATES_PER_DAY
    ? { ok: false, reason: 'daily_cap' }
    : { ok: true }
}

/**
 * Read the facts for one organization. A row counts as a new certificate while
 * it has no stored pair, or has had only its first issue; a row renewing an
 * older pair does not count. The row being started is left out, so its own
 * earlier tries do not count against it.
 */
export async function loadOrgOrderFacts(
  db: Db,
  organizationId: string,
  exceptTlsId: string
): Promise<OrgOrderFacts> {
  const rows = await db
    .select({
      id: tls.id,
      metadata: tls.metadata,
      hasKey: sql<boolean>`${tls.privateKeyPem} is not null`,
    })
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, organizationId),
        eq(tls.source, 'lets_encrypt'),
        sql`${tls.metadata} -> 'httpCert' is not null`
      )
    )
  const newStarts: string[] = []
  const waiting: Array<{ nextAttemptAt: string; reason: string }> = []
  for (const row of rows) {
    const state = readHttpIssuanceState(row.metadata)
    if (!state) continue
    if (row.id !== exceptTlsId && (!row.hasKey || state.issueTimes.length <= 1))
      newStarts.push(state.startedAt)
    if (state.phase === 'failed' && state.nextAttemptAt !== null && state.lastError !== null) {
      waiting.push({ nextAttemptAt: state.nextAttemptAt, reason: state.lastError })
    }
  }
  return { newStarts, waiting }
}
