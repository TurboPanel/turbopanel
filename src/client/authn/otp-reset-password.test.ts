import { eq } from 'drizzle-orm'
import { assertEquals } from '@std/assert'
import { afterEach, it } from '@std/testing/bdd'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { account, user } from '../../lib/db/schema.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from './auth-rate-limit.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockCredentialUser,
  seedMockExpiredOtpVerification,
  seedMockInstalledInstance,
  seedMockOtpVerification,
  seedMockSession,
  seedMockSignupEnabled,
  seedMockUser,
} from './authn-hostfree-doubles.ts'
import { createEmailOtp } from './email-otp.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from './crypto.ts'
import { registerAuthRoutes } from './http.ts'
import { hashPassword } from './password.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './secrets.ts'
import {
  createSession,
  getSession,
} from './session-store.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

afterEach(() => {
  setSharedAuthRateLimiterForTests(undefined)
})

async function createAuthApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    'email-otp-verifier',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  const client = new Hono()
  registerAuthRoutes(client, {
    secrets,
    otpVerifierSecrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  return { app, secrets, otpVerifierSecrets }
}

it('password reset revokes existing sessions', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping reset-password session revoke test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  const email = `reset-session-${crypto.randomUUID()}@example.com`
  const { app, otpVerifierSecrets } = await createAuthApp(db)

  const [insertedUser] = await db
    .insert(user)
    .values({
      email,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(account).values({
    userId,
    providerId: 'credential',
    providerUserId: userId,
    password: await hashPassword('old-password-1'),
  })

  const { token: oldToken } = await createSession(db, userId, {})
  assertEquals((await getSession(db, oldToken))?.userId, userId)

  const created = await createEmailOtp(
    db,
    email,
    'forget-password',
    otpVerifierSecrets,
    300,
    {
      cooldownMs: 0,
    },
  )
  assertEquals(created.status, 'created')
  if (created.status !== 'created') return

  const response = await app.request(
    `${CLIENT_API_PREFIX}/auth/reset-password/otp`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Real-IP': '203.0.113.60',
      },
      body: JSON.stringify({
        email,
        otp: created.otp,
        password: 'new-password-1',
      }),
    },
  )
  assertEquals(response.status, 200)
  assertEquals(await getSession(db, oldToken), null)

  await db.delete(account).where(eq(account.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
})

it('reset-password/otp rejects weak passwords before touching the OTP', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping reset-password weak-password test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  const { app } = await createAuthApp(db)

  // These weak passwords passed the old min-length-only rule; the centralized
  // server policy must now reject them with 400 before OTP verification.
  const weakPasswords = ['abcdefgh', '12345678', ' passw0rd! ']
  for (const password of weakPasswords) {
    const response = await app.request(
      `${CLIENT_API_PREFIX}/auth/reset-password/otp`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Real-IP': '203.0.113.62',
        },
        body: JSON.stringify({
          email: `reset-weak-${crypto.randomUUID()}@example.com`,
          otp: '000000',
          password,
        }),
      },
    )
    assertEquals(response.status, 400)
    const payload = (await response.json()) as { ok: boolean; error?: string }
    assertEquals(payload.ok, false)
  }
})

