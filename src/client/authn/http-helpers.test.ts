import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createAuthRateLimiter,
  createFailClosedAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from './auth-rate-limit.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  readJsonBody,
  seedMockCredentialUser,
  seedMockInstalledInstance,
  seedMockSession,
  seedMockSignupEnabled,
  seedMockUser,
  withMockLogin,
} from './authn-hostfree-doubles.ts'
import { createEmailVerificationToken } from './email-verification.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
  HTTPS_SESSION_COOKIE_NAME,
} from './crypto.ts'
import {
  buildSessionResponse,
  enforceAuthRateLimit,
  isVerificationDevLoggingEnabled,
  parseSignupBody,
  registerAuthRoutes,
  registerAuthnRoutes,
} from './http.ts'
import { hashPassword } from './password.ts'
import { deriveSecretsConfig } from './secrets.ts'
import type { SessionData } from './session-store.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const sessionData = {
  userId: '00000000-0000-4000-8000-000000000099',
  email: 'user@example.com',
  role: 'user',
}

async function authSecrets() {
  const config = parseTestSecretsConfig('deno')
  return {
    secrets: await deriveSecretsConfig(config, 'session-signing'),
    otpVerifierSecrets: await deriveSecretsConfig(config, 'email-otp-verifier'),
  }
}

async function buildAuthApp(
  opts: {
    db?: ReturnType<typeof createMockAuthDb>
    runtime?: 'deno' | 'workers'
    secrets?: Awaited<ReturnType<typeof authSecrets>>['secrets']
    otpVerifierSecrets?: Awaited<ReturnType<typeof authSecrets>>['otpVerifierSecrets']
    signupEnvOverride?: '1' | '0'
    emailQueue?: { enqueue: (job: unknown) => Promise<void> }
    platformEnv?: Record<string, string | undefined>
  } = {},
) {
  const derived = await authSecrets()
  const app = new Hono<AppEnv>()
  const client = new Hono<AppEnv>()
  client.use('*', (c, next) => {
    if (opts.db) c.set('db', opts.db)
    if (opts.emailQueue) c.set('emailQueue', opts.emailQueue)
    if (opts.platformEnv) c.set('platformEnv', opts.platformEnv)
    c.set('authRateLimiter', createAuthRateLimiter({
      defaultPolicy: { limit: 10_000, windowMs: 60_000 },
    }))
    return next()
  })
  registerAuthRoutes(client, {
    secrets: opts.secrets ?? derived.secrets,
    otpVerifierSecrets: opts.otpVerifierSecrets ?? derived.otpVerifierSecrets,
    runtime: opts.runtime ?? 'workers',
    signupEnvOverride: opts.signupEnvOverride,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  return { app, secrets: opts.secrets ?? derived.secrets }
}

test('buildSessionResponse omits needsInstall when db is unavailable', async () => {
  const payload = await buildSessionResponse(undefined, 'deno', sessionData)
  assertEquals(payload.ok, true)
  assertEquals(payload.userId, sessionData.userId)
  assertEquals('needsInstall' in payload, false)
})

test('buildSessionResponse omits needsInstall on Workers even with db', async () => {
  const payload = await buildSessionResponse({} as never, 'workers', sessionData)
  assertEquals(payload.ok, true)
  assertEquals('needsInstall' in payload, false)
})

test('buildSessionResponse includes needsInstall on Deno before install', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const payload = await buildSessionResponse(db, 'deno', sessionData)
  assertEquals(payload.ok, true)
  assertEquals(payload.needsInstall, true)
})

test('buildSessionResponse sets needsInstall false after mock install', async () => {
  const state = createEmptyMockAuthState()
  seedMockInstalledInstance(state)
  const db = createMockAuthDb(state)
  const payload = await buildSessionResponse(db, 'deno', sessionData)
  assertEquals(payload.ok, true)
  assertEquals(payload.needsInstall, false)
})

test('isVerificationDevLoggingEnabled stays false on Workers', () => {
  assertEquals(
    isVerificationDevLoggingEnabled({
      runtime: 'workers',
      signupEnvOverride: undefined,
    }),
    false,
  )
})

test('isVerificationDevLoggingEnabled is true in explicit development mode', () => {
  const saved = new Map<string, string | undefined>()
  for (const key of ['TURBOPANEL_MODE', 'TURBOPANEL_UI_MODE'] as const) {
    saved.set(key, Deno.env.get(key))
  }
  try {
    Deno.env.set('TURBOPANEL_MODE', 'development')
    Deno.env.set('TURBOPANEL_UI_MODE', 'dev')
    assertEquals(
      isVerificationDevLoggingEnabled({
        runtime: 'deno',
        signupEnvOverride: undefined,
      }),
      true,
    )
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
})

test('parseSignupBody validates email and password shape', () => {
  assertEquals(parseSignupBody(null).ok, false)
  assertEquals(parseSignupBody({ email: 'bad', password: 'short' }).ok, false)
  const valid = parseSignupBody({
    email: 'signup-parse@example.com',
    password: 'Sup3r-secret!',
  })
  if (!valid.ok) throw new TypeError('expected valid signup body')
  assertEquals(valid.email, 'signup-parse@example.com')
})

test('sign-in returns 503 when session secrets are not configured', async () => {
  const { app } = await buildAuthApp()
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', password: 'x' }),
  })
  // registerAuthRoutes always gets secrets in buildAuthApp — test without secrets:
  const bare = new Hono<AppEnv>()
  const client = new Hono<AppEnv>()
  registerAuthRoutes(client, {
    runtime: 'workers',
    signupEnvOverride: undefined,
  })
  bare.route(CLIENT_API_PREFIX, client)
  const unconfigured = await bare.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com', password: 'x' }),
  })
  assertEquals(unconfigured.status, 503)
  assertEquals(res.status !== 503, true)
})

