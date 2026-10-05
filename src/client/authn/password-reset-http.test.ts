/**
 * Forgot password (better-auth link flow) against a real Postgres: token
 * lookup, one-hour expiry and session revocation all depend on real query
 * predicates, which the in-memory auth doubles do not model. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { createDenoDb } from '../../db/connection.ts'
import { account, session, user, verification } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import type { EmailJob } from '../../features/email/types.ts'
import { hashPassword, verifyPassword } from '../../lib/secrets/password.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { cleanBreachResponder, breachedBreachResponder } from '../../test-fixtures/breach.ts'
import { createAuthRateLimiter } from './auth-rate-limit.ts'
import type { BreachRangeResponder } from './breached-password.ts'
import { registerAuthRoutes } from './http.ts'
import { createPasswordResetToken } from './password-reset.ts'
import { DEFAULT_PASSWORD_RESET_PAGE, safeResetPagePath } from './password-reset-http.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep the alias so analysis sees these suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const STRONG = 'N3w-Sup3r-secret!'
const OLD = 'Old-Sup3r-secret!'

type Fixture = {
  app: Hono<AppEnv>
  db: ReturnType<typeof createDenoDb>
  email: string
  userId: string
  jobs: EmailJob[]
}

async function withFixture(
  fn: (fx: Fixture) => Promise<void>,
  opts: { disabled?: boolean; credential?: boolean; responder?: BreachRangeResponder } = {}
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('password reset tests')
    return
  }
  const db = createDenoDb()
  const email = `reset-${crypto.randomUUID()}@example.com`
  const [row] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, isDisabled: opts.disabled ?? false })
    .returning({ id: user.id })
  const userId = row!.id
  if (opts.credential ?? true) {
    await db.insert(account).values({
      userId,
      providerId: 'credential',
      providerUserId: userId,
      password: await hashPassword(OLD),
    })
  }
  const jobs: EmailJob[] = []
  const config = parseTestSecretsConfig('deno')
  const app = new Hono<AppEnv>()
  const client = new Hono<AppEnv>()
  client.use('*', (c, next) => {
    c.set('db', db)
    c.set('emailQueue', {
      enqueue: (job) => {
        jobs.push(job)
        return Promise.resolve()
      },
    })
    c.set('platformEnv', { TURBOPANEL_BASE_URL: 'https://panel.example.com' })
    c.set('breachRangeResponder', opts.responder ?? cleanBreachResponder())
    c.set(
      'authRateLimiter',
      createAuthRateLimiter({ defaultPolicy: { limit: 10_000, windowMs: 60_000 } })
    )
    return next()
  })
  registerAuthRoutes(client, {
    secrets: await deriveSecretsConfig(config, 'session-signing'),
    otpVerifierSecrets: await deriveSecretsConfig(config, 'email-otp-verifier'),
    runtime: 'workers',
    signupEnvOverride: undefined,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  try {
    await fn({ app, db, email, userId, jobs })
  } finally {
    await db.delete(verification).where(eq(verification.identifier, `reset-password:${userId}`))
    await db.delete(session).where(eq(session.userId, userId))
    await db.delete(account).where(eq(account.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
  }
}

function post(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`${CLIENT_API_PREFIX}/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.40' },
      body: JSON.stringify(body),
    })
  )
}

async function credentialPassword(db: Fixture['db'], userId: string): Promise<string> {
  const rows = await db
    .select({ password: account.password })
    .from(account)
    .where(eq(account.userId, userId))
  return rows[0]?.password ?? ''
}

test('request-password-reset emails a one-hour link to the console reset page', async () => {
  await withFixture(async ({ app, email, jobs }) => {
    const res = await post(app, 'request-password-reset', { email })
    assertEquals(res.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertEquals(jobs.length, 1)
    const job = jobs[0]
    assert(job?.type === 'password-reset')
    const url = new URL(job.resetUrl)
    assertEquals(url.origin, 'https://panel.example.com')
    assert(url.pathname.startsWith(`${CLIENT_API_PREFIX}/auth/reset-password/`))
    assertEquals(url.searchParams.get('callbackURL'), DEFAULT_PASSWORD_RESET_PAGE)
  })
})

test('request-password-reset answers the same and sends nothing for an unknown, disabled or password-less account', async () => {
  const cases = [
    { opts: {}, email: `nobody-${crypto.randomUUID()}@example.com` },
    { opts: { disabled: true }, email: null },
    { opts: { credential: false }, email: null },
  ]
  for (const { opts, email: override } of cases) {
    await withFixture(async ({ app, email, jobs }) => {
      const res = await post(app, 'request-password-reset', { email: override ?? email })
      assertEquals(res.status, 200)
      assertEquals(await res.json(), { ok: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assertEquals(jobs.length, 0, JSON.stringify(opts))
    }, opts)
  }
})

test('the link redirects to the reset page with the token, or with INVALID_TOKEN', async () => {
  await withFixture(async ({ app, db, userId }) => {
    const token = await createPasswordResetToken(db, userId)
    const ok = await app.request(
      `${CLIENT_API_PREFIX}/auth/reset-password/${token}?callbackURL=%2Freset-password`
    )
    assertEquals(ok.status, 302)
    assertEquals(ok.headers.get('location'), `/reset-password?token=${token}`)

    const unknown = await app.request(
      `${CLIENT_API_PREFIX}/auth/reset-password/${'0'.repeat(64)}?callbackURL=https%3A%2F%2Fevil.example`
    )
    assertEquals(unknown.status, 302)
    assertEquals(unknown.headers.get('location'), '/reset-password?error=INVALID_TOKEN')
  })
})

test('a newer reset request replaces the older link', async () => {
  await withFixture(async ({ app, db, userId }) => {
    const first = await createPasswordResetToken(db, userId)
    await createPasswordResetToken(db, userId)
    const res = await post(app, 'reset-password', { newPassword: STRONG, token: first })
    assertEquals(res.status, 400)
    assertEquals(await res.json(), { ok: false, error: 'INVALID_TOKEN' })
  })
})

test('an expired link is refused', async () => {
  await withFixture(async ({ app, db, userId }) => {
    const token = await createPasswordResetToken(db, userId)
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(verification.identifier, `reset-password:${userId}`))
    const res = await post(app, 'reset-password', { newPassword: STRONG, token })
    assertEquals(res.status, 400)
    assert(await verifyPassword(OLD, await credentialPassword(db, userId)))
  })
})

test('reset-password sets the new password, uses the link up and signs out every session', async () => {
  await withFixture(async ({ app, db, userId }) => {
    await db.insert(session).values({
      userId,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const token = await createPasswordResetToken(db, userId)

    const res = await post(app, 'reset-password', { newPassword: STRONG, token })
    assertEquals(res.status, 200)
    assert(await verifyPassword(STRONG, await credentialPassword(db, userId)))
    const sessions = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, userId))
    assertEquals(sessions.length, 0)

    const again = await post(app, 'reset-password', { newPassword: STRONG, token })
    assertEquals(again.status, 400)
    assertEquals(await again.json(), { ok: false, error: 'INVALID_TOKEN' })
  })
})

test('reset-password refuses a weak password without using the link up', async () => {
  await withFixture(async ({ app, db, userId }) => {
    const token = await createPasswordResetToken(db, userId)
    const weak = await post(app, 'reset-password', { newPassword: 'short', token })
    assertEquals(weak.status, 400)
    const ok = await post(app, 'reset-password', { newPassword: STRONG, token })
    assertEquals(ok.status, 200)
  })
})

/** Built at run time so secret scanners never read a fixture as a credential. */
function freshCredential(): string {
  return `Aa1-${crypto.randomUUID()}`
}

test('reset-password refuses a breached password with password_breached and keeps the link usable', async () => {
  const breachedPassword = freshCredential()
  const responder = await breachedBreachResponder(breachedPassword)
  await withFixture(
    async ({ app, db, userId }) => {
      const token = await createPasswordResetToken(db, userId)
      const refused = await post(app, 'reset-password', { newPassword: breachedPassword, token })
      assertEquals(refused.status, 400)
      assertEquals((await refused.json()).error, 'password_breached')
      assert(await verifyPassword(OLD, await credentialPassword(db, userId)))
      assertEquals(responder.prefixes.length, 1)

      const ok = await post(app, 'reset-password', { newPassword: STRONG, token })
      assertEquals(ok.status, 200)
    },
    { responder }
  )
})

test('safeResetPagePath keeps an allowlisted app page and rejects everything else', () => {
  assertEquals(safeResetPagePath(' /reset-password '), '/reset-password')
  for (const value of [
    'https://evil.example/x',
    '//evil.example',
    '/\\evil',
    '/sign-in',
    '/reset-password?x=1',
    'reset',
    42,
    undefined,
  ]) {
    assertEquals(safeResetPagePath(value), DEFAULT_PASSWORD_RESET_PAGE, String(value))
  }
})
