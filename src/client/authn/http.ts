import { eq } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { Hono, type Context } from 'hono'
import {
  buildSignedCookie,
  resolveRequestTls,
  resolveSessionCookieName,
  SESSION_EXPIRES_IN_MS,
  verifySignedCookie,
} from './crypto.ts'
import { PAM_ROOT_USERNAME, verifyCredentials } from './credentials.ts'
import {
  getUserOrganizationId,
  isInstanceInstalled,
  isSignupEnabled,
  validateSuperadminEmail,
  validateSuperadminPassword,
} from './install-state.ts'
import { hashPassword } from './password.ts'
import {
  consumeEmailVerificationToken,
  createEmailVerificationToken,
} from './email-verification.ts'
import { createSession, deleteSession, getSession } from './session-store.ts'
import type { DerivedSecretsConfig } from './secrets.ts'
import { compatLogError, compatLogInfo, compatLogWarn } from '../../log-compat.ts'
import { getDb } from '../../db.ts'
import type { Db } from '../../db.ts'
import { account, user } from '../../lib/db/schema.ts'
import { getEmailQueue } from '../../lib/email/types.ts'
import { registerOtpRoutes } from './otp-http.ts'

export type AuthRouteOpts = {
  secrets?: DerivedSecretsConfig
  runtime: 'deno' | 'workers'
  /** `TURBOPANEL_IS_SIGNUP_ENABLED` — env override for Workers dev and self-hosted. */
  signupEnvOverride?: string
  emailFrom?: string
  baseUrl?: string
}

export type SessionResponse = {
  ok: true
  userId: string | null
  username: string | null
  email: string | null
  role: string | null
  /** Deno self-hosted only — omitted on Workers (no install wizard). */
  needsInstall?: boolean
  organizationId: string | null
}

