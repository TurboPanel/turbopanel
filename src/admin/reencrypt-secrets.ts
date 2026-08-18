/**
 * Superadmin at-rest secret re-encryption sweep.
 *
 * Re-seals `variable.value` (is_secret), `tls.privateKeyPem`,
 * `principal.password`, `storage.content_envelope`, `credential.secret_envelope`,
 * and email secret keys in the `SYSTEM_EMAIL` setting row onto the current
 * data-encryption key version.
 *
 * Per-blob rules (variable / TLS / principal / storage / credential / email secrets):
 * - Valid daemon-bound `tpdaemon` → skipped (delivery envelopes are not at-rest
 *   material for this sweep; variables/TLS/principals only).
 * - Malformed `tpdaemon` or malformed `tpsecret` → failed.
 * - Non-envelope plaintext → failed (never auto-migrated).
 * - Current-version `tpsecret` → skipped.
 * - Older-version `tpsecret` → decrypt + re-seal; decrypt failures → failed.
 *
 * Email secret keys (`MAILGUN_API_KEY` / `SMTP_PASS`) follow the same
 * plaintext-is-failed rule as variables/TLS/principals.
 *
 * Sweeps are **bounded**: each call processes at most `limit` blobs (default
 * {@link REENCRYPT_BATCH_SIZE}) and returns a resume cursor until
 * `completed: true`. A durable `setting`-row lease
 * ({@link tryBeginReencryptSweep}) rejects concurrent sweeps across Workers
 * isolates and Deno processes with **409** `reencrypt_in_progress`.
 *
 * Every write is conditional on the original envelope still being present
 * (compare-and-swap on id + secret column) so a concurrent update during
 * rotation is left untouched rather than overwritten with a stale reseal.
 */

import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import {
  decryptSecret,
  encryptSecret,
  ENVELOPE_PREFIX_SECRET,
  isDaemonSealedEnvelope,
  parseDaemonSecretEnvelope,
  parseSecretEnvelope,
} from "../client/authn/data-encryption.ts";
import type { DerivedSecretsConfig } from "../client/authn/secrets.ts";
import type { Db } from "../db.ts";
import {
  credential,
  principal,
  setting,
  storage,
  tls,
  variable,
} from "../lib/db/schema.ts";
import {
  EMAIL_SECRET_KEYS,
  SYSTEM_EMAIL_DB_KEY,
} from "../lib/settings/email-settings.ts";

export const REENCRYPT_BATCH_SIZE = 200;

/** `setting.key` for the cross-isolate re-encrypt sweep lease. */
export const REENCRYPT_SWEEP_LOCK_KEY = "REENCRYPT_SWEEP_LOCK";

/** Lease TTL so a crashed isolate cannot block sweeps indefinitely. */
export const REENCRYPT_SWEEP_LEASE_MS = 120_000;

export type ReencryptSweepLock = Readonly<{
  owner: string;
}>;

type ReencryptSweepLockValue = {
  owner: string;
  expiresAt: string;
};

export const REENCRYPT_STAGES = [
  "variables",
  "tls",
  "principals",
  "storage",
  "credentials",
  "email",
] as const;

export type ReencryptStage = (typeof REENCRYPT_STAGES)[number];

export type ReencryptCursor = {
  stage: ReencryptStage;
  /** Last processed row id within `stage` (exclusive lower bound for the next page). */
  afterId?: string;
};

export type ReencryptSweepSummary = {
  scanned: number;
  reencrypted: number;
  skipped: number;
  failed: number;
};

export type ReencryptSweepResult = ReencryptSweepSummary & {
  completed: boolean;
  cursor: ReencryptCursor | null;
};

export type ReencryptSweepOptions = Readonly<{
  cursor?: ReencryptCursor | null;
  /** Max blobs to scan in this call (default {@link REENCRYPT_BATCH_SIZE}). */
  limit?: number;
}>;

