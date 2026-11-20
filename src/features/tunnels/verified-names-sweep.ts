/**
 * The periodic pass over verified names: a tunnel whose set of verifiable names
 * changed since its routes were last written (a deploy carried a certificate,
 * a pin or a pair changed, a name was removed) gets its routes written again.
 * A tunnel with nothing new is not touched.
 */
import { and, isNotNull, ne } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tunnel } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { routeNames } from './lifecycle.ts'
import { findCarrier } from './records.ts'
import { createTunnelAdapterRegistry, type TunnelAdapterRegistry } from './registry.ts'
import { pushTunnelRoutes, readRoutedVerified } from './route-push.ts'
import { loadVerifiedNames } from './verified-names.ts'
import type { TunnelProvider } from './vocabulary.ts'

export type VerifiedNamesDeps = Readonly<{
  secrets: DerivedSecretsConfig
  registry?: TunnelAdapterRegistry
}>

/** One failing tunnel never stops the others; the next pass tries it again. */
export async function runVerifiedNamesSweepTick(
  db: Db,
  deps: VerifiedNamesDeps,
  now: Date = new Date()
): Promise<{ pushed: number; failed: number }> {
  const registry = deps.registry ?? createTunnelAdapterRegistry()
  const rows = await db
    .select()
    .from(tunnel)
    .where(and(isNotNull(tunnel.externalId), ne(tunnel.status, 'removing')))
  let pushed = 0
  let failed = 0
  await forEachSequential(rows, async (row) => {
    try {
      const owner = row.carrierId ? await findCarrier(db, row.organizationId, row.carrierId) : null
      if (!owner) return
      const hostnames = await routeNames(db, row.id, null)
      const routed = new Set(hostnames.map((n) => n.toLowerCase()))
      const verified = (await loadVerifiedNames(db, row.id, now)).filter((n) => routed.has(n))
      const was = readRoutedVerified(row.metadata)
      if (verified.length === was.length && verified.every((n, i) => n === was[i])) return
      await pushTunnelRoutes(
        db,
        { adapter: registry(row.provider as TunnelProvider), secrets: deps.secrets },
        owner,
        row,
        { accountId: owner.externalAccountId, hostnames }
      )
      pushed++
    } catch {
      failed++
    }
  })
  return { pushed, failed }
}
