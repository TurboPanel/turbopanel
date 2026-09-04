import { and, eq } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import type { Context, Env, Hono } from 'hono'
import {
  buildSignedCookie,
  resolveRequestTls,
  resolveSessionCookieName,
  SESSION_EXPIRES_IN_MS,
  verifySignedCookie,
} from './crypto.ts'
import {
  createEmailOtp,
  verifyEmailOtp,
  type VerifyEmailOtpResult,
} from './email-otp.ts'
import {
  isInstanceInstalled,
  resolveEffectiveSignupEnabled,
  resolveSignupEnvOverrideFromContext,
  validateSuperadminEmail,
  validateSuperadminPassword,
} from './install-state.ts'
import { hashPassword } from './password.ts'
import {
  createSession,
  deleteSessionsByUserId,
  getSession,
  type SessionData,
} from './session-store.ts'
import {
  type AuthBodyValidation,
  type AuthRouteOpts,
  buildSessionResponse,
  readGatedAuthJsonBody,
  resolveClientIp,
} from './http.ts'
import { compatLogWarn } from '../../log-compat.ts'
import { getDb, type Db } from '../../db.ts'
import { account, user } from '../../lib/db/schema.ts'
import { getEmailQueue, type OtpType } from '../../lib/email/types.ts'
import {
  AUTH_RESET_PASSWORD_MAX_BODY_BYTES,
  AUTH_RESET_PASSWORD_REQUEST_MAX_BODY_BYTES,
  AUTH_SEND_OTP_MAX_BODY_BYTES,
  AUTH_SIGN_IN_OTP_MAX_BODY_BYTES,
  AUTH_VERIFY_EMAIL_OTP_MAX_BODY_BYTES,
  AUTH_VERIFY_OTP_MAX_BODY_BYTES,
  MAX_AUTH_NAME_CHARS,
  MAX_AUTH_OTP_CHARS,
  MAX_AUTH_PASSWORD_CHARS,
} from './auth-body-limits.ts'

const VALID_OTP_TYPES = new Set<OtpType>([
  'sign-in',
  'email-verification',
  'forget-password',
])

function isOtpType(value: unknown): value is OtpType {
  return typeof value === 'string' && VALID_OTP_TYPES.has(value as OtpType)
}

function nowTs(): string {
  return new Date().toISOString()
}

function requestTls(c: Context, runtime: 'deno' | 'workers') {
  return resolveRequestTls({
    requestUrl: c.req.url,
    runtime,
    forwardedProto: c.req.header('x-forwarded-proto'),
  })
}

