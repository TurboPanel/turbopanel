/**
 * Forgot password — better-auth's emailed-link flow (`emailAndPassword`
 * `sendResetPassword`), with `revokeSessionsOnPasswordReset` on:
 *
 *   POST /auth/request-password-reset { email, redirectTo? }
 *     Always `{ ok: true }` (anti-enumeration). For an active user with a
 *     password account, emails a one-hour link to
 *     GET /auth/reset-password/:token?callbackURL=<console reset page>.
 *   GET  /auth/reset-password/:token?callbackURL=
 *     Redirects to the callback with `?token=` when the link is live, else
 *     `?error=INVALID_TOKEN` — the link itself is not used up here.
 *   POST /auth/reset-password { newPassword, token }
 *     Sets the new password, uses the link up and signs the user out
 *     everywhere (owner decision 2026-09-27).
 *
 * The callback is only ever an allowlisted app page (`RESET_PAGES`);
 * anything else falls back to `/reset-password`, so the link can never bounce
 * a token to another site.
 */
import { and, eq } from 'drizzle-orm'
import type { Context, Env, Hono } from 'hono'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { getDb } from '../../db/connection.ts'
import { account, user } from '../../db/schema.ts'
import { getEmailQueue } from '../../features/email/types.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { hashPassword } from '../../lib/secrets/password.ts'
import { refuseIfBreached } from './breached-password.ts'
import {
  AUTH_RESET_PASSWORD_MAX_BODY_BYTES,
  AUTH_RESET_PASSWORD_REQUEST_MAX_BODY_BYTES,
  MAX_AUTH_PASSWORD_CHARS,
} from './auth-body-limits.ts'
import {
  type AuthBodyValidation,
  type AuthRouteOpts,
  readGatedAuthJsonBody,
  resolveVerificationBaseUrlAsync,
} from './http.ts'
import { validateSuperadminEmail, validateSuperadminPassword } from './install-state.ts'
import { findPasswordResetUserId } from './otp-http.ts'
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  peekPasswordResetToken,
} from './password-reset.ts'
import { deleteSessionsByUserId } from './session-store.ts'

/** The console page that reads `?token=` / `?error=` and asks for the new password. */
export const DEFAULT_PASSWORD_RESET_PAGE = '/reset-password'

/** better-auth's error code on an unknown, used or expired reset link. */
export const INVALID_TOKEN = 'INVALID_TOKEN'

/** Link tokens are 64 hex characters (`link-token.ts`). */
const RESET_TOKEN_PATTERN = /^[0-9a-f]{64}$/

/**
 * Console pages a reset link may land on. `redirectTo` / `callbackURL` select
 * one by exact match; anything else — another origin, `//host`, an unknown
 * path — gets the default. The redirect target is therefore always one of
 * these constants, never request text, so the link can't send a token
 * off-site (open redirect).
 */
const RESET_PAGES: ReadonlyMap<string, string> = new Map([
  [DEFAULT_PASSWORD_RESET_PAGE, DEFAULT_PASSWORD_RESET_PAGE],
])

/** The allowlisted console reset page `path` names, else the default. */
export function safeResetPagePath(path: unknown): string {
  if (typeof path !== 'string') return DEFAULT_PASSWORD_RESET_PAGE
  return RESET_PAGES.get(path.trim()) ?? DEFAULT_PASSWORD_RESET_PAGE
}

/** `page` (an allowlisted constant) with `key=value` as its query string. */
function resetPageUrl(page: string, key: 'token' | 'error', value: string): string {
  return `${page}?${key}=${encodeURIComponent(value)}`
}

type RequestPasswordResetBody = { email: string; redirectTo: string }

function parseRequestPasswordResetBody(
  body: unknown
): AuthBodyValidation<RequestPasswordResetBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }
  const { email, redirectTo } = body as { email?: unknown; redirectTo?: unknown }
  if (typeof email !== 'string' || !email) {
    return { ok: false, error: 'Invalid request' }
  }
  const emailError = validateSuperadminEmail(email)
  if (emailError) return { ok: false, error: emailError }
  return { ok: true, value: { email, redirectTo: safeResetPagePath(redirectTo) } }
}

type ResetPasswordBody = { newPassword: string; token: string }

