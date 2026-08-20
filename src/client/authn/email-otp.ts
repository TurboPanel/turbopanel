import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { isExplicitDevelopmentMode } from '../../dev-mode.ts'
import { verification } from '../../lib/db/schema.ts'
import type { OtpType } from '../../lib/email/types.ts'
import {
  ENVELOPE_SCHEME_OTP,
  formatEnvelope,
  parseEnvelope,
} from './envelope.ts'
import { findKeyForVersion, type DerivedSecretsConfig } from './secrets.ts'

export const OTP_IDENTIFIER_PREFIX = 'otp'
export const OTP_ATTEMPTS_IDENTIFIER_PREFIX = 'otp-attempts'
export const MAX_OTP_ATTEMPTS = 3

/**
 * HKDF purpose for OTP verifier HMAC keys ({@link deriveSecretsConfig}).
 * Bumping the purpose invalidates every previously-stored verifier.
 */
export const OTP_VERIFIER_SECRET_PURPOSE = 'email-otp-verifier'

/**
 * Domain-separation context for the OTP verifier HMAC input. Bumping the
 * version suffix invalidates every previously-stored verifier (forced rotation).
 */
const OTP_VERIFIER_CONTEXT = 'turbopanel-email-otp-verifier-v1'

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Fixed-length SHA-256 hex digest so prefixed identifiers stay within varchar(255). */
export async function hashEmailForOtp(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase()
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized),
  )
  return bytesToHex(new Uint8Array(digest))
}

/**
 * Require a server-held OTP verifier keyring. Never fall back to a public
 * digest — a six-digit OTP space is offline-brute-forceable without a secret.
 * Outside explicit development mode a missing key fails closed; in explicit
 * development the same hard failure applies so tests must pass a derived
 * keyring (entrypoint boot always derives one from `TURBOPANEL_SECRETS`).
 */
export function requireOtpVerifierSecrets(
  secrets: DerivedSecretsConfig | undefined,
): DerivedSecretsConfig {
  if (secrets) return secrets
  if (isExplicitDevelopmentMode()) {
    throw new Error(
      'OTP verifier secrets are required in development — deriveSecretsConfig with purpose email-otp-verifier',
    )
  }
  throw new Error(
    'OTP verifier secrets are required (deriveSecretsConfig with purpose email-otp-verifier)',
  )
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!
  }
  return diff === 0
}

/**
 * Derive the at-rest OTP verifier.
 *
 * `verification.value` must never hold the raw OTP: a DB read (backup, replica,
 * log) would otherwise expose a live credential. Instead we store an HMAC-SHA256
 * of the OTP purpose ({@link OTP_VERIFIER_CONTEXT}), the flow `type`, and the
 * email context (`emailHash`), keyed by a server-held secret derived from
 * `TURBOPANEL_SECRETS`. Format:
 * `tpotp.v{keyVersion}.{hmacHex}` — the embedded version selects current or
 * fallback keys during rotation. The {@link MAX_OTP_ATTEMPTS} attempt cap remains
 * the online brute-force defense; the HMAC secret blocks offline attacks on a
 * leaked DB dump.
 *
 * Rollout: any pre-existing plaintext or public-digest row fails HMAC verify
 * and is treated as invalid (the caller re-sends a fresh OTP).
 */
export async function deriveOtpVerifier(
  type: OtpType,
  emailHash: string,
  otp: string,
  secrets: DerivedSecretsConfig,
): Promise<string> {
  const keyring = requireOtpVerifierSecrets(secrets)
  const material = `${OTP_VERIFIER_CONTEXT}:${type}:${emailHash}:${otp}`
  const mac = await crypto.subtle.sign(
    'HMAC',
    keyring.current.key,
    new TextEncoder().encode(material),
  )
  return formatEnvelope(
    ENVELOPE_SCHEME_OTP,
    keyring.current.version,
    bytesToHex(new Uint8Array(mac)),
  )
}

/**
 * Verify a submitted OTP against a stored verifier, trying the versioned key
 * first then falling back across the keyring for rotation.
 */
export async function verifyOtpVerifier(
  type: OtpType,
  emailHash: string,
  otp: string,
  storedVerifier: string,
  secrets: DerivedSecretsConfig,
): Promise<boolean> {
  const keyring = requireOtpVerifierSecrets(secrets)
  const parsed = parseEnvelope(ENVELOPE_SCHEME_OTP, storedVerifier, 1)
  if (parsed === null) return false
  const hmacHex = parsed.fields[0]!
  if (!/^[0-9a-f]+$/i.test(hmacHex)) return false
  const providedMac = hmacHex.toLowerCase()

  const material = `${OTP_VERIFIER_CONTEXT}:${type}:${emailHash}:${otp}`
  const materialBytes = new TextEncoder().encode(material)

  const versionedKey = findKeyForVersion(keyring, parsed.version)
  if (versionedKey) {
    const mac = await crypto.subtle.sign('HMAC', versionedKey, materialBytes)
    if (constantTimeEqual(providedMac, bytesToHex(new Uint8Array(mac)))) {
      return true
    }
  }

  // Rotation safety: if the stored version is unknown/mismatched, still try
  // every keyring entry so a mid-rotation keyring still accepts live OTPs.
  const keysToTry: CryptoKey[] = [
    keyring.current.key,
    ...keyring.fallbacks.map((f) => f.key),
  ]
  for (const key of keysToTry) {
    if (key === versionedKey) continue
    const mac = await crypto.subtle.sign('HMAC', key, materialBytes)
    if (constantTimeEqual(providedMac, bytesToHex(new Uint8Array(mac)))) {
      return true
    }
  }
  return false
}

function otpIdentifier(type: OtpType, emailHash: string): string {
  return `${OTP_IDENTIFIER_PREFIX}:${type}:${emailHash}`
}

function attemptsIdentifier(type: OtpType, emailHash: string): string {
  return `${OTP_ATTEMPTS_IDENTIFIER_PREFIX}:${type}:${emailHash}`
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
  otpVerifierSecrets: DerivedSecretsConfig,
  expiresInSeconds = 300,
  opts?: { cooldownMs?: number },
): Promise<CreateEmailOtpResult> {
  const secrets = requireOtpVerifierSecrets(otpVerifierSecrets)
  const cooldownMs = opts?.cooldownMs ?? OTP_RESEND_COOLDOWN_MS
  const otp = generateOtp()
  const emailHash = await hashEmailForOtp(email)
  // Store only the keyed HMAC verifier at rest — never the raw OTP.
  const verifier = await deriveOtpVerifier(type, emailHash, otp, secrets)
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
        value: verifier,
        expiresAt,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .onConflictDoUpdate({
        target: verification.identifier,
        set: {
          value: verifier,
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
  otpVerifierSecrets: DerivedSecretsConfig,
  opts?: { consume?: boolean },
): Promise<VerifyEmailOtpResult> {
  const secrets = requireOtpVerifierSecrets(otpVerifierSecrets)
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

    const matched = await verifyOtpVerifier(
      type,
      emailHash,
      otp,
      row.value,
      secrets,
    )
    if (!matched) {
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