function buildCookieHeader(
  cookieValue: string,
  maxAge: number,
  cookieName: string,
  isHttps: boolean,
): string {
  let header =
    `${cookieName}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  if (isHttps) {
    header += '; Secure'
  }
  return header
}

async function readActiveSession(
  c: Context,
  opts: AuthRouteOpts,
): Promise<SessionData | null> {
  const db = getDb(c)
  const cookieName = resolveSessionCookieName({
    requestUrl: c.req.url,
    runtime: opts.runtime,
    forwardedProto: c.req.header('x-forwarded-proto'),
  })
  const cookieValue = getCookie(c, cookieName) ?? null

  if (!cookieValue) return null

  const secrets = opts.secrets
  if (!secrets) return null

  const result = await verifySignedCookie(cookieValue, secrets)
  if (!result) return null

  return getSession(db, result.token)
}

function mapVerifyResult(result: VerifyEmailOtpResult) {
  switch (result) {
    case 'ok':
      return { status: 200 as const, body: { ok: true as const } }
    case 'invalid':
      return {
        status: 400 as const,
        body: { ok: false as const, error: 'Invalid OTP' },
      }
    case 'expired':
      return {
        status: 400 as const,
        body: { ok: false as const, error: 'OTP expired' },
      }
    case 'too_many_attempts':
      return {
        status: 429 as const,
        body: { ok: false as const, error: 'Too many attempts' },
      }
  }
}

function enqueueEmailOtp(
  c: Context,
  opts: AuthRouteOpts,
  to: string,
  otp: string,
  otpType: OtpType,
): void {
  const queue = getEmailQueue(c)
  const emailFrom =
    c.get('emailFrom') ?? opts.emailFrom ?? 'noreply@turbopanel.local'
  if (!queue) {
    compatLogWarn('email', `OTP email not sent for ${to}: email queue unavailable`)
    return
  }
  void queue
    .enqueue({
      type: 'email-otp',
      to,
      from: emailFrom,
      otp,
      otpType,
    })
    .catch((err) => {
      compatLogWarn('email', `OTP email enqueue failed: ${err}`)
    })
}

async function resolveOtpSignInUserId(
  c: Context,
  opts: AuthRouteOpts,
  db: Db,
  trimmedEmail: string,
  name: string | undefined,
): Promise<{ userId: string } | { response: Response }> {
  const existingUsers = await db
    .select({ id: user.id, isDisabled: user.isDisabled })
    .from(user)
    .where(eq(user.email, trimmedEmail))
    .limit(1)

  const existingUser = existingUsers[0]
  if (existingUser?.isDisabled) {
    return {
      response: c.json({ ok: false, error: 'Invalid credentials' }, 403),
    }
  }
  if (existingUser) {
    return { userId: existingUser.id }
  }

  if (opts.runtime === 'deno' && !(await isInstanceInstalled(db))) {
    return {
      response: c.json({ ok: false, error: 'Complete initial setup first' }, 403),
    }
  }
  if (
    !(await resolveEffectiveSignupEnabled(
      db,
      opts.runtime,
      resolveSignupEnvOverrideFromContext(
        c.get('platformEnv') as Record<string, string | undefined> | undefined,
        opts.signupEnvOverride,
      ),
    ))
  ) {
    return {
      response: c.json({ ok: false, error: 'Sign-up is not enabled' }, 403),
    }
  }

  const displayName = name?.trim() ? name.trim() : undefined
  const inserted = await db
    .insert(user)
    .values({
      email: trimmedEmail,
      isEmailVerified: true,
      role: 'user',
      ...(displayName && { name: displayName }),
    })
    .returning({ id: user.id })

  const created = inserted[0]
  if (!created) {
    return { response: c.json({ ok: false, error: 'Sign-in failed' }, 500) }
  }
  return { userId: created.id }
}

/**
 * Whether an unauthenticated `send-otp` (`type: 'sign-in'`) should actually
 * create and email an OTP. An active existing user is always eligible; an
 * unknown address is eligible only when public sign-up / OTP
 * auto-registration is enabled for this runtime — otherwise `sign-in/otp`
 * could never complete for it (see `resolveOtpSignInUserId`), and sending
 * the email would just be spamming an arbitrary address.
 *
 * Callers must return the same `{ ok: true }` response regardless of the
 * result (anti-enumeration) — only whether an OTP is actually created and
 * enqueued differs.
 */
async function isSignInOtpSendEligible(
  c: Context,
  opts: AuthRouteOpts,
  db: Db,
  trimmedEmail: string,
): Promise<boolean> {
  const existingUsers = await db
    .select({ id: user.id, isDisabled: user.isDisabled })
    .from(user)
    .where(eq(user.email, trimmedEmail))
    .limit(1)

  const existingUser = existingUsers[0]
  if (existingUser) {
    return !existingUser.isDisabled
  }

  return await resolveEffectiveSignupEnabled(
    db,
    opts.runtime,
    resolveSignupEnvOverrideFromContext(
      c.get('platformEnv') as Record<string, string | undefined> | undefined,
      opts.signupEnvOverride,
    ),
  )
}

/**
 * Whether `reset-password/request-otp` should actually create and email an
 * OTP: only for an active user that has a credential account.
 * `reset-password/otp` later fails closed (404) for a missing/disabled user
 * or a missing credential account — sending the OTP email first for a flow
 * that can never complete would just be spamming the address.
 *
 * Callers must return the same `{ ok: true }` response regardless of the
 * result (anti-enumeration).
 */
async function isResetPasswordRequestEligible(
  db: Db,
  trimmedEmail: string,
): Promise<boolean> {
  const existingUsers = await db
    .select({ id: user.id, isDisabled: user.isDisabled })
    .from(user)
    .where(eq(user.email, trimmedEmail))
    .limit(1)

  const existingUser = existingUsers[0]
  if (!existingUser || existingUser.isDisabled) return false

  const accountRows = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(eq(account.userId, existingUser.id), eq(account.providerId, 'credential')),
    )
    .limit(1)

  return accountRows.length > 0
}

type SendOtpBody = { email: string; type: OtpType }

function parseSendOtpBody(body: unknown): AuthBodyValidation<SendOtpBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }
  const { email, type } = body as { email?: unknown; type?: unknown }
  if (typeof email !== 'string' || !email || !isOtpType(type)) {
    return { ok: false, error: 'Invalid request' }
  }
  const emailError = validateSuperadminEmail(email)
  if (emailError) return { ok: false, error: emailError }
  return { ok: true, value: { email, type } }
}

type VerifyOtpBody = { email: string; otp: string; type: OtpType }

function parseVerifyOtpBody(body: unknown): AuthBodyValidation<VerifyOtpBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }
  const { email, otp, type } = body as {
    email?: unknown
    otp?: unknown
    type?: unknown
  }
  if (
    typeof email !== 'string' ||
    !email ||
    typeof otp !== 'string' ||
    !otp ||
    otp.length > MAX_AUTH_OTP_CHARS ||
    !isOtpType(type)
  ) {
    return { ok: false, error: 'Invalid request' }
  }
  const emailError = validateSuperadminEmail(email)
  if (emailError) return { ok: false, error: emailError }
  return { ok: true, value: { email, otp, type } }
}

type SignInOtpBody = { email: string; otp: string; name: string | undefined }

function parseSignInOtpBody(body: unknown): AuthBodyValidation<SignInOtpBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }
  const { email, otp, name } = body as {
    email?: unknown
    otp?: unknown
    name?: unknown
  }
  if (
    typeof email !== 'string' ||
    !email ||
    typeof otp !== 'string' ||
    !otp ||
    otp.length > MAX_AUTH_OTP_CHARS
  ) {
    return { ok: false, error: 'Invalid request' }
  }
  if (name !== undefined && (typeof name !== 'string' || name.length > MAX_AUTH_NAME_CHARS)) {
    return { ok: false, error: 'Invalid request' }
  }
  const emailError = validateSuperadminEmail(email)
  if (emailError) return { ok: false, error: emailError }
  return { ok: true, value: { email, otp, name: typeof name === 'string' ? name : undefined } }
}

type VerifyEmailOtpBody = { email: string; otp: string }

function parseVerifyEmailOtpBody(body: unknown): AuthBodyValidation<VerifyEmailOtpBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }
  const { email, otp } = body as { email?: unknown; otp?: unknown }
  if (
    typeof email !== 'string' ||
    !email ||
    typeof otp !== 'string' ||
    !otp ||
    otp.length > MAX_AUTH_OTP_CHARS
  ) {
    return { ok: false, error: 'Invalid request' }
  }
  const emailError = validateSuperadminEmail(email)
  if (emailError) return { ok: false, error: emailError }
  return { ok: true, value: { email, otp } }
}

type ResetPasswordRequestBody = { email: string }

function parseResetPasswordRequestBody(
  body: unknown,
): AuthBodyValidation<ResetPasswordRequestBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }
  const { email } = body as { email?: unknown }
  if (typeof email !== 'string' || !email) {
    return { ok: false, error: 'Invalid request' }
  }
  const emailError = validateSuperadminEmail(email)
  if (emailError) return { ok: false, error: emailError }
  return { ok: true, value: { email } }
}

type ResetPasswordOtpBody = { email: string; otp: string; password: string }

function parseResetPasswordOtpBody(
  body: unknown,
): AuthBodyValidation<ResetPasswordOtpBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }
  const { email, otp, password } = body as {
    email?: unknown
    otp?: unknown
    password?: unknown
  }
  if (
    typeof email !== 'string' ||
    !email ||
    typeof otp !== 'string' ||
    !otp ||
    otp.length > MAX_AUTH_OTP_CHARS ||
    typeof password !== 'string' ||
    !password ||
    password.length > MAX_AUTH_PASSWORD_CHARS
  ) {
    return { ok: false, error: 'Invalid request' }
  }
  // Password error takes priority over email format, matching the original
  // handler order (weak-password tests assert this message even when the
  // email is otherwise well-formed).
  const passwordError = validateSuperadminPassword(password)
  if (passwordError) return { ok: false, error: passwordError }
  const emailError = validateSuperadminEmail(email)
  if (emailError) return { ok: false, error: emailError }
  return { ok: true, value: { email, otp, password } }
}

export function registerOtpRoutes<E extends Env>(auth: Hono<E>, opts: AuthRouteOpts) {
  auth.post('/send-otp', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'send-otp',
      maxBytes: AUTH_SEND_OTP_MAX_BODY_BYTES,
      parse: parseSendOtpBody,
      identity: (v) => v.email.trim().toLowerCase(),
    })
    if (!gated.ok) return gated.response
    const { type } = gated.value
    let trimmedEmail = gated.value.email.trim().toLowerCase()

    if (type === 'email-verification') {
      const sessionData = await readActiveSession(c, opts)
      if (!sessionData) {
        return c.json({ ok: false, error: 'Unauthorized' }, 401)
      }
      const sessionEmail = sessionData.email.trim().toLowerCase()
      if (trimmedEmail !== sessionEmail) {
        return c.json({ ok: false, error: 'Invalid request' }, 400)
      }
      trimmedEmail = sessionEmail
    }

    const otpSecrets = opts.otpVerifierSecrets
    if (!otpSecrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
    }

    // `sign-in` can email an address that never completes the flow (unknown
    // + auto-registration disabled, or a disabled account) — skip creating
    // and sending the OTP for those, but answer identically so the response
    // never reveals whether the address is reachable.
    if (
      type === 'sign-in' &&
      !(await isSignInOtpSendEligible(c, opts, db, trimmedEmail))
    ) {
      return c.json({ ok: true }, 200)
    }

    // `forget-password` goes through this same generic endpoint — apply the
    // same eligibility gate as `reset-password/request-otp` so it cannot be
    // used to spam an address that could never complete a reset.
    if (
      type === 'forget-password' &&
      !(await isResetPasswordRequestEligible(db, trimmedEmail))
    ) {
      return c.json({ ok: true }, 200)
    }

    const otpResult = await createEmailOtp(db, trimmedEmail, type, otpSecrets)
    if (otpResult.status === 'cooldown') {
      // Resend cooldown active — respond identically so callers cannot probe.
      return c.json({ ok: true }, 200)
    }
    enqueueEmailOtp(c, opts, trimmedEmail, otpResult.otp, type)

    return c.json({ ok: true }, 200)
  })

  auth.post('/verify-otp', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'verify-otp',
      maxBytes: AUTH_VERIFY_OTP_MAX_BODY_BYTES,
      parse: parseVerifyOtpBody,
      identity: (v) => v.email.trim().toLowerCase(),
    })
    if (!gated.ok) return gated.response
    const { otp, type } = gated.value
    const trimmedEmail = gated.value.email.trim().toLowerCase()

    const otpSecrets = opts.otpVerifierSecrets
    if (!otpSecrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
    }

    const result = await verifyEmailOtp(db, trimmedEmail, type, otp, otpSecrets, {
      consume: false,
    })
    const mapped = mapVerifyResult(result)
    return c.json(mapped.body, mapped.status)
  })

  auth.post('/sign-in/otp', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'sign-in-otp',
      maxBytes: AUTH_SIGN_IN_OTP_MAX_BODY_BYTES,
      parse: parseSignInOtpBody,
      identity: (v) => v.email.trim().toLowerCase(),
    })
    if (!gated.ok) return gated.response
    const { otp, name } = gated.value
    const trimmedEmail = gated.value.email.trim().toLowerCase()

    const otpSecrets = opts.otpVerifierSecrets
    if (!otpSecrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
    }

    const verifyResult = await verifyEmailOtp(
      db,
      trimmedEmail,
      'sign-in',
      otp,
      otpSecrets,
    )
    const mapped = mapVerifyResult(verifyResult)
    if (mapped.status !== 200) {
      return c.json(mapped.body, mapped.status)
    }

    const resolved = await resolveOtpSignInUserId(
      c,
      opts,
      db,
      trimmedEmail,
      name,
    )
    if ('response' in resolved) {
      return resolved.response
    }
    const userId = resolved.userId

    const secrets = opts.secrets
    if (!secrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
    }

    const { token } = await createSession(db, userId, {
      ipAddress: resolveClientIp(c, opts.runtime) ?? undefined,
      userAgent: c.req.header('User-Agent') ?? undefined,
    })
    const cookieValue = await buildSignedCookie(token, secrets)
    const tls = requestTls(c, opts.runtime)
    const setCookieHeader = buildCookieHeader(
      cookieValue,
      SESSION_EXPIRES_IN_MS / 1000,
      tls.cookieName,
      tls.isHttps,
    )
    const sessionData = await getSession(db, token)
    if (!sessionData) {
      throw new Error('Session creation failed')
    }

    const payload = await buildSessionResponse(db, opts.runtime, sessionData)

    return c.json(payload, 200, { 'Set-Cookie': setCookieHeader })
  })

  auth.post('/verify-email/otp', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const sessionData = await readActiveSession(c, opts)
    if (!sessionData) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401)
    }
    const sessionEmail = sessionData.email.trim().toLowerCase()

    // Rate-limit identity is the session's own email, not the submitted one —
    // a caller cannot spend someone else's bucket by submitting their address.
    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'verify-email-otp',
      maxBytes: AUTH_VERIFY_EMAIL_OTP_MAX_BODY_BYTES,
      parse: parseVerifyEmailOtpBody,
      identity: () => sessionEmail,
    })
    if (!gated.ok) return gated.response
    const { otp } = gated.value
    const trimmedEmail = gated.value.email.trim().toLowerCase()
    if (trimmedEmail !== sessionEmail) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const otpSecrets = opts.otpVerifierSecrets
    if (!otpSecrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
    }

    const verifyResult = await verifyEmailOtp(
      db,
      sessionEmail,
      'email-verification',
      otp,
      otpSecrets,
    )
    const mapped = mapVerifyResult(verifyResult)
    if (mapped.status !== 200) {
      return c.json(mapped.body, mapped.status)
    }

    await db
      .update(user)
      .set({ isEmailVerified: true, updatedAt: nowTs() })
      .where(eq(user.id, sessionData.userId))

    return c.json({ ok: true }, 200)
  })

  auth.post('/reset-password/request-otp', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'reset-password-request',
      maxBytes: AUTH_RESET_PASSWORD_REQUEST_MAX_BODY_BYTES,
      parse: parseResetPasswordRequestBody,
      identity: (v) => v.email.trim().toLowerCase(),
    })
    if (!gated.ok) return gated.response
    const trimmedEmail = gated.value.email.trim().toLowerCase()

    const otpSecrets = opts.otpVerifierSecrets
    if (!otpSecrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
    }

    // Only an active user with a credential account can ever complete a
    // reset — `reset-password/otp` fails closed (404) otherwise. Skip
    // creating and emailing the OTP for a flow that cannot complete, but
    // answer identically (anti-enumeration).
    if (!(await isResetPasswordRequestEligible(db, trimmedEmail))) {
      return c.json({ ok: true }, 200)
    }

    const otpResult = await createEmailOtp(
      db,
      trimmedEmail,
      'forget-password',
      otpSecrets,
    )
    if (otpResult.status === 'cooldown') {
      return c.json({ ok: true }, 200)
    }
    enqueueEmailOtp(c, opts, trimmedEmail, otpResult.otp, 'forget-password')

    return c.json({ ok: true }, 200)
  })

  auth.post('/reset-password/otp', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'reset-password',
      maxBytes: AUTH_RESET_PASSWORD_MAX_BODY_BYTES,
      parse: parseResetPasswordOtpBody,
      identity: (v) => v.email.trim().toLowerCase(),
    })
    if (!gated.ok) return gated.response
    const { otp, password } = gated.value
    const trimmedEmail = gated.value.email.trim().toLowerCase()

    const otpSecrets = opts.otpVerifierSecrets
    if (!otpSecrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
    }

    const verifyResult = await verifyEmailOtp(
      db,
      trimmedEmail,
      'forget-password',
      otp,
      otpSecrets,
    )
    const mapped = mapVerifyResult(verifyResult)
    if (mapped.status !== 200) {
      return c.json(mapped.body, mapped.status)
    }

    const users = await db
      .select({ id: user.id, isDisabled: user.isDisabled })
      .from(user)
      .where(eq(user.email, trimmedEmail))
      .limit(1)

    const foundUser = users[0]
    if (!foundUser) {
      return c.json({ ok: false, error: 'User not found' }, 404)
    }

    // Disabled users must not be able to complete a password reset.
    if (foundUser.isDisabled) {
      return c.json({ ok: false, error: 'User not found' }, 404)
    }

    const hashedPassword = await hashPassword(password)
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(account)
        .set({ password: hashedPassword, updatedAt: nowTs() })
        .where(
          and(
            eq(account.userId, foundUser.id),
            eq(account.providerId, 'credential'),
          ),
        )
        .returning({ id: account.id })

      if (rows.length > 0) {
        await deleteSessionsByUserId(tx, foundUser.id)
      }
      return rows
    })

    if (updated.length === 0) {
      return c.json({ ok: false, error: 'User not found' }, 404)
    }

    return c.json({ ok: true }, 200)
  })
}
