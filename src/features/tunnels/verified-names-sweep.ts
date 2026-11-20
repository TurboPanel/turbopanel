/**
 * The periodic pass over tunnel routes: a tunnel whose routed names or
 * verifiable names changed since its routes were last written (a deploy carried
 * a certificate, a pin or a pair changed, a name was removed, a write was lost)
 * gets its routes written again. A tunnel with nothing new is not touched.
 *
 * Bounded like the origin certificate pass: at most `TUNNEL_SYNC_BATCH`
 * tunnels per tick, in a minute-rotated order so every tunnel is reached, and
 * no new tunnel starts after `TUNNEL_SYNC_BUDGET_MS`.
 */
import { and, isNotNull, ne } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tunnel } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { turnOrder } from './origin-certificate-sweep.ts'
import { syncTunnelRoutes, type SyncDeps } from './route-sync.ts'

export const TUNNEL_SYNC_BATCH = 50
export const TUNNEL_SYNC_BUDGET_MS = 20_000

export type VerifiedNamesDeps = SyncDeps & { batch?: number; budgetMs?: number }

export async function runVerifiedNamesSweepTick(
  db: Db,
  deps: VerifiedNamesDeps,
  now: Date = new Date()
): Promise<{ pushed: number; failed: number }> {
  const startedAt = Date.now()
  const rows = await db
    .select()
    .from(tunnel)
    .where(and(isNotNull(tunnel.externalId), ne(tunnel.status, 'removing')))
  let pushed = 0
  let failed = 0
  let handled = 0
  const batch = deps.batch ?? TUNNEL_SYNC_BATCH
  await forEachSequential(turnOrder(rows, now), async (row) => {
    if (handled >= batch || Date.now() - startedAt > (deps.budgetMs ?? TUNNEL_SYNC_BUDGET_MS)) {
      return
    }
    const outcome = await syncTunnelRoutes(db, deps, row, now)
    // Tunnels waiting out a failure or needing nothing cost no provider call, so only real attempts count.
    if (outcome === 'pushed' || outcome === 'failed') handled++
    if (outcome === 'pushed') pushed++
    if (outcome === 'failed') failed++
  })
  return { pushed, failed }
}
