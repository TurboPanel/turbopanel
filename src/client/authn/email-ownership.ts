import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { account, session, user } from '../../db/schema.ts'

/**
 * Record that the person at the keyboard just proved they control the mailbox
 * (email code sign-in, or the in-app email code check) for `userId`.
 *
 * If the account was still unverified, the password on it was chosen by
 * whoever submitted the sign-up form, who never proved they own the address.
 * The proof here is not that person's own flow, so the password is cleared
 * (the owner sets a new one through reset-password) and every existing session
 * is revoked, all in one transaction with marking the email verified.
 * `keepSessionId` is the caller's own session, which stays signed in.
 *
 * Returns true when an unverified account was converted.
 */
export async function verifyEmailOwnershipAndRevokeUntrusted(
  db: Db,
  userId: string,
  keepSessionId?: string
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const flipped = await tx
      .update(user)
      .set({ isEmailVerified: true, updatedAt: new Date().toISOString() })
      .where(and(eq(user.id, userId), eq(user.isEmailVerified, false)))
      .returning({ id: user.id })
    if (flipped.length === 0) return false

    await tx
      .update(account)
      .set({ password: null })
      .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    await tx
      .delete(session)
      .where(
        keepSessionId === undefined
          ? eq(session.userId, userId)
          : and(eq(session.userId, userId), ne(session.id, keepSessionId))
      )
    return true
  })
}
