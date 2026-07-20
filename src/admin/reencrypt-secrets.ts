/**
 * Superadmin at-rest secret re-encryption sweep.
 *
 * Re-seals only non-current `tpsecret` blobs under `variable.value`,
 * `tls.privateKeyPem`, `principal.password`, and email secret keys in the
 * `SYSTEM_EMAIL` setting row. Variable/TLS/principal sweeps skip `tpdaemon`
 * envelopes and plaintext by construction. Email secret keys that are not
 * valid `tpsecret` envelopes are counted as `failed` (invalid/unsupported).
 *
 * Every write is conditional on the original envelope still being present
 * (compare-and-swap on id + secret column) so a concurrent update during
 * rotation is left untouched rather than overwritten with a stale reseal.
 */

import { and, asc, eq, gt, isNotNull } from 'drizzle-orm'
import {
  decryptSecret,
  encryptSecret,
  parseSecretEnvelope,
} from '../client/authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import type { Db } from '../db.ts'
import { principal, setting, tls, variable } from '../lib/db/schema.ts'
import {
  EMAIL_SECRET_KEYS,
  SYSTEM_EMAIL_DB_KEY,
} from '../lib/settings/email-settings.ts'

export const REENCRYPT_BATCH_SIZE = 200

export type ReencryptSweepSummary = {
  scanned: number
  reencrypted: number
  skipped: number
  failed: number
}

function emptySummary(): ReencryptSweepSummary {
  return { scanned: 0, reencrypted: 0, skipped: 0, failed: 0 }
}

function nowIso(): string {
  return new Date().toISOString()
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
): Promise<void> {
  summary.scanned += 1
  const parsed = parseSecretEnvelope(blob)
  if (parsed === null || parsed.keyVersion === secrets.current.version) {
    summary.skipped += 1
    return
  }

  try {
    const plaintext = await decryptSecret(secrets, blob)
    const resealed = await encryptSecret(secrets, plaintext)
    const applied = await update(resealed)
    if (applied) {
      summary.reencrypted += 1
    } else {
      // Concurrent writer changed the row; leave the newer value untouched.
      summary.skipped += 1
    }
  } catch {
    summary.failed += 1
  }
}

async function sweepSecretVariables(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
): Promise<void> {
  let cursor: string | undefined
  for (;;) {
    const rows = await db
      .select({ id: variable.id, value: variable.value })
      .from(variable)
      .where(
        cursor === undefined
          ? eq(variable.isSecret, true)
          : and(eq(variable.isSecret, true), gt(variable.id, cursor)),
      )
      .orderBy(asc(variable.id))
      .limit(REENCRYPT_BATCH_SIZE)

    if (rows.length === 0) {
      return
    }

    for (const row of rows) {
      const originalValue = row.value
      await processBlob(summary, secrets, originalValue, async (resealed) => {
        const updated = await db
          .update(variable)
          .set({ value: resealed, updatedAt: nowIso() })
          .where(and(eq(variable.id, row.id), eq(variable.value, originalValue)))
          .returning({ id: variable.id })
        return updated.length > 0
      })
    }

    if (rows.length < REENCRYPT_BATCH_SIZE) {
      return
    }
    cursor = rows.at(-1)!.id
  }
}

async function sweepTlsPrivateKeys(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
): Promise<void> {
  let cursor: string | undefined
  for (;;) {
    const rows = await db
      .select({ id: tls.id, privateKeyPem: tls.privateKeyPem })
      .from(tls)
      .where(
        cursor === undefined
          ? isNotNull(tls.privateKeyPem)
          : and(isNotNull(tls.privateKeyPem), gt(tls.id, cursor)),
      )
      .orderBy(asc(tls.id))
      .limit(REENCRYPT_BATCH_SIZE)

    if (rows.length === 0) {
      return
    }

    for (const row of rows) {
      if (row.privateKeyPem === null) {
        continue
      }
      const originalKey = row.privateKeyPem
      await processBlob(summary, secrets, originalKey, async (resealed) => {
        const updated = await db
          .update(tls)
          .set({ privateKeyPem: resealed, updatedAt: nowIso() })
          .where(and(eq(tls.id, row.id), eq(tls.privateKeyPem, originalKey)))
          .returning({ id: tls.id })
        return updated.length > 0
      })
    }

    if (rows.length < REENCRYPT_BATCH_SIZE) {
      return
    }
    cursor = rows.at(-1)!.id
  }
}

async function sweepPrincipalPasswords(
  db: Db,
  secrets: DerivedSecretsConfig,
  summary: ReencryptSweepSummary,
): Promise<void> {
  let cursor: string | undefined
  for (;;) {
    const rows = await db
      .select({ id: principal.id, password: principal.password })
      .from(principal)
      .where(
        cursor === undefined
          ? isNotNull(principal.password)
          : and(isNotNull(principal.password), gt(principal.id, cursor)),
      )
      .orderBy(asc(principal.id))
      .limit(REENCRYPT_BATCH_SIZE)

    if (rows.length === 0) {
      return
    }

    for (const row of rows) {
      if (row.password === null) {
        continue
      }
      const originalPassword = row.password
      await processBlob(summary, secrets, originalPassword, async (resealed) => {
        const updated = await db
          .update(principal)
          .set({ password: resealed, updatedAt: nowIso() })
          .where(
            and(eq(principal.id, row.id), eq(principal.password, originalPassword)),
          )
          .returning({ id: principal.id })
        return updated.length > 0
      })
    }

    if (rows.length < REENCRYPT_BATCH_SIZE) {
      return
    }
    cursor = rows.at(-1)!.id
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
    .limit(1)

  const original = rows[0]?.value
  if (
    original === undefined ||
    original === null ||
    typeof original !== 'object' ||
    Array.isArray(original)
  ) {
    return
  }

  const originalObj = original as Record<string, unknown>
  const nextObj: Record<string, unknown> = { ...originalObj }
  let resealedCount = 0

  for (const shortKey of EMAIL_SECRET_KEYS) {
    const raw = nextObj[shortKey]
    if (typeof raw !== 'string' || raw === '') continue

    summary.scanned += 1
    const parsed = parseSecretEnvelope(raw)
    if (parsed === null) {
      // Plaintext or other non-tpsecret material is invalid at rest.
      summary.failed += 1
      continue
    }
    if (parsed.keyVersion === secrets.current.version) {
      summary.skipped += 1
      continue
    }

    try {
      const plaintext = await decryptSecret(secrets, raw)
      nextObj[shortKey] = await encryptSecret(secrets, plaintext)
      resealedCount += 1
    } catch {
      summary.failed += 1
    }
  }

  if (resealedCount === 0) return

  const updated = await db
    .update(setting)
    .set({ value: nextObj, updatedAt: nowIso() })
    .where(and(eq(setting.key, SYSTEM_EMAIL_DB_KEY), eq(setting.value, original)))
    .returning({ key: setting.key })

  if (updated.length > 0) {
    summary.reencrypted += resealedCount
  } else {
    // Concurrent writer changed the row; leave the newer values untouched.
    summary.skipped += resealedCount
  }
}

export async function reencryptAtRestSecrets(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<ReencryptSweepSummary> {
  const summary = emptySummary()
  await sweepSecretVariables(db, dataEncryptionSecrets, summary)
  await sweepTlsPrivateKeys(db, dataEncryptionSecrets, summary)
  await sweepPrincipalPasswords(db, dataEncryptionSecrets, summary)
  await sweepEmailSettingSecrets(db, dataEncryptionSecrets, summary)
  return summary
}
