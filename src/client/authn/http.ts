import { eq } from 'drizzle-orm'
import { getCookie } from 'hono/cookie'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
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
import { isExplicitDevelopmentMode } from '../../dev-mode.ts'
import {
  parseTrustedProxyCidrs,
  resolvePeerAddress,
} from '../../lib/peer-address.ts'
import { readBoundedJson } from '../../lib/http/bounded-body.ts'
import {
  AUTH_SIGN_IN_MAX_BODY_BYTES,
  AUTH_SIGN_UP_MAX_BODY_BYTES,
  MAX_AUTH_PASSWORD_CHARS,
} from './auth-body-limits.ts'

export type AuthRouteOpts = {
  secrets?: DerivedSecretsConfig
  /**
   * HMAC keyring for at-rest email OTP verifiers (`email-otp-verifier` purpose).
   * Required for OTP create/verify routes; derived at boot from
   * `TURBOPANEL_SECRET` (or `TURBOPANEL_SECRETS` while rotating).
   */
  otpVerifierSecrets?: DerivedSecretsConfig
  runtime: 'deno' | 'workers'
  /**
   * Optional `TURBOPANEL_IS_SIGNUP_ENABLED` force override. When set to
   * `1`/`true` or `0`/`false` it overrides the `IS_SIGNUP_ENABLED` database
   * setting; when unset the DB (panel) toggle wins. Live Workers: set this
   * only in the Cloudflare dashboard (Worker `instance`) — do not commit it
   * under `env.live.vars` or every `wrangler deploy` will overwrite the
   * dashboard value. `keep_vars: true` preserves dashboard-only vars.
   */
  signupEnvOverride: SignupEnvOverride | undefined
  emailFrom?: string
  baseUrl?: string
}

export type SessionResponse = {
  ok: true
  userId: string | null
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
 * Resolve the client IP for rate-limit keying and session records, from trusted
 * runtime data only.
 *
 * Shares `resolvePeerAddress` with the daemon transports so one trust model
 * covers every inbound surface:
 *
 * - Workers: `CF-Connecting-IP` (edge-stamped; any client copy is stripped).
 * - Deno: `X-Real-IP` is Caddy's own socket peer. When that peer is a trusted
 *   local proxy — loopback by default, so a `cloudflared` connector beside the
 *   instance — `CF-Connecting-IP` / `X-Forwarded-For` are read instead. Behind a
 *   Cloudflare Tunnel that is the difference between per-visitor rate-limit
 *   buckets and every visitor sharing the `127.0.0.1` bucket.
 */
export function resolveClientIp(
  c: Context,
  runtime: 'deno' | 'workers',
): string | null {
  return resolvePeerAddress({
    realIp: c.req.header('X-Real-IP'),
    forwardedFor: c.req.header('X-Forwarded-For'),
    cfConnectingIp: c.req.header('CF-Connecting-IP'),
  }, { runtime, trustedProxyCidrs: trustedProxyCidrs() })?.address ?? null
}

/**
 * Env-configured trusted proxies, read once per process. `Deno.env` is absent
 * on Workers, where the trusted-proxy list is unused.
 */
let cachedTrustedProxyCidrs: string[] | undefined
function trustedProxyCidrs(): string[] {
  cachedTrustedProxyCidrs ??= parseTrustedProxyCidrs(
    (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } })
      .Deno?.env?.get('TURBOPANEL_TRUSTED_PROXY_CIDRS'),
  )
  return cachedTrustedProxyCidrs
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

export type AuthBodyValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/**
 * Bounded read → parse/validate → rate limit, in that order, for every public
 * auth route (`http.ts`, `otp-http.ts`, `lib/install/routes.ts`).
 *
 * The order matters: a malformed or oversized body must still charge a
 * rate-limit bucket before the handler returns, so the shape-validation path
 * cannot be used as a free probe. Since there is no parsed identity yet on
 * that path, it charges the purpose's **anonymous** identity bucket (plus the
 * caller's IP bucket, as always) — `enforceAuthRateLimit` with `identity:
 * null`. A request that parses and validates is charged exactly once, by its
 * real identity, after this returns.
 *
 * Also the point where {@link resolveEmailSettings} / other expensive,
 * secret-decrypting work must not run before — callers resolve that only
 * after this returns `ok: true`.
 */
