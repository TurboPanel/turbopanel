/**
 * Organization-wide limits on server-placed orders, on top of the per-row
 * attempt rules in `attempts.ts`: how many new certificates one organization
 * may start in a day, and a pause for the whole organization once the
 * authority said it is rate limiting. Pure rules plus one read.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import { organization, tls } from '../../../db/schema.ts'
import { isRateLimitReason } from './attempts.ts'
import { readHttpIssuanceState } from './state.ts'

const DAY_MS = 24 * 60 * 60_000

/** New certificates (first orders, not renewals) one organization may start in a day. */
export const NEW_CERTIFICATES_PER_DAY = 10

export type CapVerdict = { ok: true } | { ok: false; reason: 'daily_cap' | 'rate_limited' }

/** What the organization's server-placed rows say, reduced to the two rules. */
export type OrgOrderFacts = {
  /** When each new certificate (not a renewal) of the last day was started. */
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

/** Where the organization keeps the times it started new certificates (in `organization.options`). */
const NEW_STARTS_KEY = 'acmeNewStarts'

/** Keep only well-formed times of the last day. */
function recentStarts(value: unknown, now: Date): string[] {
  if (!Array.isArray(value)) return []
  const floor = now.getTime() - DAY_MS
  return value.filter((v): v is string => typeof v === 'string' && Date.parse(v) > floor)
}

/**
 * Note that a new certificate was started, in the organization's own record: the
 * count then survives the certificate being unpinned or deleted. Run inside the
 * transaction that starts the order; the update is one statement, so two
 * starts at once both land.
 */
export async function recordNewCertificateStart(
  tx: Db,
  organizationId: string,
  now: Date
): Promise<void> {
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString()
  const at = now.toISOString()
  await tx
    .update(organization)
    .set({
      options: sql`jsonb_set(coalesce(${organization.options}, '{}'::jsonb), '{acmeNewStarts}', coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(${organization.options} -> ${NEW_STARTS_KEY}::text, '[]'::jsonb)) as v where (v #>> '{}') > ${cutoff}), '[]'::jsonb) || to_jsonb(${at}::text))`,
    })
    .where(eq(organization.id, organizationId))
}

/**
 * Read the facts for one organization: the new starts the organization noted in
 * the last day, and the rows still waiting out a failed order.
 */
export async function loadOrgOrderFacts(
  db: Db,
  organizationId: string,
  now: Date
): Promise<OrgOrderFacts> {
  const [org] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  const newStarts = recentStarts(
    (org?.options as Record<string, unknown> | null)?.[NEW_STARTS_KEY],
    now
  )
  const rows = await db
    .select({ metadata: tls.metadata })
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, organizationId),
        eq(tls.source, 'lets_encrypt'),
        sql`${tls.metadata} -> 'httpCert' is not null`
      )
    )
  const waiting: Array<{ nextAttemptAt: string; reason: string }> = []
  for (const row of rows) {
    const state = readHttpIssuanceState(row.metadata)
    if (state?.phase === 'failed' && state.nextAttemptAt !== null && state.lastError !== null) {
      waiting.push({ nextAttemptAt: state.nextAttemptAt, reason: state.lastError })
    }
  }
  return { newStarts, waiting }
}