function emptySummary(): ReencryptSweepSummary {
  return { scanned: 0, reencrypted: 0, skipped: 0, failed: 0 };
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextStage(stage: ReencryptStage): ReencryptStage | null {
  const index = REENCRYPT_STAGES.indexOf(stage);
  if (index < 0 || index >= REENCRYPT_STAGES.length - 1) {
    return null;
  }
  return REENCRYPT_STAGES[index + 1]!;
}

function normalizeCursor(
  cursor: ReencryptCursor | null | undefined,
): ReencryptCursor {
  if (!cursor || !REENCRYPT_STAGES.includes(cursor.stage)) {
    return { stage: "variables" };
  }
  return {
    stage: cursor.stage,
    ...(cursor.afterId ? { afterId: cursor.afterId } : {}),
  };
}

function isSweepLockValue(value: unknown): value is ReencryptSweepLockValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.owner === "string" &&
    typeof record.expiresAt === "string";
}

function sweepLockIsExpired(
  lock: ReencryptSweepLockValue,
  nowMs = Date.now(),
): boolean {
  const expires = Date.parse(lock.expiresAt);
  if (!Number.isFinite(expires)) return true;
  return expires <= nowMs;
}

function nextSweepLockValue(
  owner: string,
  nowMs = Date.now(),
): ReencryptSweepLockValue {
  return {
    owner,
    expiresAt: new Date(nowMs + REENCRYPT_SWEEP_LEASE_MS).toISOString(),
  };
}

/**
 * Acquire the durable sweep lease. Returns `null` when another owner holds an
 * unexpired lease. Callers that receive a lock **must** call
 * {@link endReencryptSweep} in `finally`.
 */
export async function tryBeginReencryptSweep(
  db: Db,
  nowMs = Date.now(),
): Promise<ReencryptSweepLock | null> {
  const owner = crypto.randomUUID();
  const lockValue = nextSweepLockValue(owner, nowMs);

  const inserted = await db
    .insert(setting)
    .values({ key: REENCRYPT_SWEEP_LOCK_KEY, value: lockValue })
    .onConflictDoNothing({ target: setting.key })
    .returning({ key: setting.key });
  if (inserted.length > 0) {
    return { owner };
  }

  const [existing] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, REENCRYPT_SWEEP_LOCK_KEY))
    .limit(1);
  if (
    !existing || !isSweepLockValue(existing.value) ||
    !sweepLockIsExpired(existing.value, nowMs)
  ) {
    return null;
  }

  const stolen = await db
    .update(setting)
    .set({ value: lockValue, updatedAt: nowIso() })
    .where(
      and(
        eq(setting.key, REENCRYPT_SWEEP_LOCK_KEY),
        eq(setting.value, existing.value),
      ),
    )
    .returning({ key: setting.key });
  if (stolen.length > 0) {
    return { owner };
  }
  return null;
}

export async function endReencryptSweep(
  db: Db,
  lock: ReencryptSweepLock,
): Promise<void> {
  await db
    .delete(setting)
    .where(
      and(
        eq(setting.key, REENCRYPT_SWEEP_LOCK_KEY),
        sql`${setting.value}->>'owner' = ${lock.owner}`,
      ),
    );
}

/** Test-only: drop the durable sweep lock row when `db` is provided. */
export async function resetReencryptSweepLockForTests(db?: Db): Promise<void> {
  if (!db) return;
  await db.delete(setting).where(eq(setting.key, REENCRYPT_SWEEP_LOCK_KEY));
}

type ProcessBlobOptions = Readonly<{
  /** Skip valid daemon-bound `tpdaemon` envelopes (variable/TLS/principal paths). */
  allowDaemonBound: boolean;
}>;

async function applyResealedBlob(
  summary: ReencryptSweepSummary,
  update: (resealed: string) => Promise<boolean>,
  resealed: string,
): Promise<void> {
  const applied = await update(resealed);
  if (applied) {
    summary.reencrypted += 1;
  } else {
    // Concurrent writer changed the row; leave the newer value untouched.
    summary.skipped += 1;
  }
}

/**
 * Classify non-`tpsecret` material before any decrypt/reseal work.
 * Returns a terminal outcome, or `null` when the caller should treat `blob` as
 * an older-version `tpsecret` envelope to decrypt.
 */
