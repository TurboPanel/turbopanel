/**
 * What the periodic sweep still does for DNS-validated certificates now that
 * the control plane no longer orders them: remove the challenge records the
 * panel made and still lists, through the DNS provider only. No order is
 * opened, carried on or renewed, no account is made and the certificate
 * authority is never asked anything, on either edition. Certificates already
 * issued stay in the library and keep serving until they expire.
 *
 * Every listed record is a leftover now, open order or not, because no order
 * will ever be answered again. Records are removed by the id the provider
 * gave, never by name. A row whose records could not all be removed is held
 * for an hour (`RETRY_MS`) before it is tried again.
 */
import { and, eq, sql } from 'drizzle-orm'
import { tls } from '../../../db/schema.ts'
import { logWarn } from '../../../lib/logger.ts'
import { forEachSequential } from '../../../lib/sequential.ts'
import { reportSweep } from '../../../lib/sweep-report.ts'
import { CLAIM_MS, type DnsCertContext } from './context.ts'
import { readDnsCertState } from './order-state.ts'
import { cleanRecords, type RecordsContext } from './records.ts'
import { safeTimestamp } from './sql-time.ts'

/** Rows tidied per tick; the rest wait for the next minute. */
export const DNS_CERT_CLEANUP_BATCH = 25
/** A row with a record that would not go is tried again after this long. */
export const RETRY_MS = 3_600_000

export type DnsCertCleanupContext = RecordsContext & Pick<DnsCertContext, 'now'>

export type DnsCertCleanupResult = {
  /** Rows that held records. */
  scanned: number
  /** Records removed. */
  removed: number
  /** Records still listed after this tick. */
  left: number
}

export type DnsCertCleanupOptions = {
  /** Limits a tick to one organization (tests share a database). */
  organizationId?: string
  batch?: number
}

const managed = and(eq(tls.source, 'upload'), sql`${tls.metadata} #>> '{acme,managedBy}' = 'panel'`)
const hasRecords = sql`jsonb_array_length(case when jsonb_typeof(${tls.metadata} #> '{dnsCert,records}') = 'array' then ${tls.metadata} #> '{dnsCert,records}' else '[]'::jsonb end) > 0`
const claimEnds = safeTimestamp(sql`${tls.metadata} #>> '{dnsCert,claimUntil}'`)

/** Takes the row for `CLAIM_MS` unless another worker holds it; null when it is held. */
async function claim(ctx: DnsCertCleanupContext, id: string, now: Date) {
  const until = new Date(now.getTime() + CLAIM_MS).toISOString()
  const [row] = await ctx.db
    .update(tls)
    .set({
      metadata: sql`jsonb_set(${tls.metadata}, '{dnsCert,claimUntil}', to_jsonb(${until}::text))`,
    })
    .where(and(eq(tls.id, id), managed, sql`${claimEnds} < ${now.toISOString()}::timestamptz`))
    .returning()
  return row ?? null
}

/** Writes what is left of the list and holds the row until `holdUntil` (null lets it go). */
async function settle(
  ctx: DnsCertCleanupContext,
  id: string,
  records: unknown[],
  holdUntil: string | null
): Promise<void> {
  const hold = holdUntil === null ? sql`'null'::jsonb` : sql`to_jsonb(${holdUntil}::text)`
  await ctx.db
    .update(tls)
    .set({
      metadata: sql`jsonb_set(jsonb_set(${tls.metadata}, '{dnsCert,records}', ${JSON.stringify(records)}::jsonb), '{dnsCert,claimUntil}', ${hold})`,
    })
    .where(eq(tls.id, id))
}

/** Removes the listed records of one row; returns how many went and how many are left. */
async function cleanRow(
  ctx: DnsCertCleanupContext,
  id: string,
  now: Date
): Promise<{ removed: number; left: number }> {
  const row = await claim(ctx, id, now)
  if (!row) return { removed: 0, left: 0 }
  const state = readDnsCertState(row.metadata)
  if (!state) {
    await settle(ctx, id, [], null)
    return { removed: 0, left: 0 }
  }
  const cleaned = await cleanRecords(ctx, row, state)
  const left = cleaned.records.length
  const holdUntil = left > 0 ? new Date(now.getTime() + RETRY_MS).toISOString() : null
  await settle(ctx, id, cleaned.records, holdUntil)
  return { removed: state.records.length - left, left }
}

export async function runDnsCertificateCleanupTick(
  ctx: DnsCertCleanupContext,
  options: DnsCertCleanupOptions = {}
): Promise<DnsCertCleanupResult> {
  const now = ctx.now ? ctx.now() : new Date()
  const picked = await ctx.db
    .select({ id: tls.id })
    .from(tls)
    .where(
      and(
        managed,
        hasRecords,
        sql`${claimEnds} < ${now.toISOString()}::timestamptz`,
        ...(options.organizationId ? [eq(tls.organizationId, options.organizationId)] : [])
      )
    )
    .orderBy(tls.updatedAt)
    .limit(options.batch ?? DNS_CERT_CLEANUP_BATCH)
  const out: DnsCertCleanupResult = { scanned: picked.length, removed: 0, left: 0 }
  let stuck = 0
  await forEachSequential(picked, async ({ id }) => {
    try {
      const done = await cleanRow(ctx, id, now)
      out.removed += done.removed
      out.left += done.left
      if (done.left > 0) stuck += 1
    } catch (err) {
      stuck += 1
      logWarn('tls', `dns certificate record cleanup failed for ${id}: ${String(err)}`)
    }
  })
  reportSweep(
    'tls',
    'dns certificate record cleanup',
    { removed: out.removed, left: out.left },
    { tried: out.scanned, failed: stuck }
  )
  return out
}
