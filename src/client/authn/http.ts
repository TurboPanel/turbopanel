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
  createOrganizationForUser,
  isInstanceInstalled,
  resolveEffectiveSignupEnabled,
  resolveSignupEnvOverrideFromContext,
  type SignupEnvOverride,
  validateSuperadminEmail,
  validateSuperadminPassword,
} from './install-state.ts'
import { resolvePublicBaseUrl } from '../../lib/resolve-public-base-url.ts'
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
import { type EmailQueue, getEmailQueue } from '../../lib/email/types.ts'
import { isNoopEmailQueue } from '../../lib/email/noop-queue.ts'
import { emailQueueFromResolvedSettings } from '../../lib/email/mailgun/workers-queue.ts'
import {
  isEmailActiveForRuntime,
  resolveEmailSettings,
} from '../../lib/settings/email-settings.ts'
import { registerOtpRoutes } from './otp-http.ts'
import {
  type AuthRateLimiter,
  type AuthRateLimitPurpose,
  createFailClosedAuthRateLimiter,
  getSharedAuthRateLimiter,
} from './auth-rate-limit.ts'

export type AuthRouteOpts = {
  secrets?: DerivedSecretsConfig
  /**
   * HMAC keyring for at-rest email OTP verifiers (`email-otp-verifier` purpose).
   * Required for OTP create/verify routes; derived at boot from
   * `TURBOPANEL_SECRET` / `TURBOPANEL_SECRETS`.
   */
  otpVerifierSecrets?: DerivedSecretsConfig
  runtime: 'deno' | 'workers'
  /**
   * Optional `TURBOPANEL_IS_SIGNUP_ENABLED` force override. When set to
   * `1`/`true` or `0`/`false` it overrides the `IS_SIGNUP_ENABLED` database
   * setting; when unset the DB (panel) toggle wins. Do not bake a production
   * default-disabled `0` into Wrangler vars — leave unset so admins can open
   * sign-up without a deploy.
   */
  signupEnvOverride: SignupEnvOverride | undefined
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
}

