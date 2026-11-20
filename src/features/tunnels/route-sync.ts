/**
 * Keeping a tunnel's written routes in step with what the panel knows: the
 * names it routes and the names the connector may verify. A tunnel is written
 * again only when either list differs from the last write (`pushTunnelRoutes`
 * with `onlyIfChanged`, under the tunnel's lock). Failures back off per tunnel
 * (a minute, doubling to an hour, or the provider's own wait) so a broken
 * token is not retried on every pass and one tunnel never holds up the rest.
 *
 * Two callers: the periodic pass (`verified-names-sweep.ts`), and the quiet
 * refresh a pin change calls so a name is verified within seconds, not at the
 * next pass.
 */
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tunnel } from '../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { throttleWait } from './origin-certificate-retry.ts'
import { findCarrier } from './records.ts'
import { createTunnelAdapterRegistry, type TunnelAdapterRegistry } from './registry.ts'
import { routeNames } from './lifecycle.ts'
import { pushTunnelRoutes } from './route-push.ts'
import type { TunnelProvider } from './vocabulary.ts'

const RETRY_KEY = 'routesRetry'
const MINUTE_MS = 60_000
const MAX_WAIT_MS = 60 * MINUTE_MS

export type RoutesRetry = { attempts: number; nextTryAt: string | null }

export function readRoutesRetry(metadata: unknown): RoutesRetry {
  const raw = (metadata as Record<string, unknown> | null)?.[RETRY_KEY]
  if (typeof raw !== 'object' || raw === null) return { attempts: 0, nextTryAt: null }
  const r = raw as Record<string, unknown>
  const attempts = typeof r.attempts === 'number' && r.attempts > 0 ? Math.floor(r.attempts) : 0
  const ok = typeof r.nextTryAt === 'string' && !Number.isNaN(Date.parse(r.nextTryAt))
  return { attempts, nextTryAt: ok ? (r.nextTryAt as string) : null }
}

export function nextRoutesRetry(previous: RoutesRetry, err: unknown, now: Date): RoutesRetry {
  const asked = throttleWait(err)
  const attempts = previous.attempts + 1
  const wait =
    asked !== null
      ? Math.max(asked, MINUTE_MS)
      : Math.min(2 ** (attempts - 1) * MINUTE_MS, MAX_WAIT_MS)
  return { attempts, nextTryAt: new Date(now.getTime() + wait).toISOString() }
}

async function saveRetry(db: Db, id: string, retry: RoutesRetry | null): Promise<void> {
  await db
    .update(tunnel)
    .set({
      metadata:
        retry === null
          ? sql`coalesce(${tunnel.metadata}, '{}'::jsonb) - ${RETRY_KEY}::text`
          : sql`jsonb_set(coalesce(${tunnel.metadata}, '{}'::jsonb), ${`{${RETRY_KEY}}`}::text[], ${JSON.stringify(retry)}::jsonb)`,
    })
    .where(eq(tunnel.id, id))
}

export type SyncDeps = Readonly<{
  secrets: DerivedSecretsConfig
  registry?: TunnelAdapterRegistry
}>

export type SyncOutcome = 'pushed' | 'unchanged' | 'waiting' | 'skipped' | 'failed'

/** Write one tunnel's routes if they are stale. Never throws. */
export async function syncTunnelRoutes(
  db: Db,
  deps: SyncDeps,
  row: typeof tunnel.$inferSelect,
  now: Date = new Date(),
  options: { ignoreBackoff?: boolean } = {}
): Promise<SyncOutcome> {
  if (!row.externalId || row.status === 'removing') return 'skipped'
  const retry = readRoutesRetry(row.metadata)
  if (
    !options.ignoreBackoff &&
    retry.nextTryAt !== null &&
    Date.parse(retry.nextTryAt) > now.getTime()
  ) {
    return 'waiting'
  }
  try {
    const owner = row.carrierId ? await findCarrier(db, row.organizationId, row.carrierId) : null
    if (!owner) return 'skipped'
    const registry = deps.registry ?? createTunnelAdapterRegistry()
    const result = await pushTunnelRoutes(
      db,
      { adapter: registry(row.provider as TunnelProvider), secrets: deps.secrets },
      owner,
      row,
      {
        accountId: owner.externalAccountId,
        hostnames: (tx) => routeNames(tx, row.id, null),
        onlyIfChanged: true,
      },
      now
    )
    if (retry.attempts > 0 || retry.nextTryAt !== null) await saveRetry(db, row.id, null)
    return result.pushed ? 'pushed' : 'unchanged'
  } catch (err) {
    try {
      await saveRetry(db, row.id, nextRoutesRetry(retry, err, now))
    } catch {
      // The next pass tries again either way.
    }
    return 'failed'
  }
}

export const ORG_SYNC_BATCH = 20
export const ORG_SYNC_BUDGET_MS = 20_000

/**
 * After a change the routes depend on (a pin, a deploy that applied, a name
 * opened or closed): write the routes of this organization's tunnels that are
 * stale. Quiet and bounded: a failure only means the periodic pass does it
 * after the tunnel's back-off, and a pass stops at the batch or the budget.
 */
export async function syncOrganizationTunnelRoutes(
  db: Db,
  deps: SyncDeps,
  organizationId: string,
  options: { batch?: number; budgetMs?: number; now?: Date } = {}
): Promise<void> {
  const startedAt = Date.now()
  const now = options.now ?? new Date()
  const rows = await db
    .select()
    .from(tunnel)
    .where(
      and(
        eq(tunnel.organizationId, organizationId),
        isNotNull(tunnel.externalId),
        ne(tunnel.status, 'removing')
      )
    )
  let handled = 0
  await forEachSequential(rows, async (row) => {
    if (
      handled >= (options.batch ?? ORG_SYNC_BATCH) ||
      Date.now() - startedAt > (options.budgetMs ?? ORG_SYNC_BUDGET_MS)
    ) {
      return
    }
    const outcome = await syncTunnelRoutes(db, deps, row, now)
    if (outcome === 'pushed' || outcome === 'failed') handled++
  })
}
