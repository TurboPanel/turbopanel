import { and, eq, gt } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { verification } from '../../db/schema.ts'
import { deriveLinkTokenVerifier, generateLinkToken } from './link-token.ts'

/** 24 hours — email verification tokens are short-lived. */
const EMAIL_VERIFICATION_EXPIRES_IN_MS = 24 * 60 * 60 * 1000

/**
 * Domain-separation context for the email-verification-token verifier digest.
 * Bumping the version suffix invalidates every previously-stored digest
 * (forced rotation).
 */
const EMAIL_VERIFICATION_VERIFIER_CONTEXT = 'turbopanel-email-verification-verifier-v1'

function nowTs(): string {
  return new Date().toISOString()
}

function deriveEmailVerificationVerifier(token: string): Promise<string> {
  return deriveLinkTokenVerifier(EMAIL_VERIFICATION_VERIFIER_CONTEXT, token)
}

/**
 * Create (or replace) the email verification token for `email`.
 *
 * Uses an atomic upsert on the unique `verification.identifier` constraint so
 * concurrent creates cannot race into duplicate rows.
 */
export async function createEmailVerificationToken(db: Db, email: string): Promise<string> {
  const token = generateLinkToken()
  // Store only the verifier digest at rest — never the raw token.
  const verifier = await deriveEmailVerificationVerifier(token)
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRES_IN_MS).toISOString()
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
export async function consumeEmailVerificationToken(db: Db, token: string): Promise<string | null> {
  const verifier = await deriveEmailVerificationVerifier(token)
  const rows = await db
    .select({ id: verification.id, identifier: verification.identifier })
    .from(verification)
    .where(and(eq(verification.value, verifier), gt(verification.expiresAt, nowTs())))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return null
  }

  await db.delete(verification).where(eq(verification.id, row.id))
  return row.identifier
}