function readSessionCookie(
  c: Context,
  runtime: 'deno' | 'workers',
): string | null {
  const cookieName = resolveSessionCookieName({
    requestUrl: c.req.url,
    runtime,
    forwardedProto: c.req.header('x-forwarded-proto'),
  })
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

function requestTls(c: Context, runtime: 'deno' | 'workers') {
  return resolveRequestTls({
    requestUrl: c.req.url,
    runtime,
    forwardedProto: c.req.header('x-forwarded-proto'),
  })
}

/**
 * Resolve the client IP for rate-limit keying from trusted runtime data only.
 *
 * - Workers: prefer `CF-Connecting-IP` (edge-stamped). Ignore client-supplied
 *   `X-Real-IP` / `X-Forwarded-For`.
 * - Deno: trust `X-Real-IP` only when served behind the local Caddy → Unix
 *   socket path (the instance does not accept remote TCP). Ignore
 *   `X-Forwarded-For` (client-spoofable).
 */
export function resolveClientIp(
  c: Context,
  runtime: 'deno' | 'workers',
): string | null {
  if (runtime === 'workers') {
    const cfConnectingIp = c.req.header('CF-Connecting-IP')?.trim()
    return cfConnectingIp || null
  }

  // Deno behind local Caddy (Unix socket) — Caddy stamps X-Real-IP.
  const realIp = c.req.header('X-Real-IP')?.trim()
  return realIp || null
}

let failClosedWorkersLimiter: AuthRateLimiter | undefined

/**
 * Resolve the limiter for a request. The per-runtime entrypoint injects a
 * durable, globally-shared limiter into the request context. When it is absent:
 *
 * - **Workers**: never fall back to the per-isolate shared limiter (each isolate
 *   keeps its own counters, so abuse could rotate across them). Fail closed.
 * - **Deno / tests**: the process-local shared limiter is safe (single process).
 */
function resolveAuthRateLimiter(
  c: Context,
  runtime: 'deno' | 'workers',
): AuthRateLimiter {
  const injected = c.get('authRateLimiter') as AuthRateLimiter | undefined
  if (injected) return injected
  if (runtime === 'workers') {
    failClosedWorkersLimiter ??= createFailClosedAuthRateLimiter()
    return failClosedWorkersLimiter
  }
  return getSharedAuthRateLimiter()
}

/**
 * Enforce the durable auth rate limiter for a route. Resolves to a `429`
 * response when the caller has exceeded the window budget, or `null` when
 * allowed.
 */
export async function enforceAuthRateLimit(
  c: Context,
  purpose: AuthRateLimitPurpose,
  identity: string | null | undefined,
  runtime: 'deno' | 'workers',
): Promise<Response | null> {
  const result = await resolveAuthRateLimiter(c, runtime).check(
    purpose,
    identity,
    resolveClientIp(c, runtime),
  )
  if (result.allowed) {
    return null
  }
  return c.json({ ok: false, error: 'Too many requests' }, 429, {
    'Retry-After': String(result.retryAfterSeconds),
  })
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
  const platformEnv = c.get('platformEnv') as Record<string, string | undefined> | undefined
  const fromEnv = platformEnv?.TURBOPANEL_BASE_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  return new URL(c.req.url).origin
}

async function resolveVerificationBaseUrlAsync(
  c: Context,
  opts: AuthRouteOpts,
): Promise<string> {
  const direct = resolveVerificationBaseUrl(c, opts).trim()
  if (opts.runtime === 'deno') {
    return direct.replace(/\/$/, '')
  }
  if (direct && direct !== 'null' && !direct.includes('://null')) {
    return direct.replace(/\/$/, '')
  }
  const fromPublic = await resolvePublicBaseUrl(c, { baseUrl: opts.baseUrl })
  return fromPublic.replace(/\/$/, '')
}

export async function buildSessionResponse(
  db: Db | undefined,
  runtime: AuthRouteOpts['runtime'],
  sessionData: {
    userId: string
    username: string | null
    email: string
    role: string
  },
): Promise<SessionResponse> {
  const base: SessionResponse = {
    ok: true,
    userId: sessionData.userId,
    username: sessionData.username,
    email: sessionData.email,
    role: sessionData.role,
  }

  if (db === undefined) {
    return base
  }

  if (runtime === 'deno') {
    const needsInstall = !(await isInstanceInstalled(db))
    return { ...base, needsInstall }
  }

  return base
}

type ParsedSignupBody =
  | { ok: true; email: string; password: string }
  | { ok: false; error: string }

export function parseSignupBody(body: unknown): ParsedSignupBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }

  const { email, password } = body as { email?: unknown; password?: unknown }

  if (
    typeof email !== 'string' ||
    !email ||
    typeof password !== 'string' ||
    !password
  ) {
    return { ok: false, error: 'Invalid request' }
  }

  const emailError = validateSuperadminEmail(email)
  if (emailError) {
    return { ok: false, error: emailError }
  }

  const passwordError = validateSuperadminPassword(password)
  if (passwordError) {
    return { ok: false, error: passwordError }
  }

  return { ok: true, email, password }
}

type CreateSignupUserResult =
  | { ok: true; userId: string }
  | { ok: false; conflict: boolean }

async function createSignupUser(
  db: Db,
  trimmedEmail: string,
  hashedPassword: string,
  emailVerificationEnabled: boolean,
): Promise<CreateSignupUserResult> {
  let createdUserId: string | undefined
  try {
    await db.transaction(async (tx) => {
      const insertedUser = await tx
        .insert(user)
        .values({
          email: trimmedEmail,
          isEmailVerified: !emailVerificationEnabled,
          role: 'user',
        })
        .returning({ id: user.id })

      const userId = insertedUser[0]?.id
      if (!userId) {
        throw new Error('User creation failed')
      }
      createdUserId = userId

      await tx.insert(account).values({
        userId,
        providerId: 'credential',
        providerUserId: userId,
        password: hashedPassword,
      })
    })
  } catch (err) {
    if (isUserEmailUniqueViolation(err)) {
      return { ok: false, conflict: true }
    }
    compatLogError('auth', `sign-up failed: ${err}`)
    return { ok: false, conflict: false }
  }

  if (!createdUserId) {
    return { ok: false, conflict: false }
  }
  return { ok: true, userId: createdUserId }
}