test('sign-in rejects malformed JSON and missing fields', async () => {
  const { app } = await buildAuthApp()
  const badJson = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  })
  assertEquals(badJson.status, 400)

  const missingPassword = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.com' }),
  })
  assertEquals(missingPassword.status, 400)
})

test('sign-in returns 401 for invalid credentials with mock db', async () => {
  const state = createEmptyMockAuthState()
  const db = createMockAuthDb(state)
  const { app } = await buildAuthApp({ db })
  withMockLogin(state, 'missing@example.com')

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '203.0.113.10',
    },
    body: JSON.stringify({ email: 'missing@example.com', password: 'wrong' }),
  })
  assertEquals(res.status, 401)
})

test('sign-in returns 403 when email is not verified', async () => {
  const state = createEmptyMockAuthState()
  const password = 'Sup3r-secret!'
  seedMockCredentialUser(state, {
    id: crypto.randomUUID(),
    email: 'unverified@example.com',
    password: await hashPassword(password),
    isEmailVerified: false,
  })
  const db = createMockAuthDb(withMockLogin(state, 'unverified@example.com'))
  const { app } = await buildAuthApp({ db })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '203.0.113.11',
    },
    body: JSON.stringify({ email: 'unverified@example.com', password }),
  })
  assertEquals(res.status, 403)
})

test('sign-in succeeds for verified mock user and sets session cookie', async () => {
  const state = createEmptyMockAuthState()
  const userId = crypto.randomUUID()
  const password = 'Sup3r-secret!'
  seedMockCredentialUser(state, {
    id: userId,
    email: 'verified@example.com',
    password: await hashPassword(password),
    isEmailVerified: true,
  })
  const db = createMockAuthDb(withMockLogin(state, 'verified@example.com'))
  const { app } = await buildAuthApp({ db, runtime: 'workers' })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '203.0.113.13',
    },
    body: JSON.stringify({ email: 'verified@example.com', password }),
  })
  assertEquals(res.status, 200)
  const body = await readJsonBody<{ ok: boolean; email: string }>(res)
  assertEquals(body.ok, true)
  assertEquals(body.email, 'verified@example.com')
  assertEquals(res.headers.get('Set-Cookie')?.includes('Max-Age='), true)
  assertEquals(state.insertedSessions.length, 1)
})

