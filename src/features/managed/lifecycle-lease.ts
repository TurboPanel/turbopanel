/**
 * One start, stop, restart or delete request at a time per managed database.
 *
 * The route checks that no lifecycle or destroy command is in flight and then
 * queues one. Two requests that arrive together would both pass the check, so
 * the check and the enqueue run under this lease. It lives in the `lease`
 * table, not in a Postgres advisory lock: advisory locks are session-scoped and
 * unsupported on the Workers/Hyperdrive path (see `billing/quantity-lock.ts`).
 *
 * Taking it is one statement: insert, or take over a row whose holder's time
 * ran out (`ON CONFLICT … DO UPDATE … WHERE expires_at <= now`). Postgres locks
 * the conflicting row for that update, so two takers can never both win.
 * Release is owner-scoped; a crashed holder's row is taken over once it expires.
 */

import { and, eq, lte } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { lease } from '../../db/schema.ts'

/** Covers the member checks and one enqueue per member, with room for a slow connect. */
export const MANAGED_LIFECYCLE_LEASE_MS = 60_000

export type ManagedLifecycleLease = Readonly<{
  name: string
  organizationId: string
  owner: string
}>

function leaseName(managedId: string): string {
  return `MANAGED_LIFECYCLE_LOCK:${managedId}`
}

/** The lease for one database, or `null` while another request holds it. */
export async function tryTakeManagedLifecycleLease(
  db: Db,
  params: Readonly<{ organizationId: string; managedId: string }>,
  nowMs = Date.now()
): Promise<ManagedLifecycleLease | null> {
  const name = leaseName(params.managedId)
  const owner = crypto.randomUUID()
  const now = new Date(nowMs).toISOString()
  const expiresAt = new Date(nowMs + MANAGED_LIFECYCLE_LEASE_MS).toISOString()
  const rows = await db
    .insert(lease)
    .values({ name, organizationId: params.organizationId, owner, expiresAt })
    .onConflictDoUpdate({
      target: [lease.name, lease.organizationId],
      set: { owner, expiresAt, updatedAt: now },
      setWhere: lte(lease.expiresAt, now),
    })
    .returning({ owner: lease.owner })
  return rows[0]?.owner === owner ? { name, organizationId: params.organizationId, owner } : null
}

/** Owner-scoped: a lease taken over after it expired is never released by its former holder. */
export async function releaseManagedLifecycleLease(
  db: Db,
  held: ManagedLifecycleLease
): Promise<void> {
  await db
    .delete(lease)
    .where(
      and(
        eq(lease.name, held.name),
        eq(lease.organizationId, held.organizationId),
        eq(lease.owner, held.owner)
      )
    )
}
