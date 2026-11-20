/**
 * Writing a tunnel's routes to the provider. Every write carries the set of
 * names the connector may verify (`loadVerifiedNames`) and remembers it on the
 * tunnel (`metadata.routes.verifiedNames`), so the periodic pass can tell when
 * a deploy or a certificate change made a name verifiable (or no longer) and
 * write the routes again (`verified-names-sweep.ts`).
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tunnel } from '../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { TunnelAdapter } from './adapter.ts'
import { useBadges } from './badge-use.ts'
import type { TunnelRow } from './lifecycle.ts'
import { loadVerifiedNames } from './verified-names.ts'

export function readRoutedVerified(metadata: unknown): string[] {
  const names = (metadata as { routes?: { verifiedNames?: unknown } } | null)?.routes?.verifiedNames
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
}

/** Write the full route set of a tunnel with its verified names; returns the names that verify. */
export async function pushTunnelRoutes(
  db: Db,
  deps: { adapter: TunnelAdapter; secrets: DerivedSecretsConfig },
  owner: { id: string },
  row: Pick<TunnelRow, 'id' | 'externalId'>,
  input: { accountId: string | null; hostnames: readonly string[] }
): Promise<string[]> {
  const wanted = new Set(input.hostnames.map((n) => n.toLowerCase()))
  const verifiedNames = (await loadVerifiedNames(db, row.id)).filter((n) => wanted.has(n))
  await useBadges(db, deps.secrets, owner.id, { capability: 'tunnels' }, (token) =>
    deps.adapter.setRoutes(token, {
      accountId: input.accountId,
      externalId: row.externalId!,
      hostnames: input.hostnames,
      verifiedNames,
    })
  )
  await db
    .update(tunnel)
    .set({
      metadata: sql`jsonb_set(coalesce(${tunnel.metadata}, '{}'::jsonb), '{routes}', ${JSON.stringify({ verifiedNames })}::jsonb)`,
    })
    .where(eq(tunnel.id, row.id))
  return verifiedNames
}