test('sign-out clears HTTP and HTTPS session cookies', async () => {
  const { app, secrets } = await buildAuthApp()
  const token = crypto.randomUUID()
  const signed = await buildSignedCookie(token, secrets)

  const httpRes = await app.request(`${CLIENT_API_PREFIX}/auth/sign-out`, {
    method: 'POST',
    headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
  })
  assertEquals(httpRes.status, 200)
  assertEquals(httpRes.headers.get('Set-Cookie')?.includes('Max-Age=0'), true)

  const httpsApp = new Hono<AppEnv>()
  const client = new Hono<AppEnv>()
  const derived = await authSecrets()
  registerAuthRoutes(client, {
    secrets: derived.secrets,
    otpVerifierSecrets: derived.otpVerifierSecrets,
    runtime: 'workers',
    signupEnvOverride: undefined,
  })
  httpsApp.route(CLIENT_API_PREFIX, client)

  const httpsRes2 = await httpsApp.request('https://panel.example.com/api/client/v1/auth/sign-out', {
    method: 'POST',
    headers: {
      Cookie: `${HTTPS_SESSION_COOKIE_NAME}=${signed}`,
    },
  })
  assertEquals(httpsRes2.status, 200)
  const cookies = httpsRes2.headers.getSetCookie?.() ?? []
  const joined = cookies.join(';')
  assertEquals(joined.includes(HTTPS_SESSION_COOKIE_NAME), true)
  assertEquals(joined.includes('__Secure-'), false)
})

test('verify-email requires token query param', async () => {
  const state = createEmptyMockAuthState()
  const { app } = await buildAuthApp({ db: createMockAuthDb(state) })
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/verify-email`)
  assertEquals(res.status, 400)
})

test('sign-up returns 503 when database is unavailable', async () => {
  const derived = await authSecrets()
  const app = new Hono<AppEnv>()
  const client = new Hono<AppEnv>()
  registerAuthRoutes(client, {
    secrets: derived.secrets,
    otpVerifierSecrets: derived.otpVerifierSecrets,
    runtime: 'workers',
    signupEnvOverride: '1',
  })
  app.route(CLIENT_API_PREFIX, client)

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'new@example.com', password: 'Sup3r-secret!' }),
  })
  assertEquals(res.status, 503)
})

test('sign-up returns 403 when signup override disables registration', async () => {
  const state = createEmptyMockAuthState()
  const { app } = await buildAuthApp({
    db: createMockAuthDb(state),
    runtime: 'workers',
    signupEnvOverride: '0',
  })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.14' },
    body: JSON.stringify({ email: 'new@example.com', password: 'Sup3r-secret!' }),
  })
  assertEquals(res.status, 403)
  const body = await readJsonBody<{ error: string }>(res)
  assertEquals(body.error, 'Sign-up is not enabled')
})

test('Workers sign-up succeeds with mock db and no email verification', async () => {
  const state = createEmptyMockAuthState()
  seedMockSignupEnabled(state, true)
  const { app } = await buildAuthApp({
    db: createMockAuthDb(state),
    runtime: 'workers',
    signupEnvOverride: '1',
  })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.15' },
    body: JSON.stringify({ email: 'new-worker@example.com', password: 'Sup3r-secret!' }),
  })
  assertEquals(res.status, 201)
  const body = await readJsonBody<{ ok: boolean }>(res)
  assertEquals(body.ok, true)
  assertEquals(state.users.length, 1)
  assertEquals(state.users[0]?.email, 'new-worker@example.com')
  assertEquals(state.organizations.length, 1)
})

test('Workers duplicate sign-up is indistinguishable with mock db', async () => {
  const state = createEmptyMockAuthState()
  seedMockSignupEnabled(state, true)
  const { app } = await buildAuthApp({
    db: createMockAuthDb(state),
    runtime: 'workers',
    signupEnvOverride: '1',
  })
  const body = JSON.stringify({ email: 'dup@example.com', password: 'Sup3r-secret!' })

  const first = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.16' },
    body,
  })
  const second = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.17' },
    body,
  })
  assertEquals(first.status, 201)
  assertEquals(second.status, 201)
})

test('verify-email consumes token and marks mock user verified', async () => {
  const state = createEmptyMockAuthState()
  const userId = crypto.randomUUID()
  const email = 'verify-mock@example.com'
  seedMockUser(state, {
    id: userId,
    email,
    isDisabled: false,
    isEmailVerified: false,
    role: 'user',
  })
  const db = createMockAuthDb(state)
  const token = await createEmailVerificationToken(db, email)
  const { app } = await buildAuthApp({ db, runtime: 'workers' })

  const res = await app.request(
    `${CLIENT_API_PREFIX}/auth/verify-email?token=${encodeURIComponent(token)}`,
  )
  assertEquals(res.status, 200)
  assertEquals(state.users[0]?.isEmailVerified, true)
  assertEquals(state.verificationRows.length, 0)
})

test('verify-email returns 400 for unknown token', async () => {
  const { app } = await buildAuthApp({
    db: createMockAuthDb(createEmptyMockAuthState()),
    runtime: 'workers',
  })
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/verify-email?token=not-a-real-token`)
  assertEquals(res.status, 400)
})

