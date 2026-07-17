import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { verification } from '../../lib/db/schema.ts'
import type { OtpType } from '../../lib/email/types.ts'

export const OTP_IDENTIFIER_PREFIX = 'otp'
export const OTP_ATTEMPTS_IDENTIFIER_PREFIX = 'otp-attempts'
export const MAX_OTP_ATTEMPTS = 3
/**
 * Minimum interval between OTP (re)sends for the same identifier. Prevents an
 * attacker from calling `createEmailOtp()` repeatedly to wipe the attempts
 * counter (which would otherwise defeat {@link MAX_OTP_ATTEMPTS}).
 */
export const OTP_RESEND_COOLDOWN_MS = 30_000

function nowTs(): string {
  return new Date().toISOString()
}

function randomDigit(): number {
  const bytes = new Uint8Array(1)
  while (true) {
    crypto.getRandomValues(bytes)
    if (bytes[0] < 250) return bytes[0] % 10
  }
}

export function generateOtp(length = 6): string {
  let otp = ''
  for (let i = 0; i < length; i++) {
    otp += String(randomDigit())
  }
  return otp
}

/** Fixed-length SHA-256 hex digest so prefixed identifiers stay within varchar(255). */
export async function hashEmailForOtp(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase()
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized),
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function otpIdentifier(type: OtpType, emailHash: string): string {
  return `${OTP_IDENTIFIER_PREFIX}:${type}:${emailHash}`
}

function attemptsIdentifier(type: OtpType, emailHash: string): string {
  return `${OTP_ATTEMPTS_IDENTIFIER_PREFIX}:${type}:${emailHash}`
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i]
  }
  return diff === 0
}

export type CreateEmailOtpResult =
  | { status: 'created'; otp: string }
  | { status: 'cooldown'; retryAfterSeconds: number }

/**
 * Create a fresh OTP for `email`/`type`, replacing any existing OTP and its
 * attempts counter.
 *
 * A resend cooldown ({@link OTP_RESEND_COOLDOWN_MS}) prevents callers from
 * resetting the attempts counter indefinitely — while an unexpired OTP is still
 * inside its cooldown window, this returns `{ status: 'cooldown' }` and leaves
 * both the OTP and the attempts row untouched.
 *
 * Relies on the unique constraint on `verification.identifier` plus a
 * transaction + `FOR UPDATE` so concurrent first-time creates cannot race into
 * duplicate active OTP rows; writes use an atomic upsert.
 */
export async function createEmailOtp(
  db: Db,
  email: string,
  type: OtpType,
  expiresInSeconds = 300,
  opts?: { cooldownMs?: number },
): Promise<CreateEmailOtpResult> {
  const cooldownMs = opts?.cooldownMs ?? OTP_RESEND_COOLDOWN_MS
  const otp = generateOtp()
  const emailHash = await hashEmailForOtp(email)
  const identifier = otpIdentifier(type, emailHash)
  const attemptsId = attemptsIdentifier(type, emailHash)
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString()

  return await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: verification.id,
        createdAt: verification.createdAt,
        expiresAt: verification.expiresAt,
      })
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .for('update')
      .limit(1)

    const current = existing[0]
    // Compare as Date — Postgres returns `YYYY-MM-DD HH:MM:SS+00` which is not
    // lexicographically ordered against ISO-8601 `nowTs()` (`…T…Z`).
    if (
      current &&
      new Date(current.expiresAt).getTime() > Date.now() &&
      cooldownMs > 0
    ) {
      const ageMs = Date.now() - new Date(current.createdAt).getTime()
      if (ageMs < cooldownMs) {
        return {
          status: 'cooldown',
          retryAfterSeconds: Math.ceil((cooldownMs - ageMs) / 1000),
        }
      }
    }

    const stamp = nowTs()
    await tx
      .insert(verification)
      .values({
        identifier,
        value: otp,
        expiresAt,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .onConflictDoUpdate({
        target: verification.identifier,
        set: {
          value: otp,
          expiresAt,
          // Reset the cooldown clock when replacing an expired/cooled-down OTP.
          createdAt: stamp,
          updatedAt: stamp,
        },
      })

    // Reset attempts under the same uniqueness rule (delete-or-absent).
    await tx.delete(verification).where(eq(verification.identifier, attemptsId))

    return { status: 'created', otp }
  })
}

export type VerifyEmailOtpResult =
  | 'ok'
  | 'invalid'
  | 'expired'
  | 'too_many_attempts'

/**
 * Verify an OTP for `email`/`type`.
 *
 * Runs inside a transaction that selects the OTP row `FOR UPDATE`, so
 * concurrent verifications serialize on that lock and the attempts counter is
 * updated atomically (no lost increments under concurrency). Returns
 * `too_many_attempts` once {@link MAX_OTP_ATTEMPTS} failed attempts accumulate.
 */
export async function verifyEmailOtp(
  db: Db,
  email: string,
  type: OtpType,
  otp: string,
  opts?: { consume?: boolean },
): Promise<VerifyEmailOtpResult> {
  const consume = opts?.consume !== false
  const emailHash = await hashEmailForOtp(email)
  const identifier = otpIdentifier(type, emailHash)
  const attemptsId = attemptsIdentifier(type, emailHash)

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: verification.id,
        value: verification.value,
        expiresAt: verification.expiresAt,
      })
      .from(verification)
      .where(eq(verification.identifier, identifier))
      .for('update')
      .limit(1)

    const row = rows[0]
    if (!row) {
      return 'invalid'
    }

    // Date compare — do not lexicographically compare Postgres vs ISO strings.
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      await tx.delete(verification).where(eq(verification.id, row.id))
      return 'expired'
    }

    const attemptsRows = await tx
      .select({ id: verification.id, value: verification.value })
      .from(verification)
      .where(eq(verification.identifier, attemptsId))
      .for('update')
      .limit(1)

    const attempts = Number.parseInt(attemptsRows[0]?.value ?? '0', 10)
    if (attempts >= MAX_OTP_ATTEMPTS) {
      return 'too_many_attempts'
    }

    if (!constantTimeEqual(row.value, otp)) {
      const nextAttempts = attempts + 1
      const stamp = nowTs()
      // Upsert under the unique identifier constraint so concurrent verifiers
      // cannot create duplicate attempts rows; FOR UPDATE above serializes
      // increments on an existing row.
      await tx
        .insert(verification)
        .values({
          identifier: attemptsId,
          value: String(nextAttempts),
          expiresAt: row.expiresAt,
        })
        .onConflictDoUpdate({
          target: verification.identifier,
          set: {
            value: String(nextAttempts),
            expiresAt: row.expiresAt,
            updatedAt: stamp,
          },
        })
      return 'invalid'
    }

    if (consume) {
      await tx.delete(verification).where(eq(verification.identifier, identifier))
      await tx.delete(verification).where(eq(verification.identifier, attemptsId))
    }

    return 'ok'
  })
}
