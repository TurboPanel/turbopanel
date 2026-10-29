/**
 * Finishes removing tunnels. A tunnel that had a connector running is marked
 * `removing` first, so its servers are told to stop; the provider only lets go
 * of a tunnel with no connected connector, so the delete is tried here, from
 * the periodic sweep, after a growing wait between tries (`finishTunnelRemoval`).
 */
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tunnel } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { TunnelProvider } from './vocabulary.ts'
import { finishTunnelRemoval } from './lifecycle.ts'
import { findCarrier } from './records.ts'
import { createTunnelAdapterRegistry, type TunnelAdapterRegistry } from './registry.ts'

/** Tunnels tried in one tick; the rest wait for the next. */
export const TUNNEL_REMOVALS_PER_TICK = 25

export type TunnelRemovalDeps = Readonly<{
  secrets: DerivedSecretsConfig
  registry?: TunnelAdapterRegistry
}>

export async function runTunnelRemovalSweepTick(
  db: Db,
  deps: TunnelRemovalDeps,
  now: Date = new Date()
): Promise<{ removed: number; waiting: number }> {
  const registry = deps.registry ?? createTunnelAdapterRegistry()
  const rows = await db
    .select()
    .from(tunnel)
    .where(
      and(
        eq(tunnel.status, 'removing'),
        // Only the ones whose wait is over, so a crowd of waiting tunnels cannot starve a due one.
        sql`coalesce((${tunnel.metadata} #>> '{removal,nextAt}')::timestamptz <= ${now.toISOString()}::timestamptz, true)`
      )
    )
    .orderBy(asc(tunnel.updatedAt))
    .limit(TUNNEL_REMOVALS_PER_TICK)
  let removed = 0
  let waiting = 0
  await forEachSequential(rows, async (row) => {
    const owner = row.carrierId ? await findCarrier(db, row.organizationId, row.carrierId) : null
    const outcome = await finishTunnelRemoval(
      db,
      { adapter: registry(row.provider as TunnelProvider), secrets: deps.secrets },
      row,
      owner,
      now
    )
    if (outcome === 'removed') removed++
    else waiting++
  })
  return { removed, waiting }
}
