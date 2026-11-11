/**
 * One generation per organization tunnel table (feature
 * `tunnel-table-generation-v1`). The daemon keeps the highest generation it
 * applied and ignores an older table or deploy, so a deploy and a table update
 * that cross never bring back an older carrier list.
 *
 * The rule: when the table's content changes, the new generation is
 * `max(previous + 1, current Unix time in milliseconds)`, so the counter
 * survives a restore or reset. A resend of an unchanged table (the periodic
 * resend, a reconnect) reuses the same generation, because a changed one makes
 * every daemon apply the whole table again.
 *
 * It is kept in `organization.options.tunnelTable` as `{ contentHash,
 * generation }`, next to the other organization options (no column). The
 * content hash covers what the organization's tables are built from (which
 * servers carry each tunnel, where each name's site runs and those servers'
 * addresses), so the same value serves the table sender and the deploy that
 * carries the peers.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import { TUNNEL_TABLE_GENERATION_FEATURE } from '../../lib/version-wire.ts'
import { compareText } from './order.ts'
import type { RoutingFacts } from './route-facts.ts'

/** What is stored for an organization. */
export type StoredTunnelGeneration = { contentHash: string; generation: number }

/** A resolved generation, and whether it was newly raised by this call. */
export type TunnelGenerationDecision = StoredTunnelGeneration & { changed: boolean }

/** Only a daemon that lists `tunnel-table-generation-v1` is sent a generation. */
export function daemonTakesTunnelGeneration(features: readonly string[] | undefined): boolean {
  return features?.includes(TUNNEL_TABLE_GENERATION_FEATURE) === true
}

/**
 * The generation to send a daemon, or `undefined` for one that does not list
 * the feature (nothing is resolved or stored for it).
 */
export async function generationForDaemon(
  features: readonly string[] | undefined,
  resolve: () => Promise<number>
): Promise<number | undefined> {
  return daemonTakesTunnelGeneration(features) ? await resolve() : undefined
}

/** Pure: the next generation for changed content. Never below the clock, always above the last. */
export function nextTunnelGeneration(previous: number | undefined, nowMs: number): number {
  const floor = Math.floor(nowMs)
  return previous === undefined ? floor : Math.max(previous + 1, floor)
}

/**
 * Pure: keep the stored generation when the content is the same, raise it when
 * it is not (or when nothing was stored yet).
 */
export function decideTunnelGeneration(
  stored: StoredTunnelGeneration | undefined,
  contentHash: string,
  nowMs: number
): TunnelGenerationDecision {
  if (stored?.contentHash === contentHash) return { ...stored, changed: false }
  return { contentHash, generation: nextTunnelGeneration(stored?.generation, nowMs), changed: true }
}

/** The facts in a fixed order (every list sorted) as text, so equal content gives equal text. */
export function canonicalTunnelFacts(facts: RoutingFacts): string {
  const involved = new Set<string>()
  const tunnels = facts.tunnels.map((tunnel) => {
    for (const id of tunnel.carrying) involved.add(id)
    return {
      carrying: [...tunnel.carrying].toSorted(compareText),
      doorways: tunnel.doorways
        .map((d) => {
          for (const id of d.siteServerIds) involved.add(id)
          return {
            hostname: d.hostname,
            isLocalOnly: d.isLocalOnly,
            siteServerIds: [...d.siteServerIds].toSorted(compareText),
          }
        })
        .toSorted((a, b) => compareText(a.hostname, b.hostname)),
    }
  })
  const text = tunnels.map((t) => JSON.stringify(t)).toSorted(compareText)
  const addresses = [...involved].toSorted(compareText).map((id) => [id, facts.addresses.get(id)])
  return JSON.stringify({ tunnels: text, addresses })
}

export async function hashTunnelFacts(facts: RoutingFacts): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalTunnelFacts(facts))
  )
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The stored value, or `undefined` when none or malformed. */
export function readStoredTunnelGeneration(options: unknown): StoredTunnelGeneration | undefined {
  const raw = (options as { tunnelTable?: Partial<StoredTunnelGeneration> } | null)?.tunnelTable
  if (
    raw &&
    typeof raw.contentHash === 'string' &&
    typeof raw.generation === 'number' &&
    Number.isSafeInteger(raw.generation) &&
    raw.generation >= 0
  ) {
    return { contentHash: raw.contentHash, generation: raw.generation }
  }
  return undefined
}

const MAX_ATTEMPTS = 5

async function loadStored(db: Db, organizationId: string): Promise<unknown> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return row?.options
}

/**
 * Raise the stored generation only when the stored value is still exactly the
 * one this decision was made from (`previous`, the raw value or `null` when
 * absent, even a malformed one), so two callers that see the same change store
 * one value.
 */
async function storeIfUnchanged(
  db: Db,
  organizationId: string,
  previous: unknown,
  next: StoredTunnelGeneration
): Promise<boolean> {
  const rows = await db
    .update(organization)
    .set({
      options: sql`jsonb_set(CASE WHEN jsonb_typeof(${organization.options}) = 'object' THEN ${organization.options} ELSE '{}'::jsonb END, '{tunnelTable}', ${JSON.stringify(next)}::jsonb, true)`,
    })
    .where(
      and(
        eq(organization.id, organizationId),
        sql`(${organization.options} -> 'tunnelTable') IS NOT DISTINCT FROM ${previous === null ? null : JSON.stringify(previous)}::jsonb`
      )
    )
    .returning({ id: organization.id })
  return rows.length > 0
}

/**
 * The generation of the organization's table for these facts. An unchanged
 * table gets the stored number back; changed content stores and returns a
 * higher one. `now` is injectable for tests.
 */
export async function resolveTunnelGeneration(
  db: Db,
  organizationId: string,
  facts: RoutingFacts,
  now: () => number = Date.now
): Promise<number> {
  const contentHash = await hashTunnelFacts(facts)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const options = await loadStored(db, organizationId)
    const stored = readStoredTunnelGeneration(options)
    const previous = (options as { tunnelTable?: unknown } | null)?.tunnelTable ?? null
    const decision = decideTunnelGeneration(stored, contentHash, now())
    if (!decision.changed) return decision.generation
    const next = { contentHash: decision.contentHash, generation: decision.generation }
    if (await storeIfUnchanged(db, organizationId, previous, next)) return next.generation
  }
  throw new Error('The tunnel table generation could not be stored')
}
