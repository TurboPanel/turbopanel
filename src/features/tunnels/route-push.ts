/**
 * Writing a tunnel's routes to the provider. Every write carries the set of
 * names the connector may verify (`loadVerifiedNames`) and remembers it, with
 * the names it wrote, on the tunnel (`metadata.routes`), so a later pass can
 * tell when a deploy, a certificate change or a lost route made the provider's
 * set stale and write it again (`route-sync.ts`).
 *
 * No lock or transaction is held across the provider call (a Worker has one
 * connection per request, and a row lock would wait on a slow HTTP call). The
 * names are read and the provider is called first; the metadata is then written
 * in a short transaction that is a compare-and-set: it holds the tunnel's row
 * `for update`, reads the names again and writes only when the stored routes
 * are what this writer started from and the names are still the ones pushed.
 * Otherwise another writer got in between, and this one reads and pushes again
 * (a few times at most), so an older name list is never left as the record.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { tunnel } from '../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { TunnelAdapter } from './adapter.ts'
import { useBadges } from './badge-use.ts'
import type { TunnelRow } from './lifecycle.ts'
import { loadVerifiedNames } from './verified-names.ts'

export type RoutedSet = {
  verifiedNames: string[]
  hostnames: string[] | null
  /** Fingerprint of the ingress the provider was given (null when never recorded). */
  ingress: string | null
}

function textList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : null
}

/** What the last write sent: the verified names and (null when never recorded) every routed name. */
export function readRouted(metadata: unknown): RoutedSet {
  const routes = (metadata as { routes?: Record<string, unknown> } | null)?.routes
  return {
    verifiedNames: textList(routes?.verifiedNames) ?? [],
    hostnames: textList(routes?.hostnames),
    ingress: typeof routes?.ingress === 'string' ? routes.ingress : null,
  }
}

export function readRoutedVerified(metadata: unknown): string[] {
  return readRouted(metadata).verifiedNames
}

export function sameList(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((n, i) => n === b[i])
}

function sameRouted(a: RoutedSet, b: RoutedSet): boolean {
  const names =
    a.hostnames === null || b.hostnames === null
      ? a.hostnames === b.hostnames
      : sameList(a.hostnames, b.hostnames)
  return names && sameList(a.verifiedNames, b.verifiedNames) && a.ingress === b.ingress
}

export type PushInput = {
  accountId: string | null
  /** Every name to route, read fresh on each attempt. */
  hostnames: (db: Db) => Promise<string[]>
  /** Write only when the names, the verified names or the built ingress differ from the last write. */
  onlyIfChanged?: boolean
}

export type PushResult = { pushed: boolean; verifiedNames: string[] }

/** Passes at most; a tunnel whose names keep changing under the writer is left for the next pass. */
export const PUSH_ATTEMPTS = 3

type Names = { hostnames: string[]; verifiedNames: string[]; ingress: string | null }

async function readNames(
  db: Db,
  rowId: string,
  input: PushInput,
  now: Date,
  adapter: TunnelAdapter
): Promise<Names> {
  const hostnames = (await input.hostnames(db)).map((n) => n.toLowerCase())
  const wanted = new Set(hostnames)
  const verifiedNames = (await loadVerifiedNames(db, rowId, now)).filter((n) => wanted.has(n))
  // What the provider is given depends on more than the names (the origin, the
  // per-name verification flags), so a change in how it is built counts too.
  const ingress = adapter.ingressFingerprint
    ? await adapter.ingressFingerprint({ hostnames, verifiedNames })
    : null
  return { hostnames, verifiedNames, ingress }
}

/** Write the full route set of a tunnel with its verified names. */
export async function pushTunnelRoutes(
  db: Db,
  deps: { adapter: TunnelAdapter; secrets: DerivedSecretsConfig },
  owner: { id: string },
  row: Pick<TunnelRow, 'id' | 'externalId'>,
  input: PushInput,
  now: Date = new Date()
): Promise<PushResult> {
  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
    const [current] = await db
      .select({ metadata: tunnel.metadata, status: tunnel.status })
      .from(tunnel)
      .where(eq(tunnel.id, row.id))
    if (!current) return { pushed: false, verifiedNames: [] }
    const { hostnames, verifiedNames, ingress } = await readNames(
      db,
      row.id,
      input,
      now,
      deps.adapter
    )
    const started = readRouted(current.metadata)
    if (
      input.onlyIfChanged &&
      sameList(started.hostnames, hostnames) &&
      sameList(started.verifiedNames, verifiedNames) &&
      started.ingress === ingress
    ) {
      return { pushed: false, verifiedNames }
    }
    await useBadges(db, deps.secrets, owner.id, { capability: 'tunnels' }, (token) =>
      deps.adapter.setRoutes(token, {
        accountId: input.accountId,
        externalId: row.externalId!,
        hostnames,
        verifiedNames,
      })
    )
    const recorded = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ metadata: tunnel.metadata, status: tunnel.status })
        .from(tunnel)
        .where(eq(tunnel.id, row.id))
        .for('update')
      // A tunnel that is gone or being removed has nothing left to record.
      if (!locked || locked.status === 'removing') return true
      const last = readRouted(locked.metadata)
      if (!sameRouted(last, started)) return false
      const again = await readNames(tx as unknown as Db, row.id, input, now, deps.adapter)
      if (
        !sameList(again.hostnames, hostnames) ||
        !sameList(again.verifiedNames, verifiedNames) ||
        again.ingress !== ingress
      ) {
        return false
      }
      await tx
        .update(tunnel)
        .set({
          metadata: sql`jsonb_set(coalesce(${tunnel.metadata}, '{}'::jsonb), '{routes}', ${JSON.stringify(ingress === null ? { verifiedNames, hostnames } : { verifiedNames, hostnames, ingress })}::jsonb)`,
        })
        .where(eq(tunnel.id, row.id))
      return true
    })
    if (recorded) return { pushed: true, verifiedNames }
  }
  throw new Error(
    'The tunnel routes kept changing while they were written; the next pass writes them again'
  )
}