export async function readGatedAuthJsonBody<T>(
  c: Context,
  opts: {
    runtime: 'deno' | 'workers'
    purpose: AuthRateLimitPurpose
    maxBytes: number
    parse: (body: unknown) => AuthBodyValidation<T>
    /** Identity to charge the real rate-limit bucket against once validated. */
    identity: (value: T) => string
  },
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const read = await readBoundedJson(c, opts.maxBytes)
  if (!read.ok) {
    const anonLimited = await enforceAuthRateLimit(c, opts.purpose, null, opts.runtime)
    if (anonLimited) return { ok: false, response: anonLimited }
    const status = read.reason === 'too-large' ? 413 : 400
    const error = read.reason === 'too-large' ? 'Request body too large' : 'Invalid request'
    return { ok: false, response: c.json({ ok: false, error }, status) }
  }

  const parsed = opts.parse(read.body)
  if (!parsed.ok) {
    const anonLimited = await enforceAuthRateLimit(c, opts.purpose, null, opts.runtime)
    if (anonLimited) return { ok: false, response: anonLimited }
    return { ok: false, response: c.json({ ok: false, error: parsed.error }, 400) }
  }

  const limited = await enforceAuthRateLimit(
    c,
    opts.purpose,
    opts.identity(parsed.value),
    opts.runtime,
  )
  if (limited) return { ok: false, response: limited }

  return { ok: true, value: parsed.value }
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

/**
 * Whether Deno may emit a sanitized "verification email queued" log line.
 *
 * Gated on {@link isExplicitDevelopmentMode} only — never on
 * `TURBOPANEL_UI_MODE !== 'static'` alone (that failed open whenever the var
 * was unset). Never logs the verification token or token-bearing URL; Mailpit
 * / the configured email sink remains the source for the actual link.
 */
export function isVerificationDevLoggingEnabled(opts: AuthRouteOpts): boolean {
  if (opts.runtime !== 'deno') return false
  return isExplicitDevelopmentMode()
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
    email: string
    role: string
  },
): Promise<SessionResponse> {
  const base: SessionResponse = {
    ok: true,
    userId: sessionData.userId,
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
    !password ||
    password.length > MAX_AUTH_PASSWORD_CHARS
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

type ParsedSignInBody =
  | { ok: true; email: string; password: string }
  | { ok: false; error: string }

/**
 * Shape-only validation — sign-in must accept any historically-valid
 * password (no complexity re-check against `validateSuperadminPassword`),
 * but still caps length before it ever reaches `verifyCredentials`
 * (argon2 verify cost scales with input size).
 */
export function parseSignInBody(body: unknown): ParsedSignInBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid request' }
  }

  const { email, password } = body as { email?: unknown; password?: unknown }

  if (
    typeof email !== 'string' ||
    !email ||
    typeof password !== 'string' ||
    !password ||
    password.length > MAX_AUTH_PASSWORD_CHARS
  ) {
    return { ok: false, error: 'Invalid request' }
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
      compatLogInfo('dev', 'verification email queued')
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

export function registerAuthRoutes(app: Hono<AppEnv>, opts: AuthRouteOpts) {
  const auth = new Hono<AppEnv>()

  auth.post('/sign-in', async (c) => {
    const db = getDb(c)
    const secrets = opts.secrets
    if (!secrets) {
      return c.json({ ok: false, error: 'Not configured' }, 503)
    }

    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'sign-in',
      maxBytes: AUTH_SIGN_IN_MAX_BODY_BYTES,
      parse: (body) => {
        const parsed = parseSignInBody(body)
        return parsed.ok ? { ok: true, value: parsed } : parsed
      },
      identity: (v) => v.email,
    })
    if (!gated.ok) return gated.response
    const { email, password } = gated.value

    if (
      opts.runtime === 'deno' &&
      email === PAM_ROOT_USERNAME &&
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

    const result = await verifyCredentials(email, password, opts.runtime, db)
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
    const clearAttrs = 'HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
    const clearPrimary =
      `${tls.cookieName}=; ${clearAttrs}${tls.isHttps ? '; Secure' : ''}`

    return c.json(
      { ok: true },
      200,
      {
        'Set-Cookie': clearPrimary,
      },
    )
  })

  auth.post('/sign-up', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    // Bounded read, shape validation, and the rate-limit charge all run before
    // any DB/crypto work — resolveSignupGate() below decrypts email settings,
    // which must never run for an unauthenticated flood ahead of the limiter.
    const gated = await readGatedAuthJsonBody(c, {
      runtime: opts.runtime,
      purpose: 'sign-up',
      maxBytes: AUTH_SIGN_UP_MAX_BODY_BYTES,
      parse: (body) => {
        const parsed = parseSignupBody(body)
        return parsed.ok ? { ok: true, value: parsed } : parsed
      },
      identity: (v) => v.email.trim().toLowerCase(),
    })
    if (!gated.ok) return gated.response
    const parsed = gated.value
    const trimmedEmail = parsed.email.trim().toLowerCase()

    const gate = await resolveSignupGate(c, opts, db)
    if (!gate.ok) {
      return gate.response
    }
    const { emailVerificationEnabled, emailQueue: signupQueue, emailFrom } = gate

    // Check email delivery before the existing-user branch so both new and
    // duplicate submissions see the same 503 when verification is required
    // but undeliverable (avoids account-existence oracle via status codes).
    if (emailVerificationEnabled && isNoopEmailQueue(signupQueue)) {
      return c.json(
        {
          ok: false,
          error: 'Sign-up is temporarily unavailable — email delivery is not configured.',
        },
        503,
      )
    }

    const existingUser = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, trimmedEmail))
      .limit(1)

    // Anti-enumeration: duplicate sign-ups return the same outward shape and
    // status as a successful new registration. Do not reveal whether the
    // email is already registered.
    if (existingUser.length > 0) {
      return c.json({ ok: true }, 201)
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
        return c.json({ ok: true }, 201)
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

export function registerAuthnRoutes(app: Hono<AppEnv>, opts: AuthRouteOpts) {
  const authn = new Hono<AppEnv>()

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
