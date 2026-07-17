import { and, eq, gt } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { verification } from '../../lib/db/schema.ts'

/** 24 hours — email verification tokens are short-lived. */
const EMAIL_VERIFICATION_EXPIRES_IN_MS = 24 * 60 * 60 * 1000

/**
 * Domain-separation context for the email-verification-token verifier digest.
 * Bumping the version suffix invalidates every previously-stored digest
 * (forced rotation).
 */
const EMAIL_VERIFICATION_VERIFIER_CONTEXT =
  'turbopanel-email-verification-verifier-v1'

function nowTs(): string {
  return new Date().toISOString()
}

/** 32 random bytes encoded as lowercase hex (64 chars). */
function generateEmailVerificationToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Derive the at-rest verifier digest for an email verification link token.
 *
 * `verification.value` must never hold the raw token: a DB read (backup,
 * replica, log) would otherwise expose a live credential that anyone could
 * present to the verify-email route. Instead we store a SHA-256 digest bound to
 * the token purpose ({@link EMAIL_VERIFICATION_VERIFIER_CONTEXT}) and compare an
 * incoming token against the re-derived digest. The token is 256 bits of
 * entropy, so a fast preimage-resistant digest is sufficient (no salt / slow
 * hash needed) and lets us look the row up directly by digest.
 *
 * Rollout: any pre-existing plaintext row simply fails the digest lookup and is
 * treated as invalid (the user must request a fresh verification link).
 */
async function deriveEmailVerificationVerifier(token: string): Promise<string> {
  const material = `${EMAIL_VERIFICATION_VERIFIER_CONTEXT}:${token}`
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material),
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Create (or replace) the email verification token for `email`.
 *
 * Uses an atomic upsert on the unique `verification.identifier` constraint so
 * concurrent creates cannot race into duplicate rows.
 */
export async function createEmailVerificationToken(
  db: Db,
  email: string,
): Promise<string> {
  const token = generateEmailVerificationToken()
  // Store only the verifier digest at rest — never the raw token.
  const verifier = await deriveEmailVerificationVerifier(token)
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRES_IN_MS)
    .toISOString()
  const stamp = nowTs()

  await db
    .insert(verification)
    .values({
      identifier: email,
      value: verifier,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: verification.identifier,
      set: {
        value: verifier,
        expiresAt,
        updatedAt: stamp,
      },
    })

  return token
}

/**
 * Consume an unexpired token: returns the associated email (`identifier`) and
 * deletes the row, or `null` when the token is unknown or expired.
 */
export async function consumeEmailVerificationToken(
  db: Db,
  token: string,
): Promise<string | null> {
  const verifier = await deriveEmailVerificationVerifier(token)
  const rows = await db
    .select({ id: verification.id, identifier: verification.identifier })
    .from(verification)
    .where(
      and(
        eq(verification.value, verifier),
        gt(verification.expiresAt, nowTs()),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) {
    return null
  }

  await db.delete(verification).where(eq(verification.id, row.id))
  return row.identifier
}