it('reset-password/otp returns 429 when the limiter is exceeded', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping reset-password rate-limit test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  setSharedAuthRateLimiterForTests(
    createAuthRateLimiter({
      defaultPolicy: { limit: 1, windowMs: 60_000 },
      policies: { 'reset-password': { limit: 1, windowMs: 60_000 } },
    }),
  )

  const db = createDenoDb()
  const email = `reset-limit-${crypto.randomUUID()}@example.com`
  const { app } = await createAuthApp(db)

  const makeRequest = () =>
    app.request(`${CLIENT_API_PREFIX}/auth/reset-password/otp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Real-IP': '203.0.113.61',
      },
      body: JSON.stringify({
        email,
        otp: '000000',
        password: 'new-password-1',
      }),
    })

  const first = await makeRequest()
  // Invalid OTP (or user missing) — but not rate-limited yet.
  assertEquals(first.status === 400 || first.status === 404, true)

  const second = await makeRequest()
  assertEquals(second.status, 429)
  assertEquals(second.headers.get('Retry-After') !== null, true)
})

async function buildOtpAuthApp(
  db: ReturnType<typeof createMockAuthDb> | undefined,
  opts: {
    otpVerifierSecrets?: Awaited<ReturnType<typeof deriveSecretsConfig>>
    runtime?: 'deno' | 'workers'
    signupEnvOverride?: '1' | '0'
    emailQueue?: { enqueue: (job: unknown) => Promise<void> }
    platformEnv?: Record<string, string | undefined>
  } = {},
) {
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = 'otpVerifierSecrets' in opts
    ? opts.otpVerifierSecrets
    : await deriveSecretsConfig(secretsConfig, 'email-otp-verifier')
  const app = new Hono<AppEnv>()
  const client = new Hono()
  client.use('*', (c, next) => {
    if (db) c.set('db', db)
    if (opts.emailQueue) c.set('emailQueue', opts.emailQueue)
    if (opts.platformEnv) c.set('platformEnv', opts.platformEnv)
    c.set('authRateLimiter', createAuthRateLimiter({
      defaultPolicy: { limit: 10_000, windowMs: 60_000 },
    }))
    return next()
  })
  registerAuthRoutes(client, {
    secrets,
    otpVerifierSecrets,
    runtime: opts.runtime ?? 'deno',
    signupEnvOverride: opts.signupEnvOverride,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  return { app, secrets, otpVerifierSecrets }
}

test('send-otp returns 503 when database is unavailable', async () => {
  const { app } = await buildOtpAuthApp(undefined)
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.70' },
    body: JSON.stringify({ email: 'otp@example.com', type: 'sign-in' }),
  })
  assertEquals(res.status, 503)
})

test('send-otp rejects invalid payloads before touching OTP storage', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpAuthApp(db)

  const invalidType = await app.request(`${CLIENT_API_PREFIX}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.71' },
    body: JSON.stringify({ email: 'otp@example.com', type: 'not-a-type' }),
  })
  assertEquals(invalidType.status, 400)

  const { app: noSecrets } = await buildOtpAuthApp(db, { otpVerifierSecrets: undefined })
  const unconfigured = await noSecrets.request(`${CLIENT_API_PREFIX}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.72' },
    body: JSON.stringify({ email: 'otp@example.com', type: 'sign-in' }),
  })
  assertEquals(unconfigured.status, 503)
})

test('verify-otp maps missing OTP rows to Invalid OTP', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpAuthApp(db)
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.73' },
    body: JSON.stringify({ email: 'otp@example.com', otp: '123456', type: 'sign-in' }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.error, 'Invalid OTP')
})

test('verify-email/otp requires an active session cookie', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpAuthApp(db)
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/verify-email/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.74' },
    body: JSON.stringify({ email: 'otp@example.com', otp: '123456' }),
  })
  assertEquals(res.status, 401)
})

test('reset-password/request-otp returns 503 without verifier secrets', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpAuthApp(db, { otpVerifierSecrets: undefined })
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/reset-password/request-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.75' },
    body: JSON.stringify({ email: 'reset@example.com' }),
  })
  assertEquals(res.status, 503)
})

test('sign-in/otp returns 503 when database is unavailable', async () => {
  const { app } = await buildOtpAuthApp(undefined)
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.76' },
    body: JSON.stringify({ email: 'otp@example.com', otp: '123456' }),
  })
  assertEquals(res.status, 503)
})

test('send-otp returns 200 for valid sign-in request with mock db', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpAuthApp(db)
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.77' },
    body: JSON.stringify({ email: 'otp@example.com', type: 'sign-in' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.ok, true)
})

test('sign-in/otp returns 400 for invalid OTP with mock db', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpAuthApp(db)
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.78' },
    body: JSON.stringify({ email: 'otp@example.com', otp: '123456' }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.error, 'Invalid OTP')
})

test('send-otp email-verification requires an active session cookie', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpAuthApp(db)
  const res = await app.request(`${CLIENT_API_PREFIX}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.79' },
    body: JSON.stringify({ email: 'otp@example.com', type: 'email-verification' }),
  })
  assertEquals(res.status, 401)
})

