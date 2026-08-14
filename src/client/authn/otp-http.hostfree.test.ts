/**
 * Host-free coverage for OTP HTTP handlers in otp-http.ts (validation branches
 * and handler wiring not duplicated in otp-reset-password.test.ts).
 */

import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  createAuthRateLimiter,
  type AuthRateLimitPurpose,
  type AuthRateLimiter,
} from './auth-rate-limit.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockCredentialUser,
  seedMockOtpVerification,
  seedMockSession,
  seedMockUser,
} from './authn-hostfree-doubles.ts'
import {
  buildSignedCookie,
  HTTPS_SESSION_COOKIE_NAME,
  HTTP_SESSION_COOKIE_NAME,
} from './crypto.ts'
import { MAX_OTP_ATTEMPTS } from './email-otp.ts'
import { hashPassword } from './password.ts'
import { registerOtpRoutes } from './otp-http.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const AUTH_PREFIX = `${CLIENT_API_PREFIX}/auth`

function tightAuthRateLimiter(purpose: AuthRateLimitPurpose): AuthRateLimiter {
  const policy = { limit: 1, windowMs: 60_000 }
  return createAuthRateLimiter({
    defaultPolicy: policy,
    policies: { [purpose]: policy },
  })
}

async function buildOtpApp(
  db: ReturnType<typeof createMockAuthDb> | undefined,
  opts: {
    otpVerifierSecrets?: Awaited<ReturnType<typeof deriveSecretsConfig>>
    runtime?: 'deno' | 'workers'
    emailQueue?: { enqueue: (job: unknown) => Promise<void> }
    authRateLimiter?: AuthRateLimiter
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
  const auth = new Hono<AppEnv>()
  auth.use('*', (c, next) => {
    if (db) c.set('db', db)
    if (opts.emailQueue) c.set('emailQueue', opts.emailQueue)
    c.set(
      'authRateLimiter',
      opts.authRateLimiter ?? createAuthRateLimiter({
        defaultPolicy: { limit: 10_000, windowMs: 60_000 },
      }),
    )
    return next()
  })
  registerOtpRoutes(auth, {
    secrets,
    otpVerifierSecrets,
    runtime: opts.runtime ?? 'deno',
    signupEnvOverride: undefined,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(AUTH_PREFIX, auth)
  return { app, secrets, otpVerifierSecrets }
}

test('send-otp rejects malformed JSON and non-object bodies', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpApp(db)

  const badJson = await app.request(`${AUTH_PREFIX}/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.100' },
    body: '{',
  })
  assertEquals(badJson.status, 400)

  const arrayBody = await app.request(`${AUTH_PREFIX}/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.101' },
    body: JSON.stringify([]),
  })
  assertEquals(arrayBody.status, 400)
})

test('send-otp rejects invalid email before OTP storage', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpApp(db)

  const res = await app.request(`${AUTH_PREFIX}/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.102' },
    body: JSON.stringify({ email: 'not-an-email', type: 'sign-in' }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.ok, false)
  assertEquals(body.error, 'Enter a valid email address')
})

test('verify-otp rejects invalid email before verifier lookup', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpApp(db)

  const res = await app.request(`${AUTH_PREFIX}/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.103' },
    body: JSON.stringify({ email: 'bad', otp: '123456', type: 'sign-in' }),
  })
  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.error, 'Enter a valid email address')
})

test('sign-in/otp rejects non-string name and invalid email', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpApp(db)

  const badName = await app.request(`${AUTH_PREFIX}/sign-in/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.104' },
    body: JSON.stringify({ email: 'user@example.com', otp: '123456', name: 42 }),
  })
  assertEquals(badName.status, 400)

  const badEmail = await app.request(`${AUTH_PREFIX}/sign-in/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.105' },
    body: JSON.stringify({ email: 'not-an-email', otp: '123456' }),
  })
  assertEquals(badEmail.status, 400)
  assertEquals((await badEmail.json()).error, 'Enter a valid email address')
})