function classifyBlobForSweep(
  blob: string,
  currentKeyVersion: number,
  options: ProcessBlobOptions,
): "skip" | "fail" | null {
  const daemonParsed = parseDaemonSecretEnvelope(blob);
  if (daemonParsed !== null) {
    return options.allowDaemonBound ? "skip" : "fail";
  }
  if (isDaemonSealedEnvelope(blob)) {
    // Malformed daemon envelope — not intentional `tpdaemon` material.
    return "fail";
  }

  const parsed = parseSecretEnvelope(blob);
  if (parsed !== null) {
    return parsed.keyVersion === currentKeyVersion ? "skip" : null;
  }

  if (blob.startsWith(ENVELOPE_PREFIX_SECRET)) {
    // Looks like `tpsecret` but failed structural parse → malformed at-rest material.
    return "fail";
  }

  // Non-envelope plaintext is invalid — never auto-migrated.
  return "fail";
}

/**
 * @param update - Apply the resealed envelope. Must return `true` only when the
 *   conditional update actually affected the row (original envelope still present).
 */
async function processBlob(
  summary: ReencryptSweepSummary,
  secrets: DerivedSecretsConfig,
  blob: string,
  update: (resealed: string) => Promise<boolean>,
  options: ProcessBlobOptions,
): Promise<void> {
  summary.scanned += 1;

  const classification = classifyBlobForSweep(
    blob,
    secrets.current.version,
    options,
  );
  if (classification === "skip") {
    summary.skipped += 1;
    return;
  }
  if (classification === "fail") {
    summary.failed += 1;
    return;
  }

  try {
    const plaintext = await decryptSecret(secrets, blob);
    const resealed = await encryptSecret(secrets, plaintext);
    await applyResealedBlob(summary, update, resealed);
  } catch {
    summary.failed += 1;
  }
}

type StageBatchResult = {
  /** Rows examined in this page (may be less than scanned when null columns skipped). */
  pageSize: number;
  lastId: string | undefined;
};

async function sweepSecretVariablesBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({ id: variable.id, value: variable.value })
    .from(variable)
    .where(
      afterId === undefined
        ? eq(variable.isSecret, true)
        : and(eq(variable.isSecret, true), gt(variable.id, afterId)),
    )
    .orderBy(asc(variable.id))
    .limit(limit);

  for (const row of rows) {
    const originalValue = row.value;
    await processBlob(
      summary,
      secrets,
      originalValue,
      async (resealed) => {
        const updated = await db
          .update(variable)
          .set({ value: resealed, updatedAt: nowIso() })
          .where(
            and(eq(variable.id, row.id), eq(variable.value, originalValue)),
          )
          .returning({ id: variable.id });
        return updated.length > 0;
      },
      { allowDaemonBound: true },
    );
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  };
}

async function sweepTlsPrivateKeysBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({ id: tls.id, privateKeyPem: tls.privateKeyPem })
    .from(tls)
    .where(
      afterId === undefined
        ? isNotNull(tls.privateKeyPem)
        : and(isNotNull(tls.privateKeyPem), gt(tls.id, afterId)),
    )
    .orderBy(asc(tls.id))
    .limit(limit);

  for (const row of rows) {
    if (row.privateKeyPem === null) {
      continue;
    }
    const originalKey = row.privateKeyPem;
    await processBlob(
      summary,
      secrets,
      originalKey,
      async (resealed) => {
        const updated = await db
          .update(tls)
          .set({ privateKeyPem: resealed, updatedAt: nowIso() })
          .where(and(eq(tls.id, row.id), eq(tls.privateKeyPem, originalKey)))
          .returning({ id: tls.id });
        return updated.length > 0;
      },
      { allowDaemonBound: true },
    );
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  };
}

async function sweepPrincipalPasswordsBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({ id: principal.id, password: principal.password })
    .from(principal)
    .where(
      afterId === undefined
        ? isNotNull(principal.password)
        : and(isNotNull(principal.password), gt(principal.id, afterId)),
    )
    .orderBy(asc(principal.id))
    .limit(limit);

  for (const row of rows) {
    if (row.password === null) {
      continue;
    }
    const originalPassword = row.password;
    await processBlob(
      summary,
      secrets,
      originalPassword,
      async (resealed) => {
        const updated = await db
          .update(principal)
          .set({ password: resealed, updatedAt: nowIso() })
          .where(
            and(
              eq(principal.id, row.id),
              eq(principal.password, originalPassword),
            ),
          )
          .returning({ id: principal.id });
        return updated.length > 0;
      },
      { allowDaemonBound: true },
    );
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  };
}

async function sweepStorageContentBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({ id: storage.id, contentEnvelope: storage.contentEnvelope })
    .from(storage)
    .where(
      afterId === undefined
        ? isNotNull(storage.contentEnvelope)
        : and(isNotNull(storage.contentEnvelope), gt(storage.id, afterId)),
    )
    .orderBy(asc(storage.id))
    .limit(limit);

  for (const row of rows) {
    if (row.contentEnvelope === null) {
      continue;
    }
    const original = row.contentEnvelope;
    await processBlob(
      summary,
      secrets,
      original,
      async (resealed) => {
        const updated = await db
          .update(storage)
          .set({ contentEnvelope: resealed, updatedAt: nowIso() })
          .where(
            and(eq(storage.id, row.id), eq(storage.contentEnvelope, original)),
          )
          .returning({ id: storage.id });
        return updated.length > 0;
      },
      { allowDaemonBound: true },
    );
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  };
}

async function sweepCredentialSecretsBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({ id: credential.id, secretEnvelope: credential.secretEnvelope })
    .from(credential)
    .where(
      afterId === undefined
        ? isNotNull(credential.secretEnvelope)
        : and(isNotNull(credential.secretEnvelope), gt(credential.id, afterId)),
    )
    .orderBy(asc(credential.id))
    .limit(limit);

  for (const row of rows) {
    const original = row.secretEnvelope;
    await processBlob(
      summary,
      secrets,
      original,
      async (resealed) => {
        const updated = await db
          .update(credential)
          .set({ secretEnvelope: resealed, updatedAt: nowIso() })
          .where(
            and(
              eq(credential.id, row.id),
              eq(credential.secretEnvelope, original),
            ),
          )
          .returning({ id: credential.id });
        return updated.length > 0;
      },
      { allowDaemonBound: true },
    );
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  };
}

/**
 * Re-seal `MAILGUN_API_KEY` / `SMTP_PASS` in the single `SYSTEM_EMAIL` settings
 * row. All email secrets live in one JSON `setting.value`, so a single
 * compare-and-swap on the whole row persists every resealed key at once; a
 * concurrent writer that changed the row leaves the reseals uncounted (skipped).
 */
async function sweepEmailSettingSecrets(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
): Promise<void> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, SYSTEM_EMAIL_DB_KEY))
    .limit(1);

  const original = rows[0]?.value;
  if (
    original === undefined ||
    original === null ||
    typeof original !== "object" ||
    Array.isArray(original)
  ) {
    return;
  }

  const originalObj = original as Record<string, unknown>;
  const nextObj: Record<string, unknown> = { ...originalObj };
  let resealedCount = 0;

  for (const shortKey of EMAIL_SECRET_KEYS) {
    const raw = nextObj[shortKey];
    if (typeof raw !== "string" || raw === "") continue;

    summary.scanned += 1;
    const parsed = parseSecretEnvelope(raw);
    if (parsed === null) {
      // Plaintext, tpdaemon, or malformed — invalid/unsupported for email at rest.
      summary.failed += 1;
      continue;
    }
    if (parsed.keyVersion === secrets.current.version) {
      summary.skipped += 1;
      continue;
    }

    try {
      const plaintext = await decryptSecret(secrets, raw);
      nextObj[shortKey] = await encryptSecret(secrets, plaintext);
      resealedCount += 1;
    } catch {
      summary.failed += 1;
    }
  }

  if (resealedCount === 0) return;

  const updated = await db
    .update(setting)
    .set({ value: nextObj, updatedAt: nowIso() })
    .where(
      and(eq(setting.key, SYSTEM_EMAIL_DB_KEY), eq(setting.value, original)),
    )
    .returning({ key: setting.key });

  if (updated.length > 0) {
    summary.reencrypted += resealedCount;
  } else {
    // Concurrent writer changed the row; leave the newer values untouched.
    summary.skipped += resealedCount;
  }
}

