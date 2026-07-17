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
import { createEmailOtp } from './email-otp.ts'
import { registerAuthRoutes } from './http.ts'
import { hashPassword } from './password.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './secrets.ts'
import {
  createSession,
  getSession,
} from './session-store.ts'

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
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  const client = new Hono()
  registerAuthRoutes(client, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  return { app, secrets }
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
  const { app } = await createAuthApp(db)

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

  const created = await createEmailOtp(db, email, 'forget-password', 300, {
    cooldownMs: 0,
  })
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