test('send-otp email-verification rejects email mismatch for signed session', async () => {
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
    email: 'session@example.com',
    role: 'user',
  })
  const { app } = await buildOtpApp(createMockAuthDb(state))
  const signed = await buildSignedCookie(token, secrets)

  const res = await app.request(`${AUTH_PREFIX}/send-otp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Real-IP': '203.0.113.106',
      Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}`,
    },
    body: JSON.stringify({ email: 'other@example.com', type: 'email-verification' }),
  })
  assertEquals(res.status, 400)
})

test('reset-password/otp rejects weak password before OTP verification', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpApp(db)

  const res = await app.request(`${AUTH_PREFIX}/reset-password/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.107' },
    body: JSON.stringify({
      email: 'reset@example.com',
      otp: '123456',
      password: 'abcdefgh',
    }),
  })
  assertEquals(res.status, 400)
  assertEquals(
    (await res.json()).error,
    'Password must include at least one number',
  )
})

test('reset-password/otp returns 404 when user row is missing after valid OTP', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const email = 'ghost-reset@example.com'
  const state = createEmptyMockAuthState()
  await seedMockOtpVerification(state, email, 'forget-password', '445566', otpVerifierSecrets)
  const { app } = await buildOtpApp(createMockAuthDb(state))

  const res = await app.request(`${AUTH_PREFIX}/reset-password/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.108' },
    body: JSON.stringify({
      email,
      otp: '445566',
      password: 'New-secret2!',
    }),
  })
  assertEquals(res.status, 404)
  assertEquals((await res.json()).error, 'User not found')
})

test('reset-password/otp returns 404 for disabled users', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const email = 'disabled-reset@example.com'
  const state = createEmptyMockAuthState()
  seedMockUser(state, {
    id: crypto.randomUUID(),
    email,
    isDisabled: true,
    isEmailVerified: true,
    role: 'user',
  })
  await seedMockOtpVerification(state, email, 'forget-password', '778899', otpVerifierSecrets)
  const { app } = await buildOtpApp(createMockAuthDb(state))

  const res = await app.request(`${AUTH_PREFIX}/reset-password/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.109' },
    body: JSON.stringify({
      email,
      otp: '778899',
      password: 'New-secret2!',
    }),
  })
  assertEquals(res.status, 404)
  assertEquals((await res.json()).error, 'User not found')
})

test('reset-password/otp returns 404 when credential account is missing', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const email = 'no-account@example.com'
  const state = createEmptyMockAuthState()
  seedMockUser(state, {
    id: crypto.randomUUID(),
    email,
    isDisabled: false,
    isEmailVerified: true,
    role: 'user',
  })
  await seedMockOtpVerification(state, email, 'forget-password', '112233', otpVerifierSecrets)
  const { app } = await buildOtpApp(createMockAuthDb(state))

  const res = await app.request(`${AUTH_PREFIX}/reset-password/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.110' },
    body: JSON.stringify({
      email,
      otp: '112233',
      password: 'New-secret2!',
    }),
  })
  assertEquals(res.status, 404)
})

test('verify-otp returns 429 after too many failed attempts', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const email = 'locked-otp@example.com'
  const state = createEmptyMockAuthState()
  await seedMockOtpVerification(state, email, 'sign-in', '654321', otpVerifierSecrets)
  const { app } = await buildOtpApp(createMockAuthDb(state))

  for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) {
    const attempt = await app.request(`${AUTH_PREFIX}/verify-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.111' },
      body: JSON.stringify({ email, otp: '000000', type: 'sign-in' }),
    })
    assertEquals(attempt.status, 400)
  }

  const locked = await app.request(`${AUTH_PREFIX}/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.112' },
    body: JSON.stringify({ email, otp: '654321', type: 'sign-in' }),
  })
  assertEquals(locked.status, 429)
  assertEquals((await locked.json()).error, 'Too many attempts')
})