async function provisionWorkersOrganization(
  db: Db,
  opts: AuthRouteOpts,
  userId: string,
): Promise<void> {
  if (opts.runtime !== 'workers') return
  try {
    await createOrganizationForUser(db, userId)
  } catch (err) {
    compatLogWarn('auth', `Workers sign-up org creation failed: ${err}`)
  }
}

async function enqueueSignupVerification(
  c: Context,
  opts: AuthRouteOpts,
  db: Db,
  queue: EmailQueue,
  trimmedEmail: string,
  userId: string,
  emailFrom: string,
): Promise<Response | null> {
  const verificationToken = await createEmailVerificationToken(db, trimmedEmail)
  const baseOrigin = await resolveVerificationBaseUrlAsync(c, opts)
  const verificationUrl =
    `${baseOrigin}/verify-email?token=${encodeURIComponent(verificationToken)}`

  try {
    await queue.enqueue({
      type: 'signup-verification',
      to: trimmedEmail,
      from: emailFrom,
      verificationUrl,
    })
    await provisionWorkersOrganization(db, opts, userId)
    if (isVerificationDevLoggingEnabled(opts)) {
      compatLogInfo('dev', `verification email queued for ${trimmedEmail}`)
      compatLogInfo('dev', `verify URL: ${verificationUrl}`)
    }
    return null
  } catch (err) {
    compatLogWarn('email', `verification email enqueue failed: ${err}`)
    if (opts.runtime === 'workers') {
      await db.delete(account).where(eq(account.userId, userId))
      await db.delete(user).where(eq(user.id, userId))
      return c.json(
        {
          ok: false,
          error: 'Could not send verification email. Please try again later.',
        },
        503,
      )
    }
    return null
  }
}

type SignupGate =
  | {
      ok: true
      emailVerificationEnabled: boolean
      /** Queue aligned with the same settings that decided verification. */
      emailQueue: EmailQueue | undefined
      emailFrom: string
    }
  | { ok: false; response: Response }

async function resolveSignupGate(
  c: Context,
  opts: AuthRouteOpts,
  db: Db,
): Promise<SignupGate> {
  if (opts.runtime === 'deno' && !(await isInstanceInstalled(db))) {
    return {
      ok: false,
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
      ok: false,
      response: c.json({ ok: false, error: 'Sign-up is not enabled' }, 403),
    }
  }

  const platformEnv = c.get('platformEnv') as
    | Record<string, string | undefined>
    | undefined
  const env =
    platformEnv ??
    (opts.runtime === 'deno' && typeof Deno !== 'undefined'
      ? Deno.env.toObject()
      : {})
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const emailSettings = await resolveEmailSettings(db, env, dataEncryptionSecrets)
  const emailVerificationEnabled = isEmailActiveForRuntime(
    emailSettings,
    opts.runtime,
  )
  // Prefer an injected context queue (Deno AMQP / test doubles). On Workers,
  // fall back to a queue derived from the *same* settings used for the
  // verification gate so admin email config changes apply without a restart
  // even if middleware omitted the queue.
  const emailQueue = getEmailQueue(c) ??
    (opts.runtime === 'workers'
      ? emailQueueFromResolvedSettings(emailSettings, env)
      : undefined)
  const emailFrom =
    emailSettings.from ||
    c.get('emailFrom') ||
    opts.emailFrom ||
    'noreply@turbopanel.local'
  return { ok: true, emailVerificationEnabled, emailQueue, emailFrom }
}

async function deliverSignupVerification(
  c: Context,
  opts: AuthRouteOpts,
  db: Db,
  queue: EmailQueue | undefined,
  trimmedEmail: string,
  userId: string,
  emailFrom: string,
): Promise<Response | null> {
  if (!queue) {
    compatLogWarn(
      'email',
      `verification email not sent for ${trimmedEmail}: email queue unavailable`,
    )
    return null
  }

  // Token generation must not roll back the already-committed user creation.
  try {
    return await enqueueSignupVerification(
      c,
      opts,
      db,
      queue,
      trimmedEmail,
      userId,
      emailFrom,
    )
  } catch (err) {
    compatLogError('auth', `verification token generation failed: ${err}`)
    return null
  }
}

