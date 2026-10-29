/**
 * The periodic part of DNS-validated certificates. A tick, in a bounded number
 * of rows: tidies each certificate between orders (leftover records removed by
 * id, the renewal time kept in step with the authority's advice, a renewal
 * that cannot work flagged on the certificate), then gives the next step to
 * every certificate with an order open, a first certificate waiting out a
 * back-off, or a renewal that has come due. One failing row never stops the
 * others.
 */
import { and, eq, sql } from 'drizzle-orm'
import { tls } from '../../../db/schema.ts'
import { logWarn } from '../../../lib/logger.ts'
import { forEachSequential } from '../../../lib/sequential.ts'
import { reportSweep } from '../../../lib/sweep-report.ts'
import { emptyThrottleCounters, type ThrottleCounters } from '../../../lib/throttle-counters.ts'
import { parseTlsOptions } from '../../../lib/tls/match.ts'
import { pausedAccounts } from './account.ts'
import { clock, type DnsCertContext } from './context.ts'
import { selectDueSteps, selectDueUpkeep } from './sweep-select.ts'
import {
  type AdvanceOutcome,
  advanceDnsCertificate,
  maintainDnsCertificate,
  renewAtOf,
} from './issuance.ts'
import { readDnsCertState } from './order-state.ts'

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
  /** 429 and 503 answers met this tick, by who sent them. */
  throttled: ThrottleCounters
}

type Row = typeof tls.$inferSelect

function wantsStep(row: Row, now: number): boolean {
  const state = readDnsCertState(row.metadata)
  if (!state || row.status === 'failed') return false
  if (row.status === 'pending' || state.order) return true
  return parseTlsOptions(row.options)?.autoRenew !== false && renewAtOf(row) <= now
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

/** Certificates stepped per tick (the default of `options.batch`); the rest wait for the next one. */
export const DNS_CERT_SWEEP_BATCH = 25
/** Certificates tidied per tick (the default of `options.maintainBatch`). */
export const DNS_CERT_MAINTAIN_BATCH = 25
/**
 * Wall-clock time after which a tick starts no new certificate (the default of
 * `options.budgetMs`). Each step makes a few requests, so batch times the
 * calls per step also keeps a Workers invocation inside its subrequest limit;
 * a tick that runs out of time leaves the rest due for the next minute.
 */
export const DNS_CERT_SWEEP_BUDGET_MS = 20_000
/** Candidates read per slot, so the renewal limits can drop some and the batch still fills. */
const CANDIDATE_FACTOR = 3

export type DnsCertSweepOptions = {
  /** Limits a tick to one organization (tests share a database). */
  organizationId?: string
  renewalLimits?: Partial<RenewalLimits>
  batch?: number
  maintainBatch?: number
  budgetMs?: number
}

/** Runs `work` over the rows until the budget is spent; the remaining rows are simply not started. */
async function withinBudget(
  rows: readonly Row[],
  startedAt: number,
  budgetMs: number,
  work: (row: Row) => Promise<void>
): Promise<void> {
  await forEachSequential(rows, async (row) => {
    if (Date.now() - startedAt <= budgetMs) await work(row)
  })
}

export async function runDnsCertificateSweepTick(
  base: DnsCertContext,
  options: DnsCertSweepOptions = {}
): Promise<DnsCertSweepResult> {
  const throttled = emptyThrottleCounters()
  const ctx: DnsCertContext = { ...base, counters: throttled }
  const startedAt = Date.now()
  const now = clock(ctx)
  const budgetMs = options.budgetMs ?? DNS_CERT_SWEEP_BUDGET_MS
  const batch = options.batch ?? DNS_CERT_SWEEP_BATCH
  const paused = await pausedAccounts(ctx, now)
  const scope = { organizationId: options.organizationId, paused }
  const upkeep = await selectDueUpkeep(
    ctx.db,
    now,
    options.maintainBatch ?? DNS_CERT_MAINTAIN_BATCH,
    scope
  )
  let maintained = 0
  await withinBudget(upkeep, startedAt, budgetMs, async (row) => {
    try {
      await maintainDnsCertificate(ctx, row.id)
      maintained += 1
    } catch (err) {
      logWarn('tls', `dns certificate upkeep failed for ${row.id}: ${String(err)}`)
    }
  })
  // Upkeep may have moved a renewal time, so the steps are chosen after it.
  const candidates = await selectDueSteps(ctx.db, now, batch * CANDIDATE_FACTOR, scope)
  const limits: RenewalLimits = {
    startsPerTick: RENEWAL_STARTS_PER_ORG_PER_TICK,
    openPerOrg: RENEWALS_OPEN_PER_ORG,
    ...options.renewalLimits,
  }
  const open = await openRenewals(ctx, options.organizationId)
  const due = limitRenewalStarts(
    candidates.filter((row) => wantsStep(row, now.getTime())),
    open,
    limits
  ).slice(0, batch)
  const out: DnsCertSweepResult = {
    scanned: candidates.length + upkeep.length,
    advanced: 0,
    maintained,
    issued: 0,
    failed: 0,
    waiting: 0,
    throttled,
  }
  await withinBudget(due, startedAt, budgetMs, async (row) => {
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
    {
      advanced: out.advanced,
      issued: out.issued,
      failed: out.failed,
      waiting: out.waiting,
      ...throttled,
    },
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