test('reset-password/request-otp rejects invalid email', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const { app } = await buildOtpApp(db)

  const res = await app.request(`${AUTH_PREFIX}/reset-password/request-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.113' },
    body: JSON.stringify({ email: 'not-an-email' }),
  })
  assertEquals(res.status, 400)
  assertEquals((await res.json()).error, 'Enter a valid email address')
})

test('send-otp returns 200 during resend cooldown without leaking state', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const state = createEmptyMockAuthState()
  const email = 'cooldown-otp@example.com'
  const { createEmailOtp } = await import('./email-otp.ts')
  const db = createMockAuthDb(state)
  await createEmailOtp(db, email, 'sign-in', otpVerifierSecrets)
  const { app } = await buildOtpApp(db)

  const res = await app.request(`${AUTH_PREFIX}/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.114' },
    body: JSON.stringify({ email, type: 'sign-in' }),
  })
  assertEquals(res.status, 200)
  assertEquals((await res.json()).ok, true)
})

test('reset-password/otp updates password for mock credential user', async () => {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const email = 'cred-reset@example.com'
  const state = createEmptyMockAuthState()
  seedMockCredentialUser(state, {
    id: crypto.randomUUID(),
    email,
    password: await hashPassword('Old-secret1!'),
  })
  await seedMockOtpVerification(state, email, 'forget-password', '998877', otpVerifierSecrets)
  const { app } = await buildOtpApp(createMockAuthDb(state))

  const res = await app.request(`${AUTH_PREFIX}/reset-password/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.115' },
    body: JSON.stringify({
      email,
      otp: '998877',
      password: 'New-secret2!',
    }),
  })
  assertEquals(res.status, 200)
  assertEquals(state.accounts[0]?.password.startsWith('$argon2'), true)
})

test('send-otp returns 429 when auth rate limit is exceeded', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const email = 'rate-send@example.com'
  const { app } = await buildOtpApp(db, {
    authRateLimiter: tightAuthRateLimiter('send-otp'),
  })

  const makeRequest = () =>
    app.request(`${AUTH_PREFIX}/send-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.120' },
      body: JSON.stringify({ email, type: 'sign-in' }),
    })

  assertEquals((await makeRequest()).status, 200)
  const limited = await makeRequest()
  assertEquals(limited.status, 429)
  assertEquals((await limited.json()).error, 'Too many requests')
  assertEquals(limited.headers.get('Retry-After') !== null, true)
})

test('verify-otp returns 429 when auth rate limit is exceeded', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const email = 'rate-verify@example.com'
  const { app } = await buildOtpApp(db, {
    authRateLimiter: tightAuthRateLimiter('verify-otp'),
  })

  const makeRequest = () =>
    app.request(`${AUTH_PREFIX}/verify-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.121' },
      body: JSON.stringify({ email, otp: '000000', type: 'sign-in' }),
    })

  assertEquals((await makeRequest()).status, 400)
  const limited = await makeRequest()
  assertEquals(limited.status, 429)
  assertEquals((await limited.json()).error, 'Too many requests')
})

test('sign-in/otp returns 429 when auth rate limit is exceeded', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const email = 'rate-signin@example.com'
  const { app } = await buildOtpApp(db, {
    authRateLimiter: tightAuthRateLimiter('sign-in-otp'),
  })

  const makeRequest = () =>
    app.request(`${AUTH_PREFIX}/sign-in/otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.122' },
      body: JSON.stringify({ email, otp: '000000' }),
    })

  assertEquals((await makeRequest()).status, 400)
  const limited = await makeRequest()
  assertEquals(limited.status, 429)
  assertEquals((await limited.json()).error, 'Too many requests')
})

