/**
 * Superadmin at-rest secret re-encryption sweep.
 *
 * Re-seals `variable.value` (is_secret), `tls.privateKeyPem`,
 * `principal.password`, `storage.content_envelope`, `secret.secret_envelope`,
 * `forge.envelopes` (private key / client secret / webhook secret),
 * `connection.oauth_envelope` (GitLab access/refresh token pair), `2fa.secret`,
 * `SYSTEM_AUTH_PROVIDERS` secret keys, and email secret keys in the
 * `SYSTEM_EMAIL` setting row onto the current data-encryption key version.
 *
 * Per-blob rules (variable / TLS / principal / storage / secret / forge / gitConnection / twofactor / authproviders / email secrets):
 * - Valid daemon-bound `tpdaemon` → skipped (delivery envelopes are not at-rest
 *   material for this sweep; variables/TLS/principals only).
 * - Malformed `tpdaemon` or malformed `tpsecret` → failed.
 * - Non-envelope plaintext → failed (never auto-migrated).
 * - Current-version `tpsecret` → skipped.
 * - Older-version `tpsecret` → decrypt + re-seal; decrypt failures → failed.
 *
 * Email secret keys (`MAILGUN_API_KEY` / `SMTP_PASS`) and auth-provider secret
 * keys (`GITHUB_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET`) follow the same
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

import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
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
  forge,
  gitConnection,
  lease,
  principal,
  secret,
  setting,
  storage,
  tls,
  notificationChannel,
  twoFactor,
  variable,
} from "../lib/db/schema.ts";
import {
  EMAIL_SECRET_KEYS,
  SYSTEM_EMAIL_DB_KEY,
} from "../lib/settings/email-settings.ts";
import {
  AUTH_PROVIDER_SECRET_KEYS,
  SYSTEM_AUTH_PROVIDERS_DB_KEY,
} from "../lib/settings/auth-provider-settings.ts";

export const REENCRYPT_BATCH_SIZE = 200;

/**
 * `lease.name` for the cross-isolate re-encrypt sweep lease — globally
 * scoped (schema-child-tables, Road-to-0.1.x — promoted out of `setting`).
 */
export const REENCRYPT_SWEEP_LOCK_KEY = "REENCRYPT_SWEEP_LOCK";

/** Lease TTL so a crashed isolate cannot block sweeps indefinitely. */
export const REENCRYPT_SWEEP_LEASE_MS = 120_000;

export type ReencryptSweepLock = Readonly<{
  owner: string;
}>;

