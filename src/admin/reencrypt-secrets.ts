/**
 * Superadmin at-rest secret re-encryption sweep.
 *
 * Re-seals `variable.value` (is_secret), `tls.privateKeyPem`,
 * `principal.password`, and email secret keys in the `SYSTEM_EMAIL` setting
 * row onto the current data-encryption key version.
 *
 * Per-blob rules (variable / TLS / principal):
 * - Valid daemon-bound `denc` → skipped (delivery envelopes are not at-rest
 *   material for this sweep).
 * - Malformed `denc` or malformed `enc` → failed.
 * - Plaintext → re-sealed under the current `enc` key (column semantics mark
 *   the value as a secret).
 * - Current-version `enc` → skipped.
 * - Older-version `enc` → decrypt + re-seal; decrypt failures → failed.
 *
 * Email secret keys (`MAILGUN_API_KEY` / `SMTP_PASS`) that are not valid `enc`
 * envelopes are counted as `failed` (invalid/unsupported) — they are not
 * auto-migrated from plaintext.
 *
 * Sweeps are **bounded**: each call processes at most `limit` blobs (default
 * {@link REENCRYPT_BATCH_SIZE}) and returns a resume cursor until
 * `completed: true`. A process-local in-progress guard rejects concurrent
 * sweeps with {@link tryBeginReencryptSweep}.
 *
 * Every write is conditional on the original envelope still being present
 * (compare-and-swap on id + secret column) so a concurrent update during
 * rotation is left untouched rather than overwritten with a stale reseal.
 */