test('reset-password/request-otp returns 429 when auth rate limit is exceeded', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const email = 'rate-reset-req@example.com'
  const { app } = await buildOtpApp(db, {
    authRateLimiter: tightAuthRateLimiter('reset-password-request'),
  })

  const makeRequest = () =>
    app.request(`${AUTH_PREFIX}/reset-password/request-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.123' },
      body: JSON.stringify({ email }),
    })

  assertEquals((await makeRequest()).status, 200)
  const limited = await makeRequest()
  assertEquals(limited.status, 429)
  assertEquals((await limited.json()).error, 'Too many requests')
})

test('reset-password/otp returns 429 when auth rate limit is exceeded', async () => {
  const db = createMockAuthDb(createEmptyMockAuthState())
  const email = 'rate-reset@example.com'
  const { app } = await buildOtpApp(db, {
    authRateLimiter: tightAuthRateLimiter('reset-password'),
  })

  const makeRequest = () =>
    app.request(`${AUTH_PREFIX}/reset-password/otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Real-IP': '203.0.113.124' },
      body: JSON.stringify({
        email,
        otp: '000000',
        password: 'New-secret2!',
      }),
    })

  const first = await makeRequest()
  assertEquals(first.status === 400 || first.status === 404, true)
  const limited = await makeRequest()
  assertEquals(limited.status, 429)
  assertEquals((await limited.json()).error, 'Too many requests')
})

async function seedSignInOtpSuccessState() {
  const otpVerifierSecrets = await deriveSecretsConfig(
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno'),
    'email-otp-verifier',
  )
  const state = createEmptyMockAuthState()
  const email = 'secure-cookie@example.com'
  seedMockUser(state, {
    id: crypto.randomUUID(),
    email,
    isDisabled: false,
    isEmailVerified: true,
    role: 'user',
  })
  await seedMockOtpVerification(state, email, 'sign-in', '654321', otpVerifierSecrets)
  return { state, email, otpVerifierSecrets }
}

test('sign-in/otp sets Secure __Host- cookie on HTTPS Workers request URL', async () => {
  const { state, email, otpVerifierSecrets } = await seedSignInOtpSuccessState()
  const { app } = await buildOtpApp(createMockAuthDb(state), {
    otpVerifierSecrets,
    runtime: 'workers',
  })

  const res = await app.request(`https://localhost:8443${AUTH_PREFIX}/sign-in/otp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '203.0.113.125',
    },
    body: JSON.stringify({ email, otp: '654321' }),
  })
  assertEquals(res.status, 200)
  const cookie = res.headers.get('Set-Cookie') ?? ''
  assertEquals(cookie.startsWith(`${HTTPS_SESSION_COOKIE_NAME}=`), true)
  assertEquals(cookie.includes('; Secure'), true)
  assertEquals(cookie.startsWith(`${HTTP_SESSION_COOKIE_NAME}=`), false)
})

test('sign-in/otp omits Secure on plain HTTP Workers request URL', async () => {
  const { state, email, otpVerifierSecrets } = await seedSignInOtpSuccessState()
  const { app } = await buildOtpApp(createMockAuthDb(state), {
    otpVerifierSecrets,
    runtime: 'workers',
  })

  const res = await app.request(`http://localhost:8880${AUTH_PREFIX}/sign-in/otp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '203.0.113.126',
      'x-forwarded-proto': 'https',
    },
    body: JSON.stringify({ email, otp: '654321' }),
  })
  assertEquals(res.status, 200)
  const cookie = res.headers.get('Set-Cookie') ?? ''
  assertEquals(cookie.startsWith(`${HTTP_SESSION_COOKIE_NAME}=`), true)
  assertEquals(cookie.includes('; Secure'), false)
})

test('sign-in/otp honors x-forwarded-proto https on Deno trusted proxy', async () => {
  const { state, email, otpVerifierSecrets } = await seedSignInOtpSuccessState()
  const { app } = await buildOtpApp(createMockAuthDb(state), {
    otpVerifierSecrets,
    runtime: 'deno',
  })

  const res = await app.request(`${AUTH_PREFIX}/sign-in/otp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Real-IP': '203.0.113.127',
      'x-forwarded-proto': 'https',
    },
    body: JSON.stringify({ email, otp: '654321' }),
  })
  assertEquals(res.status, 200)
  const cookie = res.headers.get('Set-Cookie') ?? ''
  assertEquals(cookie.startsWith(`${HTTPS_SESSION_COOKIE_NAME}=`), true)
  assertEquals(cookie.includes('; Secure'), true)
})
