/**
 * Per-organization quantity-mutation lease.
 *
 * Stripe has no compare-and-swap, and a subscription update **replaces the
 * whole `items` array**. Two concurrent mutations for one organization — a
 * license mint and a seat downgrade landing together — would each read the
 * current items, each compute a new array, and the second write would
 * silently undo the first. So every quantity mutation for an organization
 * runs under one lease, held for the Stripe round trip plus the projection
 * write.
 *
 * Postgres advisory locks are **unsupported on the Workers/Hyperdrive path**
 * (they are session-scoped, and Hyperdrive pools sessions), so this is the
 * same CAS lease as `src/admin/reencrypt-secrets.ts`, in the `lease` table
 * (schema-child-tables, Road-to-0.1.x — promoted out of the `setting`
 * table), scoped by `organization_id` rather than globally:
 *
 *   - acquire is `INSERT … ON CONFLICT DO NOTHING`; when that loses, the row
 *     is read and stolen only if it is **expired and** a compare-and-set on
 *     the exact previous owner/expiry still matches;
 *   - release is owner-scoped, so a lease that was stolen after its TTL is
 *     never released by its former holder.
 *
 * Rows are transient by design: created on mutation, deleted on release.
 * A crashed holder leaves one behind until the TTL passes, and the next
 * caller steals it.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { lease } from '../db/schema.ts'

/** `lease.name` for every organization's billing-quantity lease. */
export const BILLING_QUANTITY_LOCK_NAME = 'BILLING_QUANTITY_LOCK'

/**
 * Sized for one Stripe round trip (`STRIPE_REQUEST_TIMEOUT_MS`, 20 s) plus
 * the projection write, with headroom for a slow Hyperdrive connect.
 */
export const BILLING_QUANTITY_LEASE_MS = 60_000

export type BillingQuantityLock = Readonly<{
  organizationId: string
  owner: string
}>

type LockValue = {
  owner: string
  expiresAt: string
}

function lockIsExpired(lock: LockValue, nowMs: number): boolean {
  const expires = Date.parse(lock.expiresAt)
  if (!Number.isFinite(expires)) return true
  return expires <= nowMs
}

function nextLockValue(owner: string, nowMs: number): LockValue {
  return { owner, expiresAt: new Date(nowMs + BILLING_QUANTITY_LEASE_MS).toISOString() }
}

/**
 * Acquire the lease for one organization. `null` when another owner holds an
 * unexpired one. Callers that receive a lock **must** call
 * {@link endQuantityMutation} in `finally`.
 */
export async function tryBeginQuantityMutation(
  db: Db,
  organizationId: string,
  nowMs = Date.now(),
): Promise<BillingQuantityLock | null> {
  const owner = crypto.randomUUID()
  const lockValue = nextLockValue(owner, nowMs)

  const inserted = await db
    .insert(lease)
    .values({
      name: BILLING_QUANTITY_LOCK_NAME,
      organizationId,
      owner: lockValue.owner,
      expiresAt: lockValue.expiresAt,
    })
    .onConflictDoNothing({ target: [lease.name, lease.organizationId] })
    .returning({ id: lease.id })
  if (inserted.length > 0) return { organizationId, owner }

  const [existing] = await db
    .select({ owner: lease.owner, expiresAt: lease.expiresAt })
    .from(lease)
    .where(and(eq(lease.name, BILLING_QUANTITY_LOCK_NAME), eq(lease.organizationId, organizationId)))
    .limit(1)
  if (!existing || !lockIsExpired(existing, nowMs)) {
    return null
  }

  // Steal only if nobody else did first: CAS on the exact previous owner/expiry.
  const stolen = await db
    .update(lease)
    .set({ owner: lockValue.owner, expiresAt: lockValue.expiresAt, updatedAt: new Date(nowMs).toISOString() })
    .where(
      and(
        eq(lease.name, BILLING_QUANTITY_LOCK_NAME),
        eq(lease.organizationId, organizationId),
        eq(lease.owner, existing.owner),
        eq(lease.expiresAt, existing.expiresAt),
      ),
    )
    .returning({ id: lease.id })
  return stolen.length > 0 ? { organizationId, owner } : null
}

/** Owner-scoped release: a stolen lease is never released by its former holder. */
export async function endQuantityMutation(
  db: Db,
  lock: BillingQuantityLock,
): Promise<void> {
  await db
    .delete(lease)
    .where(
      and(
        eq(lease.name, BILLING_QUANTITY_LOCK_NAME),
        eq(lease.organizationId, lock.organizationId),
        eq(lease.owner, lock.owner),
      ),
    )
}

/** Test-only: drop one organization's lease row when `db` is provided. */
export async function resetBillingQuantityLockForTests(
  db: Db | undefined,
  organizationId: string,
): Promise<void> {
  if (!db) return
  await db
    .delete(lease)
    .where(and(eq(lease.name, BILLING_QUANTITY_LOCK_NAME), eq(lease.organizationId, organizationId)))
}