import { and, asc, eq, gt, isNotNull } from 'drizzle-orm'
import {
  ENVELOPE_MAGIC,
  encryptSecret,
  decryptSecret,
  isDaemonSealedEnvelope,
  parseDaemonSecretEnvelope,
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

export const REENCRYPT_STAGES = [
  'variables',
  'tls',
  'principals',
  'email',
] as const

export type ReencryptStage = (typeof REENCRYPT_STAGES)[number]

export type ReencryptCursor = {
  stage: ReencryptStage
  /** Last processed row id within `stage` (exclusive lower bound for the next page). */
  afterId?: string
}

export type ReencryptSweepSummary = {
  scanned: number
  reencrypted: number
  skipped: number
  failed: number
}

export type ReencryptSweepResult = ReencryptSweepSummary & {
  completed: boolean
  cursor: ReencryptCursor | null
}

export type ReencryptSweepOptions = Readonly<{
  cursor?: ReencryptCursor | null
  /** Max blobs to scan in this call (default {@link REENCRYPT_BATCH_SIZE}). */
  limit?: number
}>

function emptySummary(): ReencryptSweepSummary {
  return { scanned: 0, reencrypted: 0, skipped: 0, failed: 0 }
}

function nowIso(): string {
  return new Date().toISOString()
}

function nextStage(stage: ReencryptStage): ReencryptStage | null {
  const index = REENCRYPT_STAGES.indexOf(stage)
  if (index < 0 || index >= REENCRYPT_STAGES.length - 1) {
    return null
  }
  return REENCRYPT_STAGES[index + 1]!
}

function normalizeCursor(cursor: ReencryptCursor | null | undefined): ReencryptCursor {
  if (!cursor || !REENCRYPT_STAGES.includes(cursor.stage)) {
    return { stage: 'variables' }
  }
  return {
    stage: cursor.stage,
    ...(cursor.afterId ? { afterId: cursor.afterId } : {}),
  }
}

/** Process-local guard so two sweeps cannot run concurrently in this isolate. */
let reencryptSweepInProgress = false

/**
 * Acquire the sweep lock. Returns `false` when another sweep is already running.
 * Callers that receive `true` **must** call {@link endReencryptSweep} in `finally`.
 */
export function tryBeginReencryptSweep(): boolean {
  if (reencryptSweepInProgress) {
    return false
  }
  reencryptSweepInProgress = true
  return true
}

export function endReencryptSweep(): void {
  reencryptSweepInProgress = false
}

/** Test-only: reset the in-progress guard between suites. */
export function resetReencryptSweepLockForTests(): void {
  reencryptSweepInProgress = false
}

type ProcessBlobOptions = Readonly<{
  /** Skip valid daemon-bound `denc` envelopes (variable/TLS/principal paths). */
  allowDaemonBound: boolean
  /** Re-seal non-envelope plaintext under the current `enc` key. */
  resealPlaintext: boolean
}>

async function applyResealedBlob(
  summary: ReencryptSweepSummary,
  update: (resealed: string) => Promise<boolean>,
  resealed: string,
): Promise<void> {
  const applied = await update(resealed)
  if (applied) {
    summary.reencrypted += 1
  } else {
    // Concurrent writer changed the row; leave the newer value untouched.
    summary.skipped += 1
  }
}

/**
 * Classify non-`enc` material before any decrypt/reseal work.
 * Returns a terminal outcome, or `null` when the caller should treat `blob` as
 * an older-version `enc` envelope to decrypt.
 */
function classifyBlobForSweep(
  blob: string,
  currentKeyVersion: number,
  options: ProcessBlobOptions,
): 'skip' | 'fail' | 'reseal-plaintext' | null {
  const daemonParsed = parseDaemonSecretEnvelope(blob)
  if (daemonParsed !== null) {
    return options.allowDaemonBound ? 'skip' : 'fail'
  }
  if (isDaemonSealedEnvelope(blob)) {
    // Malformed daemon envelope — not intentional `denc` material.
    return 'fail'
  }

  const parsed = parseSecretEnvelope(blob)
  if (parsed !== null) {
    return parsed.keyVersion === currentKeyVersion ? 'skip' : null
  }

  if (blob.startsWith(`${ENVELOPE_MAGIC}.`)) {
    // Looks like `enc` but failed structural parse → malformed at-rest material.
    return 'fail'
  }

  return options.resealPlaintext ? 'reseal-plaintext' : 'fail'
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
  summary.scanned += 1

  const classification = classifyBlobForSweep(
    blob,
    secrets.current.version,
    options,
  )
  if (classification === 'skip') {
    summary.skipped += 1
    return
  }
  if (classification === 'fail') {
    summary.failed += 1
    return
  }

  try {
    const plaintext = classification === 'reseal-plaintext'
      ? blob
      : await decryptSecret(secrets, blob)
    const resealed = await encryptSecret(secrets, plaintext)
    await applyResealedBlob(summary, update, resealed)
  } catch {
    summary.failed += 1
  }
}

type StageBatchResult = {
  /** Rows examined in this page (may be less than scanned when null columns skipped). */
  pageSize: number
  lastId: string | undefined
}

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
    .limit(limit)

  for (const row of rows) {
    const originalValue = row.value
    await processBlob(
      summary,
      secrets,
      originalValue,
      async (resealed) => {
        const updated = await db
          .update(variable)
          .set({ value: resealed, updatedAt: nowIso() })
          .where(and(eq(variable.id, row.id), eq(variable.value, originalValue)))
          .returning({ id: variable.id })
        return updated.length > 0
      },
      { allowDaemonBound: true, resealPlaintext: true },
    )
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  }
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
    .limit(limit)

  for (const row of rows) {
    if (row.privateKeyPem === null) {
      continue
    }
    const originalKey = row.privateKeyPem
    await processBlob(
      summary,
      secrets,
      originalKey,
      async (resealed) => {
        const updated = await db
          .update(tls)
          .set({ privateKeyPem: resealed, updatedAt: nowIso() })
          .where(and(eq(tls.id, row.id), eq(tls.privateKeyPem, originalKey)))
          .returning({ id: tls.id })
        return updated.length > 0
      },
      { allowDaemonBound: true, resealPlaintext: true },
    )
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
  }
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
    .limit(limit)

  for (const row of rows) {
    if (row.password === null) {
      continue
    }
    const originalPassword = row.password
    await processBlob(
      summary,
      secrets,
      originalPassword,
      async (resealed) => {
        const updated = await db
          .update(principal)
          .set({ password: resealed, updatedAt: nowIso() })
          .where(
            and(eq(principal.id, row.id), eq(principal.password, originalPassword)),
          )
          .returning({ id: principal.id })
        return updated.length > 0
      },
      { allowDaemonBound: true, resealPlaintext: true },
    )
  }

  return {
    pageSize: rows.length,
    lastId: rows.at(-1)?.id,
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
      // Plaintext, denc, or malformed — invalid/unsupported for email at rest.
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
  const limit = options.limit ?? REENCRYPT_BATCH_SIZE
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('reencrypt limit must be a positive integer')
  }

  const summary = emptySummary()
  let cursor = normalizeCursor(options.cursor)
  let remaining = limit

  while (remaining > 0) {
    if (cursor.stage === 'email') {
      await sweepEmailSettingSecrets(db, dataEncryptionSecrets, summary)
      return { ...summary, completed: true, cursor: null }
    }

    let batch: StageBatchResult
    switch (cursor.stage) {
      case 'variables':
        batch = await sweepSecretVariablesBatch(
          db,
          dataEncryptionSecrets,
          summary,
          cursor.afterId,
          remaining,
        )
        break
      case 'tls':
        batch = await sweepTlsPrivateKeysBatch(
          db,
          dataEncryptionSecrets,
          summary,
          cursor.afterId,
          remaining,
        )
        break
      case 'principals':
        batch = await sweepPrincipalPasswordsBatch(
          db,
          dataEncryptionSecrets,
          summary,
          cursor.afterId,
          remaining,
        )
        break
    }

    const requested = remaining
    remaining -= batch.pageSize

    if (batch.pageSize === 0 || batch.pageSize < requested) {
      // No more rows in this stage — advance to the next (email when principals end).
      const following = nextStage(cursor.stage)
      if (following === null) {
        return { ...summary, completed: true, cursor: null }
      }
      cursor = { stage: following }
      continue
    }

    // Full page consumed the remaining budget; more rows may exist.
    return {
      ...summary,
      completed: false,
      cursor: {
        stage: cursor.stage,
        ...(batch.lastId ? { afterId: batch.lastId } : {}),
      },
    }
  }

  return {
    ...summary,
    completed: false,
    cursor: {
      stage: cursor.stage,
      ...(cursor.afterId ? { afterId: cursor.afterId } : {}),
    },
  }
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
  const totals = emptySummary()
  let cursor: ReencryptCursor | null = null

  for (;;) {
    const batch = await reencryptAtRestSecrets(db, dataEncryptionSecrets, {
      cursor,
      limit: REENCRYPT_BATCH_SIZE,
    })
    totals.scanned += batch.scanned
    totals.reencrypted += batch.reencrypted
    totals.skipped += batch.skipped
    totals.failed += batch.failed
    if (batch.completed) {
      return totals
    }
    cursor = batch.cursor
    if (cursor === null) {
      return totals
    }
  }
}