/**
 * Run one bounded batch of the at-rest re-encryption sweep.
 *
 * Pass the previous response's `cursor` to resume. When `completed` is true,
 * `cursor` is `null`. Counts are for **this batch only** — callers accumulate.
 */
export async function reencryptAtRestSecrets(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  options: ReencryptSweepOptions = {},
): Promise<ReencryptSweepResult> {
  const limit = options.limit ?? REENCRYPT_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("reencrypt limit must be a positive integer");
  }

  const summary = emptySummary();
  let cursor = normalizeCursor(options.cursor);
  let remaining = limit;

  while (remaining > 0) {
    if (cursor.stage === "email") {
      await sweepEmailSettingSecrets(db, dataEncryptionSecrets, summary);
      return { ...summary, completed: true, cursor: null };
    }

    let batch: StageBatchResult;
    switch (cursor.stage) {
      case "variables":
        batch = await sweepSecretVariablesBatch(
          db,
          dataEncryptionSecrets,
          summary,
          cursor.afterId,
          remaining,
        );
        break;
      case "tls":
        batch = await sweepTlsPrivateKeysBatch(
          db,
          dataEncryptionSecrets,
          summary,
          cursor.afterId,
          remaining,
        );
        break;
      case "principals":
        batch = await sweepPrincipalPasswordsBatch(
          db,
          dataEncryptionSecrets,
          summary,
          cursor.afterId,
          remaining,
        );
        break;
      case "storage":
        batch = await sweepStorageContentBatch(
          db,
          dataEncryptionSecrets,
          summary,
          cursor.afterId,
          remaining,
        );
        break;
      case "credentials":
        batch = await sweepCredentialSecretsBatch(
          db,
          dataEncryptionSecrets,
          summary,
          cursor.afterId,
          remaining,
        );
        break;
    }

    const requested = remaining;
    remaining -= batch.pageSize;

    if (batch.pageSize === 0 || batch.pageSize < requested) {
      // No more rows in this stage — advance to the next (email when table stages end).
      const following = nextStage(cursor.stage);
      if (following === null) {
        return { ...summary, completed: true, cursor: null };
      }
      cursor = { stage: following };
      continue;
    }

    // Full page consumed the remaining budget; more rows may exist.
    return {
      ...summary,
      completed: false,
      cursor: {
        stage: cursor.stage,
        ...(batch.lastId ? { afterId: batch.lastId } : {}),
      },
    };
  }

  return {
    ...summary,
    completed: false,
    cursor: {
      stage: cursor.stage,
      ...(cursor.afterId ? { afterId: cursor.afterId } : {}),
    },
  };
}

/**
 * Run batches until the sweep completes. Used by tests and callers that need
 * a full pass in-process. Still respects {@link REENCRYPT_BATCH_SIZE} per
 * internal batch for memory bounds.
 */
export async function reencryptAtRestSecretsToCompletion(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<ReencryptSweepSummary> {
  const totals = emptySummary();
  let cursor: ReencryptCursor | null = null;

  for (;;) {
    const batch = await reencryptAtRestSecrets(db, dataEncryptionSecrets, {
      cursor,
      limit: REENCRYPT_BATCH_SIZE,
    });
    totals.scanned += batch.scanned;
    totals.reencrypted += batch.reencrypted;
    totals.skipped += batch.skipped;
    totals.failed += batch.failed;
    if (batch.completed) {
      return totals;
    }
    cursor = batch.cursor;
    if (cursor === null) {
      return totals;
    }
  }
}