test('verify-email/otp rejects email mismatch for signed session', async () => {
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const state = createEmptyMockAuthState()
  const token = crypto.randomUUID()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    username: null,
    email: 'session@example.com',
    role: 'user',
  })
  const db = createMockAuthDb(state)
  const { app } = await buildOtpAuthApp(db)
  const signed = await buildSignedCookie(token, secrets)

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/verify-email/otp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Real-IP': '203.0.113.80',
      Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}`,
    },
    body: JSON.stringify({ email: 'other@example.com', otp: '123456' }),
  })
  assertEquals(res.status, 400)
})

test('sign-in/otp succeeds for existing mock user with seeded OTP', async () => {
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const otpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    'email-otp-verifier',
  )
  const state = createEmptyMockAuthState()
  const userId = crypto.randomUUID()
  const email = 'otp-success@example.com'
  seedMockUser(state, {
    id: userId,
    email,
    username: null,
    isDisabled: false,
    isEmailVerified: true,
    role: 'user',
  })
  await seedMockOtpVerification(state, email, 'sign-in', '654321', otpVerifierSecrets)
  const db = createMockAuthDb(state)
  const { app } = await buildOtpAuthApp(db)

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.81' },
    body: JSON.stringify({ email, otp: '654321' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.ok, true)
  assertEquals(body.email, email)
  assertEquals(res.headers.get('Set-Cookie')?.includes('HttpOnly'), true)
})

test('sign-in/otp auto-registers on Workers when signup is enabled', async () => {
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const otpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    'email-otp-verifier',
  )
  const state = createEmptyMockAuthState()
  seedMockSignupEnabled(state, true)
  const email = 'otp-new@example.com'
  await seedMockOtpVerification(state, email, 'sign-in', '112233', otpVerifierSecrets)
  const db = createMockAuthDb(state)
  const { app } = await buildOtpAuthApp(db, {
    runtime: 'workers',
    signupEnvOverride: '1',
  })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.82' },
    body: JSON.stringify({ email, otp: '112233', name: 'OTP User' }),
  })
  assertEquals(res.status, 200)
  assertEquals(state.users.length, 1)
  assertEquals(state.users[0]?.email, email)
})

test('verify-email/otp marks mock user verified with seeded OTP', async () => {
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    'email-otp-verifier',
  )
  const state = createEmptyMockAuthState()
  const userId = crypto.randomUUID()
  const email = 'verify-otp@example.com'
  seedMockUser(state, {
    id: userId,
    email,
    username: null,
    isDisabled: false,
    isEmailVerified: false,
    role: 'user',
  })
  const token = crypto.randomUUID()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    username: null,
    email,
    role: 'user',
  })
  await seedMockOtpVerification(state, email, 'email-verification', '445566', otpVerifierSecrets)
  const db = createMockAuthDb(state)
  const { app } = await buildOtpAuthApp(db)
  const signed = await buildSignedCookie(token, secrets)

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/verify-email/otp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Real-IP': '203.0.113.83',
      Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}`,
    },
    body: JSON.stringify({ email, otp: '445566' }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.ok, true)
  assertEquals(state.users[0]?.isEmailVerified, true)
})

test('verify-otp succeeds without consuming seeded OTP rows', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const state = createEmptyMockAuthState()
  const email = 'verify-otp-only@example.com'
  await seedMockOtpVerification(state, email, 'sign-in', '778899', otpVerifierSecrets)
  const db = createMockAuthDb(state)
  const { app } = await buildOtpAuthApp(db)

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.84' },
    body: JSON.stringify({ email, otp: '778899', type: 'sign-in' }),
  })
  assertEquals(res.status, 200)
  assertEquals(state.verificationRows.some((row) => row.identifier.startsWith('otp:')), true)
})

test('sign-in/otp rejects disabled mock users', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const state = createEmptyMockAuthState()
  const email = 'disabled-otp@example.com'
  seedMockUser(state, {
    id: crypto.randomUUID(),
    email,
    username: null,
    isDisabled: true,
    isEmailVerified: true,
    role: 'user',
  })
  await seedMockOtpVerification(state, email, 'sign-in', '334455', otpVerifierSecrets)
  const { app } = await buildOtpAuthApp(createMockAuthDb(state))

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.85' },
    body: JSON.stringify({ email, otp: '334455' }),
  })
  assertEquals(res.status, 403)
})

