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
import { parseTlsOptions } from '../../../lib/tls/match.ts'
import { clock, type DnsCertContext } from './context.ts'
import { advanceDnsCertificate, maintainDnsCertificate, renewAtOf } from './issuance.ts'
import { readDnsCertState } from './order-state.ts'

/** Certificates stepped per tick; the rest wait for the next one. */
export const DNS_CERT_SWEEP_BATCH = 10
/** Certificates tidied per tick. */
export const DNS_CERT_MAINTAIN_BATCH = 25
const SCAN_LIMIT = 200

export type DnsCertSweepResult = { scanned: number; advanced: number; maintained: number }

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

/** `organizationId` limits a tick to one organization (tests share a database). */
export async function runDnsCertificateSweepTick(
  ctx: DnsCertContext,
  options: { organizationId?: string } = {}
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
  const due = fresh.filter((row) => wantsStep(row, now)).slice(0, DNS_CERT_SWEEP_BATCH)
  let advanced = 0
  await forEachSequential(due, async (row) => {
    try {
      if ((await advanceDnsCertificate(ctx, row.id)) !== 'busy') advanced += 1
    } catch (err) {
      logWarn('tls', `dns certificate sweep failed for ${row.id}: ${String(err)}`)
    }
  })
  return { scanned: rows.length, advanced, maintained }
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
