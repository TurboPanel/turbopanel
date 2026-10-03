/**
 * Signed-in password change:
 *
 *   POST /auth/change-password { currentPassword, newPassword }
 *     Session required. The current password is verified (charged to the
 *     `reauth` throttle first, like every other step-up), the new one must
 *     satisfy the sign-up rules and not be a known breached password, and every
 *     OTHER session of the account is signed out — the one changing the
 *     password stays signed in. Accounts with no password (passkey / provider
 *     sign-in only) are refused with `no_password`: there is no "set a
 *     password" route to point them to.
 *
 * Error codes: `incorrect_current_password` (400, not 403 — the app treats a
 * 403 as "ask again"), `password_unchanged`, `password_breached`, `no_password`
 * (409), plus the sign-up rule messages (400).
 */
import { and, eq } from 'drizzle-orm'
import type { Context, Env, Hono } from 'hono'
import { getDb } from '../../db/connection.ts'
import { account } from '../../db/schema.ts'
import { hashPassword, verifyPassword } from '../../lib/secrets/password.ts'
import { AUTH_TWO_FACTOR_MAX_BODY_BYTES, MAX_AUTH_PASSWORD_CHARS } from './auth-body-limits.ts'
import { refuseIfBreached } from './breached-password.ts'
import { type AuthBodyValidation, type AuthRouteOpts, enforceAuthRateLimit } from './http.ts'
import { validateSuperadminPassword } from './install-state.ts'
import { resolveRuntime } from './middleware.ts'
import { readActiveSession, readOptionalJsonObject } from './request-context.ts'
import { deleteOtherSessionsForUser } from './session-store.ts'

export const INCORRECT_CURRENT_PASSWORD = 'incorrect_current_password'
export const NO_PASSWORD = 'no_password'
export const PASSWORD_UNCHANGED = 'password_unchanged'

type ChangePasswordBody = { currentPassword: string; newPassword: string }

function isPasswordText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_AUTH_PASSWORD_CHARS
}

export function parseChangePasswordBody(
  body: Record<string, unknown>
): AuthBodyValidation<ChangePasswordBody> {
  const { currentPassword, newPassword } = body
  if (!isPasswordText(currentPassword) || !isPasswordText(newPassword)) {
    return { ok: false, error: 'Invalid request' }
  }
  const passwordError = validateSuperadminPassword(newPassword)
  if (passwordError) return { ok: false, error: passwordError }
  if (currentPassword === newPassword) return { ok: false, error: PASSWORD_UNCHANGED }
  return { ok: true, value: { currentPassword, newPassword } }
}

async function credentialHash(
  c: Context,
  userId: string
): Promise<{ db: NonNullable<ReturnType<typeof getDb>>; hash: string | null } | null> {
  const db = getDb(c)
  if (db === undefined) return null
  const rows = await db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    .limit(1)
  return { db, hash: rows[0]?.password ?? null }
}

export function registerChangePasswordRoute<E extends Env>(
  auth: Hono<E>,
  opts: AuthRouteOpts
): void {
  auth.post('/change-password', async (c) => {
    const session = await readActiveSession(c, opts)
    if (!session) return c.json({ ok: false, error: 'Unauthorized' }, 401)

    const read = await readOptionalJsonObject(c, AUTH_TWO_FACTOR_MAX_BODY_BYTES)
    if (!read.ok) return read.response
    const parsed = parseChangePasswordBody(read.body)
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400)
    const { currentPassword, newPassword } = parsed.value

    const credential = await credentialHash(c, session.userId)
    if (credential === null) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    if (credential.hash === null) {
      return c.json(
        {
          ok: false,
          error: NO_PASSWORD,
          message: 'This account signs in without a password.',
        },
        409
      )
    }

    const limited = await enforceAuthRateLimit(c, 'reauth', session.userId, resolveRuntime(c))
    if (limited) return limited
    if (!(await verifyPassword(currentPassword, credential.hash))) {
      return c.json({ ok: false, error: INCORRECT_CURRENT_PASSWORD }, 400)
    }

    const breached = await refuseIfBreached(c, newPassword)
    if (breached) return breached

    const hashedPassword = await hashPassword(newPassword)
    await credential.db
      .update(account)
      .set({ password: hashedPassword, updatedAt: new Date().toISOString() })
      .where(and(eq(account.userId, session.userId), eq(account.providerId, 'credential')))
    await deleteOtherSessionsForUser(credential.db, session.userId, session.sessionId)
    return c.json({ ok: true }, 200)
  })
}
