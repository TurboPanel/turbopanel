import { and, eq, gt, like } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { verification } from '../../db/schema.ts'
import { deriveLinkTokenVerifier, generateLinkToken } from './link-token.ts'

/** One hour — better-auth's `resetPasswordTokenExpiresIn` default. */
export const PASSWORD_RESET_EXPIRES_IN_MS = 60 * 60 * 1000

/** Domain separation for reset-link verifiers (see `link-token.ts`). */
const PASSWORD_RESET_VERIFIER_CONTEXT = 'turbopanel-password-reset-verifier-v1'

/** `verification.identifier` prefix — better-auth's `reset-password:` namespace. */
const PASSWORD_RESET_IDENTIFIER_PREFIX = 'reset-password:'

function nowTs(): string {
  return new Date().toISOString()
}

/**
 * Mint the password-reset link token for `userId`. Keyed by user, so asking
 * again replaces the previous link: only the newest one works.
 */
export async function createPasswordResetToken(db: Db, userId: string): Promise<string> {
  const token = generateLinkToken()
  const verifier = await deriveLinkTokenVerifier(PASSWORD_RESET_VERIFIER_CONTEXT, token)
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRES_IN_MS).toISOString()
  await db
    .insert(verification)
    .values({
      identifier: `${PASSWORD_RESET_IDENTIFIER_PREFIX}${userId}`,
      value: verifier,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: verification.identifier,
      set: { value: verifier, expiresAt, updatedAt: nowTs() },
    })
  return token
}

async function findLiveResetRow(
  db: Db,
  token: string
): Promise<{ id: string; userId: string } | null> {
  const verifier = await deriveLinkTokenVerifier(PASSWORD_RESET_VERIFIER_CONTEXT, token)
  const rows = await db
    .select({ id: verification.id, identifier: verification.identifier })
    .from(verification)
    .where(
      and(
        eq(verification.value, verifier),
        like(verification.identifier, `${PASSWORD_RESET_IDENTIFIER_PREFIX}%`),
        gt(verification.expiresAt, nowTs())
      )
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return { id: row.id, userId: row.identifier.slice(PASSWORD_RESET_IDENTIFIER_PREFIX.length) }
}

/** The user a live reset token belongs to, without using it up (the link-click redirect). */
export async function peekPasswordResetToken(db: Db, token: string): Promise<string | null> {
  return (await findLiveResetRow(db, token))?.userId ?? null
}

/** Use up a live reset token: returns its user and deletes it, or `null` when unknown or expired. */
export async function consumePasswordResetToken(db: Db, token: string): Promise<string | null> {
  const row = await findLiveResetRow(db, token)
  if (!row) return null
  const deleted = await db
    .delete(verification)
    .where(eq(verification.id, row.id))
    .returning({ id: verification.id })
  // A concurrent reset with the same link may have deleted it first.
  return deleted.length > 0 ? row.userId : null
}
