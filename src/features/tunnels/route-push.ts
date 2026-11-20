/**
 * Writing a tunnel's routes to the provider. Every write carries the set of
 * names the connector may verify (`loadVerifiedNames`) and remembers it, with
 * the names it wrote, on the tunnel (`metadata.routes`), so a later pass can
 * tell when a deploy, a certificate change or a lost route made the provider's
 * set stale and write it again (`route-sync.ts`).
 *
 * One writer per tunnel at a time: the whole read (names, verified names), the
 * provider call and the metadata write run inside a transaction that holds the
 * tunnel's row `for update`. A name added while another writer was reading is
 * therefore either in that writer's read or written by the next one; the
 * background pass can never push an older name list over a newer one.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tunnel } from '../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { TunnelAdapter } from './adapter.ts'
import { useBadges } from './badge-use.ts'
import type { TunnelRow } from './lifecycle.ts'
import { loadVerifiedNames } from './verified-names.ts'

export type RoutedSet = { verifiedNames: string[]; hostnames: string[] | null }

function textList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : null
}

/** What the last write sent: the verified names and (null when never recorded) every routed name. */
export function readRouted(metadata: unknown): RoutedSet {
  const routes = (metadata as { routes?: Record<string, unknown> } | null)?.routes
  return {
    verifiedNames: textList(routes?.verifiedNames) ?? [],
    hostnames: textList(routes?.hostnames),
  }
}

export function readRoutedVerified(metadata: unknown): string[] {
  return readRouted(metadata).verifiedNames
}

export function sameList(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((n, i) => n === b[i])
}

export type PushInput = {
  accountId: string | null
  /** Every name to route, read inside the lock so it is never older than the write. */
  hostnames: (db: Db) => Promise<string[]>
  /** Write only when the names or the verified names differ from the last write. */
  onlyIfChanged?: boolean
}

export type PushResult = { pushed: boolean; verifiedNames: string[] }

/** Write the full route set of a tunnel with its verified names. */
export async function pushTunnelRoutes(
  db: Db,
  deps: { adapter: TunnelAdapter; secrets: DerivedSecretsConfig },
  owner: { id: string },
  row: Pick<TunnelRow, 'id' | 'externalId'>,
  input: PushInput,
  now: Date = new Date()
): Promise<PushResult> {
  return await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: tunnel.metadata })
      .from(tunnel)
      .where(eq(tunnel.id, row.id))
      .for('update')
    if (!locked) return { pushed: false, verifiedNames: [] }
    const hostnames = (await input.hostnames(tx as unknown as Db)).map((n) => n.toLowerCase())
    const wanted = new Set(hostnames)
    const verifiedNames = (await loadVerifiedNames(tx as unknown as Db, row.id, now)).filter((n) =>
      wanted.has(n)
    )
    if (input.onlyIfChanged) {
      const last = readRouted(locked.metadata)
      if (sameList(last.hostnames, hostnames) && sameList(last.verifiedNames, verifiedNames)) {
        return { pushed: false, verifiedNames }
      }
    }
    await useBadges(db, deps.secrets, owner.id, { capability: 'tunnels' }, (token) =>
      deps.adapter.setRoutes(token, {
        accountId: input.accountId,
        externalId: row.externalId!,
        hostnames,
        verifiedNames,
      })
    )
    await tx
      .update(tunnel)
      .set({
        metadata: sql`jsonb_set(coalesce(${tunnel.metadata}, '{}'::jsonb), '{routes}', ${JSON.stringify({ verifiedNames, hostnames })}::jsonb)`,
      })
      .where(eq(tunnel.id, row.id))
    return { pushed: true, verifiedNames }
  })
}
