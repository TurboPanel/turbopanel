/**
 * A daily look at every API Token of an account: what zones and rights it still
 * has, and whether the provider still accepts it. A token rolled or removed at
 * the provider is found here instead of when a write fails; a zone added to an
 * "all zones" token shows up; a token that nears its expiry is flagged by
 * `badgeWarnings` from the stored expiry. Each tick looks at a few tokens only.
 */
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { badge, carrier } from '../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { TunnelProviderError } from './errors.ts'
import { createTunnelAdapterRegistry, type TunnelAdapterRegistry } from './registry.ts'
import {
  type BadgeRow,
  CAPABILITY_PROBE_REVISION,
  declaredZonesOf,
  isUsefulReport,
  openBadgeToken,
  recordBadgeCheck,
} from './records.ts'
import { NO_CAPABILITIES, type TunnelProvider } from './vocabulary.ts'

/** Tokens looked at per tick; the rest wait for the next. */
export const BADGE_RECHECKS_PER_TICK = 10
/** How old a check may be before the next one. */
export const BADGE_RECHECK_AFTER_MS = 24 * 60 * 60 * 1000
/** After a failed attempt (the provider down), wait this long before trying the same token again. */
export const BADGE_RETRY_AFTER_MS = 60 * 60 * 1000

export type BadgeRecheckDeps = Readonly<{
  secrets: DerivedSecretsConfig
  registry?: TunnelAdapterRegistry
}>

/** Remember an attempt that could not finish so a provider outage is not hammered every tick. */
async function noteAttempt(db: Db, row: BadgeRow, now: Date): Promise<void> {
  await db
    .update(badge)
    .set({ options: { ...(row.options as object | null), recheckTryAt: now.toISOString() } })
    .where(eq(badge.id, row.id))
}

export async function runBadgeRecheckSweepTick(
  db: Db,
  deps: BadgeRecheckDeps,
  now: Date = new Date()
): Promise<{ checked: number; attention: number }> {
  const registry = deps.registry ?? createTunnelAdapterRegistry()
  const checkedBefore = new Date(now.getTime() - BADGE_RECHECK_AFTER_MS).toISOString()
  const triedBefore = new Date(now.getTime() - BADGE_RETRY_AFTER_MS).toISOString()
  const due = await db
    .select({ badge, carrier })
    .from(badge)
    .innerJoin(carrier, eq(carrier.id, badge.carrierId))
    .where(
      and(
        or(
          isNull(badge.lastCheckedAt),
          lt(badge.lastCheckedAt, checkedBefore),
          // Checked before the check learned to see every kind of right (certificates).
          sql`coalesce((${badge.options} ->> 'capabilityProbe')::int, 0) < ${CAPABILITY_PROBE_REVISION}`
        ),
        sql`coalesce((${badge.options} ->> 'recheckTryAt')::timestamptz < ${triedBefore}::timestamptz, true)`
      )
    )
    .orderBy(sql`${badge.lastCheckedAt} asc nulls first`, asc(badge.id))
    .limit(BADGE_RECHECKS_PER_TICK)
  let checked = 0
  let attention = 0
  await forEachSequential(due, async ({ badge: row, carrier: owner }) => {
    const token = await openBadgeToken(db, deps.secrets, row)
    if (token === null) return
    try {
      const report = await registry(owner.provider as TunnelProvider).checkCredential(token, {
        accountId: owner.externalAccountId,
        declaredZones: declaredZonesOf(row),
      })
      const useful = report.accountVisible && isUsefulReport(report)
      await recordBadgeCheck(db, row, {
        capabilities: report.capabilities,
        status: useful ? 'active' : 'attention',
        token: report.token,
      })
      checked++
      if (!useful) attention++
    } catch (err) {
      if (err instanceof TunnelProviderError && err.code === 'unauthorized') {
        // The provider no longer accepts it: rolled or removed.
        await recordBadgeCheck(db, row, { capabilities: NO_CAPABILITIES, status: 'attention' })
        checked++
        attention++
        return
      }
      // The provider is down or unsure: say nothing about the token, try again later.
      await noteAttempt(db, row, now)
    }
  })
  return { checked, attention }
}