function readSessionCookie(c: Context): string | null {
  const forwardedProto = c.req.header('x-forwarded-proto')
  const cookieName = resolveSessionCookieName(c.req.url, forwardedProto)
  return getCookie(c, cookieName) ?? null
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

function requestTls(c: Context) {
  return resolveRequestTls(c.req.url, c.req.header('x-forwarded-proto'))
}

function nowTs(): string {
  return new Date().toISOString()
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

function isUserEmailUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false

  const candidates: unknown[] = [err]
  if (typeof err === 'object' && err !== null && 'cause' in err) {
    candidates.push((err as { cause: unknown }).cause)
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const constraint = 'constraint_name' in candidate
      ? (candidate as { constraint_name?: unknown }).constraint_name
      : undefined
    if (constraint === 'user_email_unique') return true
  }

  const message = err instanceof Error ? err.message : String(err)
  return message.includes('user_email_unique')
}

function isVerificationDevLoggingEnabled(opts: AuthRouteOpts): boolean {
  if (opts.runtime !== 'deno' || typeof Deno === 'undefined') return false
  const mode = Deno.env.get('TURBOPANEL_UI_MODE')?.trim().toLowerCase()
  return mode !== 'static'
}

function resolveVerificationBaseUrl(
  c: Context,
  opts: AuthRouteOpts,
): string {
  if (opts.runtime === 'deno') {
    return opts.baseUrl?.trim() ||
      (typeof Deno !== 'undefined'
        ? Deno.env.get('TURBOPANEL_BASE_URL')?.trim()
        : undefined) ||
      new URL(c.req.url).origin
  }
  return new URL(c.req.url).origin
}

export async function buildSessionResponse(
  db: Db | undefined,
  runtime: AuthRouteOpts['runtime'],
  sessionData: {
    userId: string
    username: string | null
    email: string
    role: string
    organizationId: string | null
  },
): Promise<SessionResponse> {
  const base: SessionResponse = {
    ok: true,
    userId: sessionData.userId,
    username: sessionData.username,
    email: sessionData.email,
    role: sessionData.role,
    organizationId: sessionData.organizationId,
  }

  if (db === undefined) {
    return base
  }

  if (runtime === 'deno') {
    const needsInstall = !(await isInstanceInstalled(db))
    if (needsInstall) {
      return { ...base, needsInstall: true, organizationId: null }
    }
    return { ...base, needsInstall: false, organizationId: sessionData.organizationId }
  }

  return base
}

export function registerAuthRoutes(app: Hono, opts: AuthRouteOpts) {
  const auth = new Hono()

  auth.post('/sign-in', async (c) => {
    const db = getDb(c)
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const { username, password } = body as {
      username?: unknown
      password?: unknown
    }

    if (
      typeof username !== 'string' ||
      !username ||
      typeof password !== 'string' ||
      !password
    ) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    if (
      opts.runtime === 'deno' &&
      username === PAM_ROOT_USERNAME &&
      db &&
      !(await isInstanceInstalled(db))
    ) {
      return c.json(
        {
          ok: false,
          error: 'Complete initial setup on the install page with your host credentials',
        },
        403,
      )
    }

    const result = await verifyCredentials(username, password, opts.runtime, db)
    if (!result.ok) {
      return c.json({ ok: false, error: 'Invalid credentials' }, 401)
    }

    if (result.isRoot) {
      return c.json({ ok: false, error: 'Invalid credentials' }, 401)
    }

    const { token } = await createSession(db, result.userId, {
      ipAddress: c.req.header('X-Real-IP') ?? undefined,
      userAgent: c.req.header('User-Agent') ?? undefined,
      organizationId: db
        ? await getUserOrganizationId(db, result.userId)
        : null,
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

    return c.json(
      payload,
      200,
      {
        'Set-Cookie': setCookieHeader,
      },
    )
  })

  auth.post('/sign-out', async (c) => {
    const db = getDb(c)
    const cookieValue = readSessionCookie(c)

    if (cookieValue) {
      const result = await verifySignedCookie(cookieValue, opts.secrets)
      if (result) {
        await deleteSession(db, result.token)
      }
    }

    const tls = requestTls(c)
    let clearCookie =
      `${tls.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
    if (tls.isHttps) {
      clearCookie += '; Secure'
    }

    return c.json(
      { ok: true },
      200,
      {
        'Set-Cookie': clearCookie,
      },
    )
  })

  auth.post('/sign-up', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    if (!(await isInstanceInstalled(db))) {
      return c.json({ ok: false, error: 'Complete initial setup first' }, 403)
    }

    if (!(await isSignupEnabled(db, opts.signupEnvOverride))) {
      return c.json({ ok: false, error: 'Sign-up is not enabled' }, 403)
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

    const { email, password } = body as {
      email?: unknown
      password?: unknown
    }

    if (
      typeof email !== 'string' ||
      !email ||
      typeof password !== 'string' ||
      !password
    ) {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const emailError = validateSuperadminEmail(email)
    if (emailError) {
      return c.json({ ok: false, error: emailError }, 400)
    }

    const passwordError = validateSuperadminPassword(password)
    if (passwordError) {
      return c.json({ ok: false, error: passwordError }, 400)
    }

    const trimmedEmail = email.trim().toLowerCase()

    const existingUser = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, trimmedEmail))
      .limit(1)

    if (existingUser.length > 0) {
      return c.json({ ok: false, error: 'Email is already registered' }, 409)
    }

    const hashedPassword = await hashPassword(password)

    try {
      await db.transaction(async (tx) => {
        const insertedUser = await tx
          .insert(user)
          .values({
            email: trimmedEmail,
            isEmailVerified: false,
            role: 'user',
          })
          .returning({ id: user.id })

        const userId = insertedUser[0]?.id
        if (!userId) {
          throw new Error('User creation failed')
        }

        await tx.insert(account).values({
          userId,
          providerId: 'credential',
          providerUserId: userId,
          password: hashedPassword,
        })
      })
    } catch (err) {
      if (isUserEmailUniqueViolation(err)) {
        return c.json({ ok: false, error: 'Email is already registered' }, 409)
      }
      compatLogError('auth', `sign-up failed: ${err}`)
      return c.json({ ok: false, error: 'Sign-up failed' }, 500)
    }

    // Token generation must not roll back the already-committed user creation.
    try {
      const verificationToken = await createEmailVerificationToken(db, trimmedEmail)
      const baseOrigin = resolveVerificationBaseUrl(c, opts)
      const verificationUrl =
        `${baseOrigin}/verify-email?token=${encodeURIComponent(verificationToken)}`

      const queue = getEmailQueue(c)
      const emailFrom =
        c.get('emailFrom') ?? opts.emailFrom ?? 'noreply@turbopanel.local'
      if (queue) {
        try {
          await queue.enqueue({
            type: 'signup-verification',
            to: trimmedEmail,
            from: emailFrom,
            verificationUrl,
          })
          if (isVerificationDevLoggingEnabled(opts)) {
            compatLogInfo('dev', `verification email queued for ${trimmedEmail}`)
            compatLogInfo('dev', `verify URL: ${verificationUrl}`)
          }
        } catch (err) {
          compatLogWarn('email', `verification email enqueue failed: ${err}`)
        }
      } else {
        compatLogWarn(
          'email',
          `verification email not sent for ${trimmedEmail}: email queue unavailable`,
        )
      }
    } catch (err) {
      compatLogError('auth', `verification token generation failed: ${err}`)
    }

    return c.json({ ok: true }, 201)
  })

  auth.get('/verify-email', async (c) => {
    const token = c.req.query('token')
    if (!token) {
      return c.json({ ok: false, error: 'Missing token' }, 400)
    }

    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const identifier = await consumeEmailVerificationToken(db, token)
    if (identifier === null) {
      return c.json({ ok: false, error: 'Invalid or expired token' }, 400)
    }

    await db
      .update(user)
      .set({ isEmailVerified: true, updatedAt: nowTs() })
      .where(eq(user.email, identifier))

    return c.json({ ok: true }, 200)
  })

  registerOtpRoutes(auth, opts)

  app.route('/auth', auth)
  return app
}

export function registerAuthnRoutes(app: Hono, opts: AuthRouteOpts) {
  const authn = new Hono()

  authn.get('/session', async (c) => {
    const db = getDb(c)

    const cookieValue = readSessionCookie(c)
    if (!cookieValue) {
      return c.json({ ok: false }, 401)
    }

    const result = await verifySignedCookie(cookieValue, opts.secrets)
    if (!result) {
      return c.json({ ok: false }, 401)
    }

    const sessionData = await getSession(db, result.token)
    if (!sessionData) {
      return c.json({ ok: false }, 401)
    }

    const payload = await buildSessionResponse(db, opts.runtime, sessionData)
    return c.json(payload)
  })

  app.route('/authn', authn)
  return app
}