test('verify-email returns 404 when user row is missing', async () => {
  const state = createEmptyMockAuthState()
  const db = createMockAuthDb(state)
  const token = await createEmailVerificationToken(db, 'missing-user@example.com')
  const { app } = await buildAuthApp({ db, runtime: 'workers' })

  const res = await app.request(
    `${CLIENT_API_PREFIX}/auth/verify-email?token=${encodeURIComponent(token)}`,
  )
  assertEquals(res.status, 404)
})

test('Workers sign-up queues verification email when mail is configured', async () => {
  const state = createEmptyMockAuthState()
  seedMockSignupEnabled(state, true)
  let queued = false
  const { app } = await buildAuthApp({
    db: createMockAuthDb(state),
    runtime: 'workers',
    signupEnvOverride: '1',
    emailQueue: {
      enqueue: () => {
        queued = true
        return Promise.resolve()
      },
    },
    platformEnv: {
      TURBOPANEL_SYSTEM_EMAIL__PROVIDER: 'mailgun',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY: 'key-test',
      TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN: 'example.com',
      TURBOPANEL_SYSTEM_EMAIL__FROM: 'noreply@example.com',
    },
  })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.18' },
    body: JSON.stringify({ email: 'verify-signup@example.com', password: 'Sup3r-secret!' }),
  })
  assertEquals(res.status, 201)
  assertEquals(queued, true)
  assertEquals(state.users.length, 1)
  assertEquals(state.users[0]?.isEmailVerified, false)
})

test('registerAuthnRoutes session returns 401 without cookie', async () => {
  const derived = await authSecrets()
  const app = new Hono<AppEnv>()
  const client = new Hono<AppEnv>()
  registerAuthnRoutes(client, {
    secrets: derived.secrets,
    runtime: 'workers',
    signupEnvOverride: undefined,
  })
  app.route(CLIENT_API_PREFIX, client)

  const res = await app.request(`${CLIENT_API_PREFIX}/authn/session`)
  assertEquals(res.status, 401)
})

test('registerAuthnRoutes session returns user payload for signed cookie', async () => {
  const derived = await authSecrets()
  const state = createEmptyMockAuthState()
  const token = crypto.randomUUID()
  const sessionRow: SessionData = {
    sessionId: crypto.randomUUID(),
    userId: sessionData.userId,
    email: sessionData.email,
    role: 'user',
  }
  seedMockSession(state, token, sessionRow)
  const db = createMockAuthDb(state)
  const signed = await buildSignedCookie(token, derived.secrets)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  const client = new Hono<AppEnv>()
  registerAuthnRoutes(client, {
    secrets: derived.secrets,
    runtime: 'workers',
    signupEnvOverride: undefined,
  })
  app.route(CLIENT_API_PREFIX, client)

  const res = await app.request(`${CLIENT_API_PREFIX}/authn/session`, {
    headers: { Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}` },
  })
  assertEquals(res.status, 200)
  const body = await readJsonBody<{ ok: boolean; email: string }>(res)
  assertEquals(body.ok, true)
  assertEquals(body.email, sessionData.email)
})

test('enforceAuthRateLimit returns 429 when limiter blocks', async () => {
  setSharedAuthRateLimiterForTests(createFailClosedAuthRateLimiter())
  try {
    const app = new Hono()
    const captured = { response: null as Response | null }
    app.post('/rate-test', async (c) => {
      captured.response = await enforceAuthRateLimit(c, 'sign-in', 'user@example.com', 'deno')
      return c.text('ok')
    })
    await app.request('/rate-test', {
      method: 'POST',
      headers: { 'X-Real-IP': '203.0.113.12' },
    })
    if (!captured.response) {
      throw new TypeError('expected enforceAuthRateLimit to return a 429 response')
    }
    assertEquals(captured.response.status, 429)
    assertEquals(captured.response.headers.get('Retry-After') !== null, true)
  } finally {
    setSharedAuthRateLimiterForTests(undefined)
  }
})