function parseResetPasswordBody(body: unknown): AuthBodyValidation<ResetPasswordBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }
  const { newPassword, token } = body as { newPassword?: unknown; token?: unknown }
  if (
    typeof token !== 'string' ||
    !RESET_TOKEN_PATTERN.test(token) ||
    typeof newPassword !== 'string' ||
    !newPassword ||
    newPassword.length > MAX_AUTH_PASSWORD_CHARS
  ) {
    return { ok: false, error: 'Invalid request' }
  }
  const passwordError = validateSuperadminPassword(newPassword)
  if (passwordError) return { ok: false, error: passwordError }
  return { ok: true, value: { newPassword, token } }
}

/**
 * Queue the reset email without awaiting it (better-auth's advice: awaiting
 * the send makes response time reveal whether the account exists). On
 * Workers the send runs to completion via `waitUntil`.
 */
function sendPasswordResetEmail(
  c: Context,
  opts: AuthRouteOpts,
  to: string,
  resetUrl: string
): void {
  const queue = getEmailQueue(c)
  if (!queue) {
    compatLogWarn('email', 'password reset email not sent: email queue unavailable')
    return
  }
  const from = c.get('emailFrom') ?? opts.emailFrom ?? 'noreply@turbopanel.local'
  const sending = queue.enqueue({ type: 'password-reset', to, from, resetUrl }).catch((err) => {
    compatLogWarn('email', `password reset email enqueue failed: ${err}`)
  })
  try {
    c.executionCtx.waitUntil(sending)
  } catch {
    // No execution context (Deno, tests): the promise simply runs on.
  }
}

export function registerPasswordResetRoutes<E extends Env>(
  auth: Hono<E>,
  opts: AuthRouteOpts
): void {
  auth.post('/request-password-reset', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }
    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'reset-password-request',
      maxBytes: AUTH_RESET_PASSWORD_REQUEST_MAX_BODY_BYTES,
      parse: parseRequestPasswordResetBody,
      identity: (v) => v.email.trim().toLowerCase(),
    })
    if (!gated.ok) return gated.response
    const trimmedEmail = gated.value.email.trim().toLowerCase()

    const userId = await findPasswordResetUserId(db, trimmedEmail)
    if (userId !== null) {
      const token = await createPasswordResetToken(db, userId)
      const base = await resolveVerificationBaseUrlAsync(c, opts)
      const callback = encodeURIComponent(gated.value.redirectTo)
      const resetUrl = `${base}${CLIENT_API_PREFIX}/auth/reset-password/${token}?callbackURL=${callback}`
      sendPasswordResetEmail(c, opts, trimmedEmail, resetUrl)
    }
    return c.json({ ok: true }, 200)
  })

  auth.get('/reset-password/:token', async (c) => {
    const callback = safeResetPagePath(c.req.query('callbackURL'))
    const token = c.req.param('token')
    const db = getDb(c)
    const live =
      db !== undefined &&
      RESET_TOKEN_PATTERN.test(token) &&
      (await peekPasswordResetToken(db, token)) !== null
    const target = live
      ? resetPageUrl(callback, 'token', token)
      : resetPageUrl(callback, 'error', INVALID_TOKEN)
    return c.redirect(target, 302)
  })

  auth.post('/reset-password', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }
    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'reset-password',
      maxBytes: AUTH_RESET_PASSWORD_MAX_BODY_BYTES,
      parse: parseResetPasswordBody,
      identity: (v) => v.token.slice(0, 16),
    })
    if (!gated.ok) return gated.response

    // Refuse a breached password while the link is still unused, so the person
    // can try again with the same link.
    if ((await peekPasswordResetToken(db, gated.value.token)) === null) {
      return c.json({ ok: false, error: INVALID_TOKEN }, 400)
    }
    const breached = await refuseIfBreached(c, gated.value.newPassword)
    if (breached) return breached

    const userId = await consumePasswordResetToken(db, gated.value.token)
    if (userId === null) {
      return c.json({ ok: false, error: INVALID_TOKEN }, 400)
    }
    const users = await db
      .select({ isDisabled: user.isDisabled })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
    if (!users[0] || users[0].isDisabled) {
      return c.json({ ok: false, error: INVALID_TOKEN }, 400)
    }

    const hashedPassword = await hashPassword(gated.value.newPassword)
    const updated = await db
      .update(account)
      .set({ password: hashedPassword, updatedAt: new Date().toISOString() })
      .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
      .returning({ id: account.id })
    if (updated.length === 0) {
      return c.json({ ok: false, error: INVALID_TOKEN }, 400)
    }
    await deleteSessionsByUserId(db, userId)
    return c.json({ ok: true }, 200)
  })
}
