/**
 * Cross-isolate CAS lease for the offline-sweep cron.
 *
 * Modelled on `tryBeginLeafRenewalSweep` / `endLeafRenewalSweep` (insert
 * `onConflictDoNothing`, then a value-compare `UPDATE` to steal an expired
 * lease). No cursor field — this sweep already paginates via
 * `rotateSweepBatch`. Lives in the `lease` table (schema-child-tables,
 * Road-to-0.1.x — promoted out of the `setting` table) so a second
 * Cloudflare isolate skips instead of doubling DO wakes and Hyperdrive
 * clients; no KV, D1, R2, or DO storage is added.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import { lease } from "../../db/schema.ts";

/** `lease.name` for the cross-isolate offline-sweep lease — globally scoped. */
export const OFFLINE_SWEEP_LOCK_KEY = "OFFLINE_SWEEP_LOCK";

/**
 * Lease TTL sized just above the tick budget so a crashed isolate cannot
 * block offline detection for two full ticks (the other sweep leases use
 * 120 s). `tryBeginOfflineSweep` may extend `expiresAt` to `heldUntilMs`
 * when the tick's enforced live runtime is longer than this TTL, so a
 * still-running holder cannot be stolen mid-invocation.
 */
export const OFFLINE_SWEEP_LEASE_MS = 90_000;

export type OfflineSweepLock = Readonly<{
  owner: string;
  expiresAt: string;
}>;

export type TryBeginOfflineSweepOpts = {
  /**
   * Wall-clock instant the holder is still allowed to run (tick deadline
   * plus bounded lease-release). `expiresAt` is `max(now + TTL, heldUntilMs)`
   * so the lock cannot be stolen until after that enforced live runtime.
   */
  heldUntilMs?: number;
};

type OfflineSweepLockValue = {
  owner: string;
  expiresAt: string;
};

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function sweepLockIsExpired(
  lock: OfflineSweepLockValue,
  nowMs = Date.now(),
): boolean {
  const expires = Date.parse(lock.expiresAt);
  if (!Number.isFinite(expires)) return true;
  return expires <= nowMs;
}

function sweepLockIsStealable(
  lock: OfflineSweepLockValue,
  nowMs = Date.now(),
): boolean {
  if (lock.owner.length === 0) return true;
  return sweepLockIsExpired(lock, nowMs);
}

function lockExpiryMs(nowMs: number, heldUntilMs?: number): number {
  const ttlExpiry = nowMs + OFFLINE_SWEEP_LEASE_MS;
  if (heldUntilMs === undefined || !Number.isFinite(heldUntilMs)) {
    return ttlExpiry;
  }
  return Math.max(ttlExpiry, heldUntilMs);
}

function nextSweepLockValue(
  owner: string,
  nowMs = Date.now(),
  heldUntilMs?: number,
): OfflineSweepLockValue {
  return {
    owner,
    expiresAt: new Date(lockExpiryMs(nowMs, heldUntilMs)).toISOString(),
  };
}

function lockFromValue(value: OfflineSweepLockValue): OfflineSweepLock {
  return {
    owner: value.owner,
    expiresAt: value.expiresAt,
  };
}

/**
 * Acquire the durable sweep lease. Returns `null` when another owner holds an
 * unexpired lease. Callers that receive a lock **must** call
 * {@link endOfflineSweep} in `finally`.
 */
export async function tryBeginOfflineSweep(
  db: Db,
  nowMs = Date.now(),
  opts: TryBeginOfflineSweepOpts = {},
): Promise<OfflineSweepLock | null> {
  const owner = crypto.randomUUID();
  const fresh = nextSweepLockValue(owner, nowMs, opts.heldUntilMs);

  const inserted = await db
    .insert(lease)
    .values({
      name: OFFLINE_SWEEP_LOCK_KEY,
      organizationId: null,
      owner: fresh.owner,
      expiresAt: fresh.expiresAt,
    })
    .onConflictDoNothing({ target: [lease.name, lease.organizationId] })
    .returning({ id: lease.id });
  if (inserted.length > 0) {
    return lockFromValue(fresh);
  }

  const [existing] = await db
    .select({ owner: lease.owner, expiresAt: lease.expiresAt })
    .from(lease)
    .where(and(eq(lease.name, OFFLINE_SWEEP_LOCK_KEY), isNull(lease.organizationId)))
    .limit(1);
  if (!existing || !sweepLockIsStealable(existing, nowMs)) {
    return null;
  }

  const stolenValue = nextSweepLockValue(owner, nowMs, opts.heldUntilMs);
  const stolen = await db
    .update(lease)
    .set({
      owner: stolenValue.owner,
      expiresAt: stolenValue.expiresAt,
      updatedAt: nowIso(nowMs),
    })
    .where(
      and(
        eq(lease.name, OFFLINE_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, existing.owner),
        eq(lease.expiresAt, existing.expiresAt),
      ),
    )
    .returning({ id: lease.id });
  if (stolen.length > 0) {
    return lockFromValue(stolenValue);
  }
  return null;
}

/**
 * Release the lease without dropping the row, so there is no insert churn on
 * the next tick. Empty owner + expired `expiresAt` makes the row stealable
 * immediately.
 */
export async function endOfflineSweep(
  db: Db,
  lock: OfflineSweepLock,
  nowMs = Date.now(),
): Promise<void> {
  await db
    .update(lease)
    .set({
      owner: "",
      expiresAt: nowIso(nowMs),
      updatedAt: nowIso(nowMs),
    })
    .where(
      and(
        eq(lease.name, OFFLINE_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, lock.owner),
      ),
    );
}