test('sign-in/otp requires install before auto-registration on Deno', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const state = createEmptyMockAuthState()
  seedMockSignupEnabled(state, true)
  const email = 'deno-new-otp@example.com'
  await seedMockOtpVerification(state, email, 'sign-in', '221133', otpVerifierSecrets)
  const { app } = await buildOtpAuthApp(createMockAuthDb(state), { signupEnvOverride: '1' })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.86' },
    body: JSON.stringify({ email, otp: '221133' }),
  })
  assertEquals(res.status, 403)
})

test('send-otp enqueues email when queue is configured', async () => {
  let enqueued = false
  const { app } = await buildOtpAuthApp(createMockAuthDb(createEmptyMockAuthState()), {
    emailQueue: {
      enqueue: async () => {
        enqueued = true
      },
    },
  })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.87' },
    body: JSON.stringify({ email: 'queued-otp@example.com', type: 'sign-in' }),
  })
  assertEquals(res.status, 200)
  assertEquals(enqueued, true)
})

test('reset-password/otp updates credential password with seeded OTP', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const state = createEmptyMockAuthState()
  const userId = crypto.randomUUID()
  const email = 'reset-otp@example.com'
  seedMockCredentialUser(state, {
    id: userId,
    email,
    password: await hashPassword('Old-secret1!'),
  })
  await seedMockOtpVerification(state, email, 'forget-password', '998877', otpVerifierSecrets)
  const { app } = await buildOtpAuthApp(createMockAuthDb(state))

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/reset-password/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.88' },
    body: JSON.stringify({
      email,
      otp: '998877',
      password: 'New-secret2!',
    }),
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.ok, true)
  assertEquals(state.accounts[0]?.password.startsWith('$argon2'), true)
})

test('reset-password/request-otp returns 200 with mock db', async () => {
  const state = createEmptyMockAuthState()
  seedMockCredentialUser(state, {
    id: crypto.randomUUID(),
    email: 'reset-request@example.com',
    password: await hashPassword('Old-secret1!'),
  })
  const { app } = await buildOtpAuthApp(createMockAuthDb(state))

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/reset-password/request-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.89' },
    body: JSON.stringify({ email: 'reset-request@example.com' }),
  })
  assertEquals(res.status, 200)
})

test('send-otp email-verification succeeds for signed session', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'session-signing',
  )
  const state = createEmptyMockAuthState()
  const email = 'session-send-otp@example.com'
  const token = crypto.randomUUID()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    username: null,
    email,
    role: 'user',
  })
  let enqueued = false
  const { app } = await buildOtpAuthApp(createMockAuthDb(state), {
    emailQueue: { enqueue: async () => { enqueued = true } },
  })
  const signed = await buildSignedCookie(token, secrets)

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/send-otp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Real-IP': '203.0.113.90',
      Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}`,
    },
    body: JSON.stringify({ email, type: 'email-verification' }),
  })
  assertEquals(res.status, 200)
  assertEquals(enqueued, true)
})

test('sign-in/otp returns 403 when signup is disabled for new users', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const email = 'signup-disabled-otp@example.com'
  const state = createEmptyMockAuthState()
  await seedMockOtpVerification(state, email, 'sign-in', '556677', otpVerifierSecrets)
  const { app } = await buildOtpAuthApp(createMockAuthDb(state), { runtime: 'workers' })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.91' },
    body: JSON.stringify({ email, otp: '556677' }),
  })
  assertEquals(res.status, 403)
})

test('verify-otp returns expired for stale seeded rows', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const email = 'expired-otp@example.com'
  const state = createEmptyMockAuthState()
  await seedMockExpiredOtpVerification(state, email, 'sign-in', '667788', otpVerifierSecrets)
  const { app } = await buildOtpAuthApp(createMockAuthDb(state))

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.92' },
    body: JSON.stringify({ email, otp: '667788', type: 'sign-in' }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.error, 'OTP expired')
})
