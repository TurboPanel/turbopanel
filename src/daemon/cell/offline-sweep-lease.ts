/**
 * Cross-isolate CAS lease for the offline-sweep cron.
 *
 * Modelled on `tryBeginLeafRenewalSweep` / `endLeafRenewalSweep` (insert
 * `onConflictDoNothing`, then a value-compare `UPDATE` to steal an expired
 * lease). No cursor field — this sweep already paginates via
 * `rotateSweepBatch`. Lives in the Postgres `setting` table so a second
 * Cloudflare isolate skips instead of doubling DO wakes and Hyperdrive
 * clients; no KV, D1, R2, or DO storage is added.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { setting } from "../../lib/db/schema.ts";

/** `setting.key` for the cross-isolate offline-sweep lease. */
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

function isSweepLockValue(
  value: unknown,
): value is OfflineSweepLockValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.owner === "string" &&
    typeof record.expiresAt === "string";
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
    .insert(setting)
    .values({ key: OFFLINE_SWEEP_LOCK_KEY, value: fresh })
    .onConflictDoNothing({ target: setting.key })
    .returning({ key: setting.key });
  if (inserted.length > 0) {
    return lockFromValue(fresh);
  }

  const [existing] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, OFFLINE_SWEEP_LOCK_KEY))
    .limit(1);
  if (
    !existing || !isSweepLockValue(existing.value) ||
    !sweepLockIsStealable(existing.value, nowMs)
  ) {
    return null;
  }

  const stolenValue = nextSweepLockValue(owner, nowMs, opts.heldUntilMs);
  const stolen = await db
    .update(setting)
    .set({ value: stolenValue, updatedAt: nowIso(nowMs) })
    .where(
      and(
        eq(setting.key, OFFLINE_SWEEP_LOCK_KEY),
        eq(setting.value, existing.value),
      ),
    )
    .returning({ key: setting.key });
  if (stolen.length > 0) {
    return lockFromValue(stolenValue);
  }
  return null;
}

/**
 * Release the lease without dropping the setting row, so there is no insert
 * churn on the next tick. Empty owner + expired `expiresAt` makes the row
 * stealable immediately.
 */
export async function endOfflineSweep(
  db: Db,
  lock: OfflineSweepLock,
  nowMs = Date.now(),
): Promise<void> {
  await db
    .update(setting)
    .set({
      value: {
        owner: "",
        expiresAt: nowIso(nowMs),
      },
      updatedAt: nowIso(nowMs),
    })
    .where(
      and(
        eq(setting.key, OFFLINE_SWEEP_LOCK_KEY),
        sql`${setting.value}->>'owner' = ${lock.owner}`,
      ),
    );
}
