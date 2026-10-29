/**
 * Which DNS-validated certificates a sweep tick looks at, chosen in the
 * database by when they are due rather than by how long ago they were last
 * written. No column and no index is needed: the due time is read out of the
 * private state (`metadata.dnsCert`) and the scan is limited to the managed
 * rows. Ranking within each organization and taking rank by rank lets every
 * organization advance before any organization advances twice, so a large
 * organization cannot starve the others.
 */
import { and, asc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import { tls } from '../../../db/schema.ts'

type Row = typeof tls.$inferSelect

const EPOCH = sql`'epoch'::timestamptz`
const stamp = (path: string) =>
  sql`coalesce((${tls.metadata} #>> ${path}::text[])::timestamptz, ${EPOCH})`
const orderOpen = sql`jsonb_typeof(${tls.metadata} #> '{dnsCert,order}') = 'object'`

/** When a row's next step is due: its back-off, and for an idle certificate also its renewal time. */
const stepDueAt = sql`case when ${tls.status} = 'pending' or ${orderOpen}
  then ${stamp('{dnsCert,nextAttemptAt}')}
  else greatest(${stamp('{dnsCert,nextAttemptAt}')}, ${stamp('{dnsCert,renewAt}')}) end`

/** When upkeep is next due: the renewal-information check. */
const tidyDueAt = stamp('{dnsCert,ariNextCheckAt}')

const managed = and(eq(tls.source, 'upload'), sql`${tls.metadata} #>> '{acme,managedBy}' = 'panel'`)
const notClaimed = (now: Date) =>
  sql`${stamp('{dnsCert,claimUntil}')} < ${now.toISOString()}::timestamptz`

type Scope = { organizationId?: string; pausedOrganizations?: readonly string[] }

function scoped(scope: Scope): SQL[] {
  return [
    ...(scope.organizationId ? [eq(tls.organizationId, scope.organizationId)] : []),
    ...(scope.pausedOrganizations?.length
      ? [notInArray(tls.organizationId, [...scope.pausedOrganizations])]
      : []),
  ]
}

/** Rank each organization's candidates by due time, take rank 1 of every organization first, then rank 2, and so on. */
async function pickFairly(
  db: Db,
  where: SQL | undefined,
  dueAt: SQL,
  limit: number
): Promise<Row[]> {
  if (limit <= 0) return []
  const ranked = db
    .select({
      id: tls.id,
      due: sql<Date>`${dueAt}`.as('due'),
      rank: sql<number>`row_number() over (partition by ${tls.organizationId} order by ${dueAt})`.as(
        'rank'
      ),
    })
    .from(tls)
    .where(where)
    .as('ranked')
  const picked = await db
    .select({ id: ranked.id })
    .from(ranked)
    .orderBy(asc(ranked.rank), asc(ranked.due))
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
    limit
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
