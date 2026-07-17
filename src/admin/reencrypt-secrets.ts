/**
 * Superadmin at-rest secret re-encryption sweep.
 *
 * Re-seals only non-current `tpsecret` blobs under `variable.value`,
 * `tls.privateKeyPem`, and `principal.password`. Never touches `tpdaemon`
 * envelopes or plaintext — those are skipped by construction.
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
import { principal, tls, variable } from '../lib/db/schema.ts'

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
    cursor = rows[rows.length - 1]!.id
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
    cursor = rows[rows.length - 1]!.id
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
    cursor = rows[rows.length - 1]!.id
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
  return summary
}
