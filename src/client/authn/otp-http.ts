import { and, eq } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { Hono, type Context } from 'hono'
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
  isSignupEnabled,
  validateSuperadminEmail,
  validateSuperadminPassword,
} from './install-state.ts'
import { hashPassword } from './password.ts'
import { createSession, getSession, type SessionData } from './session-store.ts'
import type { AuthRouteOpts } from './http.ts'
import { buildSessionResponse, enforceAuthRateLimit } from './http.ts'
import { compatLogWarn } from '../../log-compat.ts'
import { getDb, type Db } from '../../db.ts'
import { account, user } from '../../lib/db/schema.ts'
import { getEmailQueue } from '../../lib/email/types.ts'
import type { OtpType } from '../../lib/email/types.ts'

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

function requestTls(c: Context) {
  return resolveRequestTls(c.req.url, c.req.header('x-forwarded-proto'))
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
  const forwardedProto = c.req.header('x-forwarded-proto')
  const cookieName = resolveSessionCookieName(c.req.url, forwardedProto)
  const cookieValue = getCookie(c, cookieName) ?? null

  if (!cookieValue) return null

  const result = await verifySignedCookie(cookieValue, opts.secrets)
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
  if (!(await isSignupEnabled(db, opts.signupEnvOverride, opts.runtime))) {
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
      ...(displayName && { displayName }),
    })
    .returning({ id: user.id })

  const created = inserted[0]
  if (!created) {
    return { response: c.json({ ok: false, error: 'Sign-in failed' }, 500) }
  }
  return { userId: created.id }
}

export function registerOtpRoutes(auth: Hono, opts: AuthRouteOpts) {
  auth.post('/send-otp', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const { email, type } = body as { email?: unknown; type?: unknown }
    if (typeof email !== 'string' || !email || !isOtpType(type)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const emailError = validateSuperadminEmail(email)
    if (emailError) {
      return c.json({ ok: false, error: emailError }, 400)
    }

    let trimmedEmail = email.trim().toLowerCase()

    const sendOtpLimited = enforceAuthRateLimit(c, 'send-otp', trimmedEmail)
    if (sendOtpLimited) {
      return sendOtpLimited
    }

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

    const otpResult = await createEmailOtp(db, trimmedEmail, type)
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

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
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
      !isOtpType(type)
    ) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const trimmedEmail = email.trim().toLowerCase()

    const verifyOtpLimited = enforceAuthRateLimit(c, 'verify-otp', trimmedEmail)
    if (verifyOtpLimited) {
      return verifyOtpLimited
    }

    const result = await verifyEmailOtp(db, trimmedEmail, type, otp, {
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

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const { email, otp, name } = body as {
      email?: unknown
      otp?: unknown
      name?: unknown
    }

    if (typeof email !== 'string' || !email || typeof otp !== 'string' || !otp) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (name !== undefined && typeof name !== 'string') {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const trimmedEmail = email.trim().toLowerCase()

    const signInOtpLimited = enforceAuthRateLimit(c, 'sign-in-otp', trimmedEmail)
    if (signInOtpLimited) {
      return signInOtpLimited
    }

    const verifyResult = await verifyEmailOtp(db, trimmedEmail, 'sign-in', otp)
    const mapped = mapVerifyResult(verifyResult)
    if (mapped.status !== 200) {
      return c.json(mapped.body, mapped.status)
    }

    const resolved = await resolveOtpSignInUserId(
      c,
      opts,
      db,
      trimmedEmail,
      typeof name === 'string' ? name : undefined,
    )
    if ('response' in resolved) {
      return resolved.response
    }
    const userId = resolved.userId

    const { token } = await createSession(db, userId, {
      ipAddress: c.req.header('X-Real-IP') ?? undefined,
      userAgent: c.req.header('User-Agent') ?? undefined,
    })
    const cookieValue = await buildSignedCookie(token, opts.secrets)
    const tls = requestTls(c)
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

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const { email, otp } = body as { email?: unknown; otp?: unknown }
    if (typeof email !== 'string' || !email || typeof otp !== 'string' || !otp) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const sessionEmail = sessionData.email.trim().toLowerCase()
    const trimmedEmail = email.trim().toLowerCase()
    if (trimmedEmail !== sessionEmail) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const verifyEmailLimited = enforceAuthRateLimit(
      c,
      'verify-email-otp',
      sessionEmail,
    )
    if (verifyEmailLimited) {
      return verifyEmailLimited
    }

    const verifyResult = await verifyEmailOtp(
      db,
      sessionEmail,
      'email-verification',
      otp,
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

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const { email } = body as { email?: unknown }
    if (typeof email !== 'string' || !email) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const trimmedEmail = email.trim().toLowerCase()

    const resetRequestLimited = enforceAuthRateLimit(
      c,
      'reset-password-request',
      trimmedEmail,
    )
    if (resetRequestLimited) {
      return resetRequestLimited
    }

    const otpResult = await createEmailOtp(db, trimmedEmail, 'forget-password')
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

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
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
      typeof password !== 'string' ||
      !password
    ) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const passwordError = validateSuperadminPassword(password)
    if (passwordError) {
      return c.json({ ok: false, error: passwordError }, 400)
    }

    const trimmedEmail = email.trim().toLowerCase()
    const verifyResult = await verifyEmailOtp(
      db,
      trimmedEmail,
      'forget-password',
      otp,
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
    const updated = await db
      .update(account)
      .set({ password: hashedPassword, updatedAt: nowTs() })
      .where(
        and(
          eq(account.userId, foundUser.id),
          eq(account.providerId, 'credential'),
        ),
      )
      .returning({ id: account.id })

    if (updated.length === 0) {
      return c.json({ ok: false, error: 'User not found' }, 404)
    }

    return c.json({ ok: true }, 200)
  })
}