export function registerAuthRoutes(app: Hono, opts: AuthRouteOpts) {
  const auth = new Hono()

  auth.post('/sign-in', async (c) => {
    const db = getDb(c)
    const secrets = opts.secrets
    if (!secrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
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

    const signInLimited = await enforceAuthRateLimit(
      c,
      'sign-in',
      username,
      opts.runtime,
    )
    if (signInLimited) {
      return signInLimited
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
      if (result.reason === 'email_not_verified') {
        return c.json(
          {
            ok: false,
            error: 'Verify your email before signing in. Check your inbox for the verification link.',
          },
          403,
        )
      }
      return c.json({ ok: false, error: 'Invalid credentials' }, 401)
    }

    if (result.isRoot) {
      return c.json({ ok: false, error: 'Invalid credentials' }, 401)
    }

    const { token } = await createSession(db, result.userId, {
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
    const secrets = opts.secrets
    if (!secrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
    }
    const cookieValue = readSessionCookie(c, opts.runtime)

    if (cookieValue) {
      const result = await verifySignedCookie(cookieValue, secrets)
      if (result) {
        await deleteSession(db, result.token)
      }
    }

    const tls = requestTls(c, opts.runtime)
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

    const gate = await resolveSignupGate(c, opts, db)
    if (!gate.ok) {
      return gate.response
    }
    const { emailVerificationEnabled, emailQueue: signupQueue, emailFrom } = gate

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid request' }, 400)
    }

    const parsed = parseSignupBody(body)
    if (!parsed.ok) {
      return c.json({ ok: false, error: parsed.error }, 400)
    }

    const trimmedEmail = parsed.email.trim().toLowerCase()

    const signupLimited = await enforceAuthRateLimit(
      c,
      'sign-up',
      trimmedEmail,
      opts.runtime,
    )
    if (signupLimited) {
      return signupLimited
    }

    const existingUser = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, trimmedEmail))
      .limit(1)

    if (existingUser.length > 0) {
      return c.json({ ok: false, error: 'Email is already registered' }, 409)
    }

    if (emailVerificationEnabled && isNoopEmailQueue(signupQueue)) {
      return c.json(
        {
          ok: false,
          error: 'Sign-up is temporarily unavailable — email delivery is not configured.',
        },
        503,
      )
    }

    const hashedPassword = await hashPassword(parsed.password)
    const created = await createSignupUser(
      db,
      trimmedEmail,
      hashedPassword,
      emailVerificationEnabled,
    )
    if (!created.ok) {
      if (created.conflict) {
        return c.json({ ok: false, error: 'Email is already registered' }, 409)
      }
      return c.json({ ok: false, error: 'Sign-up failed' }, 500)
    }

    if (!emailVerificationEnabled) {
      await provisionWorkersOrganization(db, opts, created.userId)
      return c.json({ ok: true }, 201)
    }

    const verificationResponse = await deliverSignupVerification(
      c,
      opts,
      db,
      signupQueue,
      trimmedEmail,
      created.userId,
      emailFrom,
    )
    if (verificationResponse) {
      return verificationResponse
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

    const normalizedEmail = identifier.trim().toLowerCase()
    const updated = await db
      .update(user)
      .set({ isEmailVerified: true, updatedAt: nowTs() })
      .where(eq(user.email, normalizedEmail))
      .returning({ id: user.id, isEmailVerified: user.isEmailVerified })

    if (updated.length === 0) {
      return c.json({ ok: false, error: 'User not found for verification token' }, 404)
    }

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
    const secrets = opts.secrets
    if (!secrets) {
      return c.json({ ok: false }, 401)
    }

    const cookieValue = readSessionCookie(c, opts.runtime)
    if (!cookieValue) {
      return c.json({ ok: false }, 401)
    }

    const result = await verifySignedCookie(cookieValue, secrets)
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
