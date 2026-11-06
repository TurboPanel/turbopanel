/**
 * Which DNS-validated certificates a sweep tick looks at, chosen in the
 * database by when they are due rather than by how long ago they were last
 * written. No column and no index is needed: the due time is read out of the
 * private state (`metadata.dnsCert`) and the scan is limited to the managed
 * rows, and an unreadable time counts as due instead of failing the query.
 * Work already begun (open orders, first certificates) ranks ahead of renewals
 * that would begin now. Ranking within each organization and taking rank by rank lets every
 * organization advance before any organization advances twice, so a large
 * organization cannot starve the others.
 */
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import { tls } from '../../../db/schema.ts'
import { type PausedAccount, safeTimestamp } from './account.ts'

type Row = typeof tls.$inferSelect

/** A time out of the private state; a missing or unreadable value counts as the epoch (due). */
const stamp = (path: string) => safeTimestamp(sql`${tls.metadata} #>> ${path}::text[]`)
const hasStamp = (path: string) =>
  sql`coalesce(pg_input_is_valid(${tls.metadata} #>> ${path}::text[], 'timestamptz'), false)`
const orderOpen = sql`jsonb_typeof(${tls.metadata} #> '{dnsCert,order}') = 'object'`
/** An order is open or a first certificate is waiting: work already begun, which always goes first. */
const inFlight = sql`(${tls.status} = 'pending' or ${orderOpen})`

/**
 * When an idle certificate is due to renew, as `renewAtOf` reads it: the stored
 * time, or a third of the lifetime before the end, or (with neither) now.
 */
const renewDueAt = sql`case
  when ${hasStamp('{dnsCert,renewAt}')} then ${stamp('{dnsCert,renewAt}')}
  when ${hasStamp('{notBefore}')} and ${tls.notAfter} is not null
    then ${tls.notAfter} - (${tls.notAfter} - ${stamp('{notBefore}')}) / 3
  else 'epoch'::timestamptz end`

/** When a row's next step is due: its back-off, and for an idle certificate also its renewal time. */
const stepDueAt = sql`case when ${inFlight}
  then ${stamp('{dnsCert,nextAttemptAt}')}
  else greatest(${stamp('{dnsCert,nextAttemptAt}')}, ${renewDueAt}) end`

/** Work already begun ranks ahead of renewals that would begin now (0 before 1). */
const stepKind = sql`case when ${inFlight} then 0 else 1 end`

/** When upkeep is next due: the renewal-information check. */
const tidyDueAt = stamp('{dnsCert,ariNextCheckAt}')

const managed = and(eq(tls.source, 'upload'), sql`${tls.metadata} #>> '{acme,managedBy}' = 'panel'`)
const notClaimed = (now: Date) =>
  sql`${stamp('{dnsCert,claimUntil}')} < ${now.toISOString()}::timestamptz`

type Scope = { organizationId?: string; paused?: readonly PausedAccount[] }

/** Rows of a paused account (one organization with one directory) are left out; its other directory is not. */
function notPaused(account: PausedAccount): SQL {
  const staging = account.staging ? 'true' : 'false'
  return sql`not (${tls.organizationId} = ${account.organizationId} and coalesce(${tls.metadata} #>> '{dnsCert,staging}', 'false') = ${staging})`
}

function scoped(scope: Scope): SQL[] {
  return [
    ...(scope.organizationId ? [eq(tls.organizationId, scope.organizationId)] : []),
    ...(scope.paused ?? []).map(notPaused),
  ]
}

/**
 * Rank each organization's candidates (by `kind`, then due time), take rank 1
 * of every organization first, then rank 2, and so on. Every row of kind 0
 * comes before any of kind 1, so work already begun is never crowded out by
 * renewals that the per-organization limits would hold back anyway.
 */
async function pickFairly(
  db: Db,
  where: SQL | undefined,
  dueAt: SQL,
  limit: number,
  kind: SQL = sql`0`
): Promise<Row[]> {
  if (limit <= 0) return []
  const ranked = db
    .select({
      id: tls.id,
      kind: sql<number>`${kind}`.as('kind'),
      due: sql<Date>`${dueAt}`.as('due'),
      rank: sql<number>`row_number() over (partition by ${tls.organizationId} order by ${kind}, ${dueAt})`.as(
        'rank'
      ),
    })
    .from(tls)
    .where(where)
    .as('ranked')
  const picked = await db
    .select({ id: ranked.id })
    .from(ranked)
    .orderBy(asc(ranked.kind), asc(ranked.rank), asc(ranked.due))
    .limit(limit)
  if (picked.length === 0) return []
  const rows = await db
    .select()
    .from(tls)
    .where(
      inArray(
        tls.id,
        picked.map((p) => p.id)
      )
    )
  const order = new Map(picked.map((p, i) => [p.id, i]))
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
}

/** Certificates whose next step is due now (an open order, a back-off that ended, a renewal time that came), fairly across organizations. */
export function selectDueSteps(db: Db, now: Date, limit: number, scope: Scope = {}) {
  const iso = now.toISOString()
  return pickFairly(
    db,
    and(
      managed,
      inArray(tls.status, ['pending', 'ready']),
      notClaimed(now),
      scoped(scope).length ? and(...scoped(scope)) : undefined,
      sql`${stepDueAt} <= ${iso}::timestamptz`,
      // A certificate set not to renew by itself is only stepped while an order is open.
      sql`(${tls.status} = 'pending' or ${orderOpen} or coalesce(${tls.options} ->> 'autoRenew', 'true') <> 'false')`
    ),
    stepDueAt,
    limit,
    stepKind
  )
}

/** Certificates that need upkeep: a renewal-information check that came due, or leftover records with no order open. */
export function selectDueUpkeep(db: Db, now: Date, limit: number, scope: Scope = {}) {
  return pickFairly(
    db,
    and(
      managed,
      inArray(tls.status, ['pending', 'ready', 'failed']),
      notClaimed(now),
      scoped(scope).length ? and(...scoped(scope)) : undefined,
      sql`(
        (${tls.status} = 'ready' and not ${orderOpen} and ${tidyDueAt} <= ${now.toISOString()}::timestamptz)
        or (not ${orderOpen} and jsonb_array_length(coalesce(${tls.metadata} #> '{dnsCert,records}', '[]'::jsonb)) > 0)
      )`
    ),
    tidyDueAt,
    limit
  )
}
