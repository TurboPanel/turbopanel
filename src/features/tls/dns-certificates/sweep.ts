/**
 * The periodic part of DNS-validated certificates. A tick, in a bounded number
 * of rows: tidies each certificate between orders (leftover records removed by
 * id, the renewal time kept in step with the authority's advice, a renewal
 * that cannot work flagged on the certificate), then gives the next step to
 * every certificate with an order open, a first certificate waiting out a
 * back-off, or a renewal that has come due. One failing row never stops the
 * others.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { tls } from '../../../db/schema.ts'
import { logWarn } from '../../../lib/logger.ts'
import { forEachSequential } from '../../../lib/sequential.ts'
import { reportSweep } from '../../../lib/sweep-report.ts'
import { parseTlsOptions } from '../../../lib/tls/match.ts'
import { clock, type DnsCertContext } from './context.ts'
import {
  type AdvanceOutcome,
  advanceDnsCertificate,
  maintainDnsCertificate,
  renewAtOf,
} from './issuance.ts'
import { readDnsCertState } from './order-state.ts'

/** Certificates stepped per tick; the rest wait for the next one. */
export const DNS_CERT_SWEEP_BATCH = 10
/** Certificates tidied per tick. */
export const DNS_CERT_MAINTAIN_BATCH = 25
const SCAN_LIMIT = 200

/**
 * How many renewals one organization may begin in one tick, and how many may
 * be open at once. A mass event (a bulk issue, a restore, an authority asking
 * for early renewal) makes many certificates due together; this keeps one
 * organization from starting them all at once. Orders already open and first
 * certificates are not limited here.
 */
export const RENEWAL_STARTS_PER_ORG_PER_TICK = 2
export const RENEWALS_OPEN_PER_ORG = 5

export type RenewalLimits = { startsPerTick: number; openPerOrg: number }

export type DnsCertSweepResult = {
  scanned: number
  advanced: number
  maintained: number
  /** What the steps came to this tick. */
  issued: number
  failed: number
  /** Orders held back by a back-off or an organization pause. */
  waiting: number
}

type Row = typeof tls.$inferSelect

function wantsStep(row: Row, now: number): boolean {
  const state = readDnsCertState(row.metadata)
  if (!state || row.status === 'failed') return false
  if (row.status === 'pending' || state.order) return true
  return parseTlsOptions(row.options)?.autoRenew !== false && renewAtOf(row) <= now
}

function wantsTidying(row: Row): boolean {
  const state = readDnsCertState(row.metadata)
  if (!state) return false
  return row.status === 'ready' || state.records.length > 0
}

/** Does stepping this row begin a renewal (a certificate in use with no order open)? */
function beginsRenewal(row: Row): boolean {
  const state = readDnsCertState(row.metadata)
  return row.status === 'ready' && state !== null && state.order === null
}

/**
 * Keep the rows whose step may go ahead: every row except renewals beyond the
 * organization's limits, in the order given. `open` counts the renewals each
 * organization already has under way.
 */
export function limitRenewalStarts(
  rows: readonly Row[],
  open: ReadonlyMap<string, number>,
  limits: RenewalLimits
): Row[] {
  const started = new Map<string, number>()
  return rows.filter((row) => {
    if (!beginsRenewal(row)) return true
    const begun = started.get(row.organizationId) ?? 0
    const underway = (open.get(row.organizationId) ?? 0) + begun
    if (begun >= limits.startsPerTick || underway >= limits.openPerOrg) return false
    started.set(row.organizationId, begun + 1)
    return true
  })
}

/** Renewals under way now (a certificate in use with an order open), per organization. */
async function openRenewals(ctx: DnsCertContext, organizationId?: string) {
  const counted = await ctx.db
    .select({ organizationId: tls.organizationId, open: sql<number>`count(*)::int` })
    .from(tls)
    .where(
      and(
        eq(tls.source, 'upload'),
        eq(tls.status, 'ready'),
        sql`${tls.metadata} #>> '{acme,managedBy}' = 'panel'`,
        sql`jsonb_typeof(${tls.metadata} #> '{dnsCert,order}') = 'object'`,
        ...(organizationId ? [eq(tls.organizationId, organizationId)] : [])
      )
    )
    .groupBy(tls.organizationId)
  return new Map(counted.map((c) => [c.organizationId, c.open]))
}

/** `organizationId` limits a tick to one organization (tests share a database). */
export async function runDnsCertificateSweepTick(
  ctx: DnsCertContext,
  options: { organizationId?: string; renewalLimits?: Partial<RenewalLimits> } = {}
): Promise<DnsCertSweepResult> {
  const now = clock(ctx).getTime()
  const rows = await ctx.db
    .select()
    .from(tls)
    .where(
      and(
        eq(tls.source, 'upload'),
        sql`${tls.metadata} #>> '{acme,managedBy}' = 'panel'`,
        inArray(tls.status, ['pending', 'ready', 'failed']),
        ...(options.organizationId ? [eq(tls.organizationId, options.organizationId)] : [])
      )
    )
    .orderBy(asc(tls.updatedAt))
    .limit(SCAN_LIMIT)
  let maintained = 0
  await forEachSequential(
    rows.filter(wantsTidying).slice(0, DNS_CERT_MAINTAIN_BATCH),
    async (row) => {
      try {
        await maintainDnsCertificate(ctx, row.id)
        maintained += 1
      } catch (err) {
        logWarn('tls', `dns certificate upkeep failed for ${row.id}: ${String(err)}`)
      }
    }
  )
  // Upkeep may have moved a renewal time, so look at the rows again.
  const fresh = maintained === 0 ? rows : await reload(ctx, rows)
  const limits: RenewalLimits = {
    startsPerTick: RENEWAL_STARTS_PER_ORG_PER_TICK,
    openPerOrg: RENEWALS_OPEN_PER_ORG,
    ...options.renewalLimits,
  }
  const wanted = fresh.filter((row) => wantsStep(row, now))
  const open = await openRenewals(ctx, options.organizationId)
  const due = limitRenewalStarts(wanted, open, limits).slice(0, DNS_CERT_SWEEP_BATCH)
  const out: DnsCertSweepResult = {
    scanned: rows.length,
    advanced: 0,
    maintained,
    issued: 0,
    failed: 0,
    waiting: 0,
  }
  await forEachSequential(due, async (row) => {
    try {
      tally(out, await advanceDnsCertificate(ctx, row.id))
    } catch (err) {
      out.failed += 1
      logWarn('tls', `dns certificate sweep failed for ${row.id}: ${String(err)}`)
    }
  })
  reportSweep(
    'tls',
    'dns certificate sweep',
    { advanced: out.advanced, issued: out.issued, failed: out.failed, waiting: out.waiting },
    { tried: out.advanced + out.failed, failed: out.failed }
  )
  return out
}

function tally(out: DnsCertSweepResult, outcome: AdvanceOutcome): void {
  if (outcome === 'busy') return
  if (outcome === 'backoff') out.waiting += 1
  else out.advanced += 1
  if (outcome === 'issued') out.issued += 1
  if (outcome === 'failed') out.failed += 1
}

async function reload(ctx: DnsCertContext, rows: readonly Row[]): Promise<Row[]> {
  if (rows.length === 0) return []
  return await ctx.db
    .select()
    .from(tls)
    .where(
      inArray(
        tls.id,
        rows.map((r) => r.id)
      )
    )
}