export const REENCRYPT_STAGES = [
  "variables",
  "tls",
  "principals",
  "storage",
  "secrets",
  "forge",
  "gitconnection",
  "twofactor",
  "notifications",
  "authproviders",
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

function sweepLockIsExpired(expiresAt: string, nowMs = Date.now()): boolean {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return true;
  return expires <= nowMs;
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
  const expiresAt = new Date(nowMs + REENCRYPT_SWEEP_LEASE_MS).toISOString();

  const inserted = await db
    .insert(lease)
    .values({
      name: REENCRYPT_SWEEP_LOCK_KEY,
      organizationId: null,
      owner,
      expiresAt,
    })
    .onConflictDoNothing({ target: [lease.name, lease.organizationId] })
    .returning({ id: lease.id });
  if (inserted.length > 0) {
    return { owner };
  }

  const [existing] = await db
    .select({ owner: lease.owner, expiresAt: lease.expiresAt })
    .from(lease)
    .where(
      and(eq(lease.name, REENCRYPT_SWEEP_LOCK_KEY), isNull(lease.organizationId)),
    )
    .limit(1);
  if (!existing || !sweepLockIsExpired(existing.expiresAt, nowMs)) {
    return null;
  }

  const stolen = await db
    .update(lease)
    .set({ owner, expiresAt, updatedAt: nowIso() })
    .where(
      and(
        eq(lease.name, REENCRYPT_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, existing.owner),
        eq(lease.expiresAt, existing.expiresAt),
      ),
    )
    .returning({ id: lease.id });
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
    .delete(lease)
    .where(
      and(
        eq(lease.name, REENCRYPT_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, lock.owner),
      ),
    );
}

/** Test-only: drop the durable sweep lock row when `db` is provided. */
export async function resetReencryptSweepLockForTests(db?: Db): Promise<void> {
  if (!db) return;
  await db
    .delete(lease)
    .where(
      and(eq(lease.name, REENCRYPT_SWEEP_LOCK_KEY), isNull(lease.organizationId)),
    );
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

async function sweepSecretTableBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({ id: secret.id, secretEnvelope: secret.secretEnvelope })
    .from(secret)
    .where(
      afterId === undefined
        ? isNotNull(secret.secretEnvelope)
        : and(isNotNull(secret.secretEnvelope), gt(secret.id, afterId)),
    )
    .orderBy(asc(secret.id))
    .limit(limit);

  for (const row of rows) {
    const original = row.secretEnvelope;
    await processBlob(
      summary,
      secrets,
      original,
      async (resealed) => {
        const updated = await db
          .update(secret)
          .set({ secretEnvelope: resealed, updatedAt: nowIso() })
          .where(
            and(
              eq(secret.id, row.id),
              eq(secret.secretEnvelope, original),
            ),
          )
          .returning({ id: secret.id });
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

/** `forge.envelopes` keys holding `tpsecret` material (see schema.ts). */
const FORGE_ENVELOPE_KEYS = [
  "privateKeyEnvelope",
  "clientSecretEnvelope",
  "webhookSecretEnvelope",
] as const;

/** `connection.oauth_envelope` keys holding `tpsecret` material (GitLab only). */
const GITCONNECTION_ENVELOPE_KEYS = [
  "accessTokenEnvelope",
  "refreshTokenEnvelope",
] as const;

/**
 * Re-seal the `tpsecret` values at `keys` inside a single row's jsonb
 * envelope object. Same per-key rules and single-row compare-and-swap as
 * {@link sweepAuthProviderSettingSecrets} / {@link sweepEmailSettingSecrets},
 * generalized to any row (not just a `setting` row) via `update`.
 */
async function resealJsonbEnvelopeRow(
  summary: ReencryptSweepSummary,
  secrets: DerivedSecretsConfig,
  original: unknown,
  keys: readonly string[],
  update: (next: Record<string, unknown>) => Promise<boolean>,
): Promise<void> {
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

  for (const key of keys) {
    const raw = nextObj[key];
    if (typeof raw !== "string" || raw === "") continue;

    summary.scanned += 1;
    const parsed = parseSecretEnvelope(raw);
    if (parsed === null) {
      // Plaintext or malformed — invalid/unsupported for these envelopes at rest.
      summary.failed += 1;
      continue;
    }
    if (parsed.keyVersion === secrets.current.version) {
      summary.skipped += 1;
      continue;
    }

    try {
      const plaintext = await decryptSecret(secrets, raw);
      nextObj[key] = await encryptSecret(secrets, plaintext);
      resealedCount += 1;
    } catch {
      summary.failed += 1;
    }
  }

  if (resealedCount === 0) return;

  const applied = await update(nextObj);
  if (applied) {
    summary.reencrypted += resealedCount;
  } else {
    // Concurrent writer changed the row; leave the newer values untouched.
    summary.skipped += resealedCount;
  }
}

async function sweepForgeEnvelopesBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({ id: forge.id, envelopes: forge.envelopes })
    .from(forge)
    .where(afterId === undefined ? sql`true` : gt(forge.id, afterId))
    .orderBy(asc(forge.id))
    .limit(limit);

  for (const row of rows) {
    const original = row.envelopes;
    await resealJsonbEnvelopeRow(
      summary,
      secrets,
      original,
      FORGE_ENVELOPE_KEYS,
      async (resealed) => {
        const updated = await db
          .update(forge)
          .set({ envelopes: resealed, updatedAt: nowIso() })
          .where(and(eq(forge.id, row.id), eq(forge.envelopes, original)))
          .returning({ id: forge.id });
        return updated.length > 0;
      },
    );
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  };
}

async function sweepGitConnectionEnvelopesBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({
      id: gitConnection.id,
      oauthEnvelope: gitConnection.oauthEnvelope,
    })
    .from(gitConnection)
    .where(
      afterId === undefined ? isNotNull(gitConnection.oauthEnvelope) : and(
        isNotNull(gitConnection.oauthEnvelope),
        gt(gitConnection.id, afterId),
      ),
    )
    .orderBy(asc(gitConnection.id))
    .limit(limit);

  for (const row of rows) {
    if (row.oauthEnvelope === null) {
      continue;
    }
    const original = row.oauthEnvelope;
    await resealJsonbEnvelopeRow(
      summary,
      secrets,
      original,
      GITCONNECTION_ENVELOPE_KEYS,
      async (resealed) => {
        const updated = await db
          .update(gitConnection)
          .set({ oauthEnvelope: resealed, updatedAt: nowIso() })
          .where(
            and(
              eq(gitConnection.id, row.id),
              eq(gitConnection.oauthEnvelope, original),
            ),
          )
          .returning({ id: gitConnection.id });
        return updated.length > 0;
      },
    );
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  };
}

async function sweepTwoFactorSecretsBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({ id: twoFactor.id, secret: twoFactor.secret })
    .from(twoFactor)
    .where(
      afterId === undefined
        ? isNotNull(twoFactor.secret)
        : and(isNotNull(twoFactor.secret), gt(twoFactor.id, afterId)),
    )
    .orderBy(asc(twoFactor.id))
    .limit(limit);

  for (const row of rows) {
    const original = row.secret;
    await processBlob(
      summary,
      secrets,
      original,
      async (resealed) => {
        const updated = await db
          .update(twoFactor)
          .set({ secret: resealed })
          .where(
            and(
              eq(twoFactor.id, row.id),
              eq(twoFactor.secret, original),
            ),
          )
          .returning({ id: twoFactor.id });
        return updated.length > 0;
      },
      { allowDaemonBound: false },
    );
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  };
}

/**
 * Notification channels: the `address` of every kind but `email` is a sealed
 * credential (a webhook URL, a push token), and `signing_secret` always is.
 * Two blobs per row, each compare-and-swapped on its own column.
 */
async function sweepNotificationChannelSecretsBatch(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  afterId: string | undefined,
  limit: number,
): Promise<StageBatchResult> {
  const rows = await db
    .select({
      id: notificationChannel.id,
      kind: notificationChannel.kind,
      address: notificationChannel.address,
      signingSecret: notificationChannel.signingSecret,
    })
    .from(notificationChannel)
    .where(afterId === undefined ? undefined : gt(notificationChannel.id, afterId))
    .orderBy(asc(notificationChannel.id))
    .limit(limit);

  for (const row of rows) {
    if (row.kind !== "email") {
      const original = row.address;
      await processBlob(
        summary,
        secrets,
        original,
        async (resealed) => {
          const updated = await db
            .update(notificationChannel)
            .set({ address: resealed })
            .where(
              and(
                eq(notificationChannel.id, row.id),
                eq(notificationChannel.address, original),
              ),
            )
            .returning({ id: notificationChannel.id });
          return updated.length > 0;
        },
        { allowDaemonBound: false },
      );
    }
    if (row.signingSecret) {
      const original = row.signingSecret;
      await processBlob(
        summary,
        secrets,
        original,
        async (resealed) => {
          const updated = await db
            .update(notificationChannel)
            .set({ signingSecret: resealed })
            .where(
              and(
                eq(notificationChannel.id, row.id),
                eq(notificationChannel.signingSecret, original),
              ),
            )
            .returning({ id: notificationChannel.id });
          return updated.length > 0;
        },
        { allowDaemonBound: false },
      );
    }
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  };
}

/**
 * Re-seal `GITHUB_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET` in the single
 * `SYSTEM_AUTH_PROVIDERS` settings row. All provider secrets live in one JSON
 * `setting.value`, so a single compare-and-swap on the whole row persists
 * every resealed key at once; a concurrent writer that changed the row leaves
 * the reseals uncounted (skipped).
 */
async function sweepAuthProviderSettingSecrets(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
): Promise<void> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, SYSTEM_AUTH_PROVIDERS_DB_KEY))
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

  for (const shortKey of AUTH_PROVIDER_SECRET_KEYS) {
    const raw = nextObj[shortKey];
    if (typeof raw !== "string" || raw === "") continue;

    summary.scanned += 1;
    const parsed = parseSecretEnvelope(raw);
    if (parsed === null) {
      // Plaintext, tpdaemon, or malformed — invalid/unsupported for auth providers at rest.
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
      and(
        eq(setting.key, SYSTEM_AUTH_PROVIDERS_DB_KEY),
        eq(setting.value, original),
      ),
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

type TableStage = Exclude<ReencryptStage, "authproviders" | "email">;

async function runTableStageBatch(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
  stage: TableStage,
  afterId: string | undefined,
  remaining: number,
): Promise<StageBatchResult> {
  switch (stage) {
    case "variables":
      return sweepSecretVariablesBatch(
        db,
        dataEncryptionSecrets,
        summary,
        afterId,
        remaining,
      );
    case "tls":
      return sweepTlsPrivateKeysBatch(
        db,
        dataEncryptionSecrets,
        summary,
        afterId,
        remaining,
      );
    case "principals":
      return sweepPrincipalPasswordsBatch(
        db,
        dataEncryptionSecrets,
        summary,
        afterId,
        remaining,
      );
    case "storage":
      return sweepStorageContentBatch(
        db,
        dataEncryptionSecrets,
        summary,
        afterId,
        remaining,
      );
    case "secrets":
      return sweepSecretTableBatch(
        db,
        dataEncryptionSecrets,
        summary,
        afterId,
        remaining,
      );
    case "forge":
      return sweepForgeEnvelopesBatch(
        db,
        dataEncryptionSecrets,
        summary,
        afterId,
        remaining,
      );
    case "gitconnection":
      return sweepGitConnectionEnvelopesBatch(
        db,
        dataEncryptionSecrets,
        summary,
        afterId,
        remaining,
      );
    case "twofactor":
      return sweepTwoFactorSecretsBatch(
        db,
        dataEncryptionSecrets,
        summary,
        afterId,
        remaining,
      );
    case "notifications":
      return sweepNotificationChannelSecretsBatch(
        db,
        dataEncryptionSecrets,
        summary,
        afterId,
        remaining,
      );
  }
}

type BatchOutcome =
  | { kind: "continue"; cursor: ReencryptCursor }
  | { kind: "done"; result: ReencryptSweepResult };

/** Decide whether the sweep advances to the next stage, stops for now, or completes. */
function resolveBatchOutcome(
  summary: ReencryptSweepSummary,
  cursor: ReencryptCursor,
  batch: StageBatchResult,
  requested: number,
): BatchOutcome {
  if (batch.pageSize === 0 || batch.pageSize < requested) {
    // No more rows in this stage — advance to the next (email when table stages end).
    const following = nextStage(cursor.stage);
    if (following === null) {
      return {
        kind: "done",
        result: { ...summary, completed: true, cursor: null },
      };
    }
    return { kind: "continue", cursor: { stage: following } };
  }

  // Full page consumed the remaining budget; more rows may exist.
  return {
    kind: "done",
    result: {
      ...summary,
      completed: false,
      cursor: {
        stage: cursor.stage,
        ...(batch.lastId ? { afterId: batch.lastId } : {}),
      },
    },
  };
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
    if (cursor.stage === "authproviders") {
      await sweepAuthProviderSettingSecrets(db, dataEncryptionSecrets, summary);
      cursor = { stage: "email" };
      continue;
    }

    if (cursor.stage === "email") {
      await sweepEmailSettingSecrets(db, dataEncryptionSecrets, summary);
      return { ...summary, completed: true, cursor: null };
    }

    const batch = await runTableStageBatch(
      db,
      dataEncryptionSecrets,
      summary,
      cursor.stage,
      cursor.afterId,
      remaining,
    );

    const requested = remaining;
    remaining -= batch.pageSize;

    const outcome = resolveBatchOutcome(summary, cursor, batch, requested);
    if (outcome.kind === "done") return outcome.result;
    cursor = outcome.cursor;
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
