import { and, gt } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { verification } from '../../lib/db/schema.ts'

/** 24 hours — email verification tokens are short-lived. */
const EMAIL_VERIFICATION_EXPIRES_IN_MS = 24 * 60 * 60 * 1000

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
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRES_IN_MS)
    .toISOString()
  const stamp = nowTs()

  await db
    .insert(verification)
    .values({
      identifier: email,
      value: token,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: verification.identifier,
      set: {
        value: token,
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
  const rows = await db
    .select({ id: verification.id, identifier: verification.identifier })
    .from(verification)
    .where(
      and(
        eq(verification.value, token),
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
