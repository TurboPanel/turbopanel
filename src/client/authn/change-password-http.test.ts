/**
 * Signed-in password change and the server-side breached-password refusal on
 * sign-up, against a real Postgres. Skips without TURBOPANEL_DATABASE_URL.
 */
import { assert, assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { account, session, user, verification } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { hashPassword, verifyPassword } from '../../lib/secrets/password.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  breachedBreachResponder,
  captureWarnings,
  cleanBreachResponder,
  downBreachResponder,
} from '../../test-fixtures/breach.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  type AuthRateLimiter,
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from './auth-rate-limit.ts'
import { type BreachRangeResponder } from './breached-password.ts'
import { parseChangePasswordBody } from './change-password-http.ts'
import { registerAuthnRoutes, registerAuthRoutes } from './http.ts'
import { createSession } from './session-store.ts'
import { buildSignedCookie, HTTPS_SESSION_COOKIE_NAME } from './crypto.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep the alias so analysis sees these suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const ORIGIN = 'https://panel.example.com'
const AUTH = `${CLIENT_API_PREFIX}/auth`

type Db = ReturnType<typeof createDenoDb>

/** Built at run time so secret scanners never read a fixture as a credential. */
function strongCredential(): string {
  return `Aa1-${crypto.randomUUID()}`
}

/** The shipped step-up policy (`reauth`: 5 per 60 s), everything else unlimited. */
function reauthLimiter(): AuthRateLimiter {
  return createAuthRateLimiter({
    defaultPolicy: { limit: 1000, windowMs: 60_000 },
    policies: { reauth: { limit: 5, windowMs: 60_000 } },
  })
}

function uniqueIp(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2))
  return `198.18.${bytes[0]}.${bytes[1]}`
}

type Fixture = {
  app: Hono<AppEnv>
  db: Db
  /** A user with a password (or none), and a signed cookie for one fresh session. */
  addUser: (opts?: { password?: string | null }) => Promise<{
    userId: string
    email: string
    password: string
    cookie: () => Promise<string>
  }>
}

async function withFixture(
  options: { limiter?: AuthRateLimiter; responder?: BreachRangeResponder },
  fn: (fx: Fixture) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping change-password tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const config = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(config, 'session-signing')
  const limiter =
    options.limiter ?? createAuthRateLimiter({ defaultPolicy: { limit: 1000, windowMs: 60_000 } })
  setSharedAuthRateLimiterForTests(limiter)
  const responder = options.responder ?? cleanBreachResponder()

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('breachRangeResponder', responder)
    c.set('authRateLimiter', limiter)
    return next()
  })
  const client = new Hono<AppEnv>()
  const routeOpts = {
    secrets,
    runtime: 'workers' as const,
    signupEnvOverride: '1',
    baseUrl: ORIGIN,
  }
  registerAuthRoutes(client, routeOpts)
  registerAuthnRoutes(client, routeOpts)
  app.route(CLIENT_API_PREFIX, client)

  const userIds: string[] = []
  const emails: string[] = []
  const addUser: Fixture['addUser'] = async (opts = {}) => {
    const email = `chpw-${crypto.randomUUID()}@example.com`
    const password = opts.password ?? strongCredential()
    const [inserted] = await db
      .insert(user)
      .values({ email, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })
    const userId = inserted!.id
    userIds.push(userId)
    emails.push(email)
    if (opts.password !== null) {
      await db.insert(account).values({
        userId,
        providerId: 'credential',
        providerUserId: userId,
        password: await hashPassword(password),
      })
    }
    const cookie = async () => {
      const { token } = await createSession(db, userId, {})
      return `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
    }
    return { userId, email, password, cookie }
  }

  try {
    await fn({ app, db, addUser })
  } finally {
    setSharedAuthRateLimiterForTests(undefined)
    const created = await db.select({ id: user.id }).from(user).where(inArray(user.email, emails))
    const allIds = [...userIds, ...created.map((row) => row.id)]
    if (allIds.length > 0) {
      await db.delete(session).where(inArray(session.userId, allIds))
      await db.delete(account).where(inArray(account.userId, allIds))
      await db.delete(verification).where(inArray(verification.identifier, emails))
      await db.delete(user).where(inArray(user.id, allIds))
    }
    await endDbConnection(db)
  }
}

function postJson(
  app: Hono<AppEnv>,
  path: string,
  body: unknown,
  cookie?: string
): Promise<Response> {
  return Promise.resolve(
    app.request(`${ORIGIN}${AUTH}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': uniqueIp(),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
  )
}

async function sessionCount(db: Db, userId: string): Promise<number> {
  return (await db.select({ id: session.id }).from(session).where(eq(session.userId, userId)))
    .length
}

async function storedHash(db: Db, userId: string): Promise<string> {
  const rows = await db
    .select({ password: account.password })
    .from(account)
    .where(eq(account.userId, userId))
  return rows[0]?.password ?? ''
}

test('parseChangePasswordBody applies the sign-up rules and refuses an unchanged password', () => {
  const current = strongCredential()
  assertEquals(parseChangePasswordBody({ currentPassword: current }).ok, false)
  assertEquals(parseChangePasswordBody({ currentPassword: 1, newPassword: 2 }).ok, false)
  assertEquals(
    parseChangePasswordBody({ currentPassword: current, newPassword: 'short' }).ok,
    false
  )
  assertEquals(
    parseChangePasswordBody({ currentPassword: current, newPassword: ' Aa1-padded-pass ' }).ok,
    false
  )
  assertEquals(
    parseChangePasswordBody({ currentPassword: current, newPassword: 'x'.repeat(300) }).ok,
    false
  )
  assertEquals(parseChangePasswordBody({ currentPassword: current, newPassword: current }), {
    ok: false,
    error: 'password_unchanged',
  })
  assertEquals(
    parseChangePasswordBody({ currentPassword: current, newPassword: `${current}x` }).ok,
    true
  )
})

test('change-password needs a session', async () => {
  await withFixture({}, async ({ app }) => {
    const res = await postJson(app, 'change-password', {
      currentPassword: strongCredential(),
      newPassword: strongCredential(),
    })
    assertEquals(res.status, 401)
  })
})

test('change-password sets the new password, keeps this session and signs out the others', async () => {
  await withFixture({}, async ({ app, db, addUser }) => {
    const { userId, password, cookie } = await addUser()
    const mine = await cookie()
    await cookie()
    await cookie()
    assertEquals(await sessionCount(db, userId), 3)

    const next = strongCredential()
    const res = await postJson(
      app,
      'change-password',
      { currentPassword: password, newPassword: next },
      mine
    )
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true })
    assert(await verifyPassword(next, await storedHash(db, userId)))
    assertEquals(await sessionCount(db, userId), 1)

    const still = await app.request(`${ORIGIN}${CLIENT_API_PREFIX}/authn/session`, {
      headers: { cookie: mine },
    })
    assertEquals(still.status, 200)
  })
})

test('a wrong current password changes nothing and is throttled like any step-up', async () => {
  await withFixture({ limiter: reauthLimiter() }, async ({ app, db, addUser }) => {
    const { userId, password, cookie } = await addUser()
    const mine = await cookie()
    const before = await storedHash(db, userId)

    const statuses: number[] = []
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await postJson(
        app,
        'change-password',
        { currentPassword: strongCredential(), newPassword: strongCredential() },
        mine
      )
      statuses.push(res.status)
      if (attempt === 0) assertEquals((await res.json()).error, 'incorrect_current_password')
    }
    assertEquals(statuses.slice(0, 5), [400, 400, 400, 400, 400])
    assertEquals(statuses[5], 429, 'the sixth guess inside the window is throttled')
    assertEquals(await storedHash(db, userId), before)

    // Even the right password is refused while throttled.
    const right = await postJson(
      app,
      'change-password',
      { currentPassword: password, newPassword: strongCredential() },
      mine
    )
    assertEquals(right.status, 429)
    assertEquals(await storedHash(db, userId), before)
  })
})

test('the rules refuse a weak, unchanged or breached new password and change nothing', async () => {
  const breachedPassword = strongCredential()
  const responder = await breachedBreachResponder(breachedPassword)
  await withFixture({ responder }, async ({ app, db, addUser }) => {
    const { userId, password, cookie } = await addUser()
    const mine = await cookie()
    const before = await storedHash(db, userId)

    const weak = await postJson(
      app,
      'change-password',
      { currentPassword: password, newPassword: 'short' },
      mine
    )
    assertEquals(weak.status, 400)
    const same = await postJson(
      app,
      'change-password',
      { currentPassword: password, newPassword: password },
      mine
    )
    assertEquals((await same.json()).error, 'password_unchanged')

    const breached = await postJson(
      app,
      'change-password',
      { currentPassword: password, newPassword: breachedPassword },
      mine
    )
    assertEquals(breached.status, 400)
    assertEquals((await breached.json()).error, 'password_breached')
    assertEquals(responder.prefixes.length, 1)
    assertEquals(responder.prefixes[0]!.length, 5)
    assertEquals(await storedHash(db, userId), before)
    assertEquals(await sessionCount(db, userId), 1)
  })
})

test('an unreachable breach API allows the change and logs a warning without the password', async () => {
  await withFixture({ responder: downBreachResponder }, async ({ app, db, addUser }) => {
    const { userId, password, cookie } = await addUser()
    const mine = await cookie()
    const next = strongCredential()
    let status = 0
    const warnings = await captureWarnings(async () => {
      status = (
        await postJson(
          app,
          'change-password',
          { currentPassword: password, newPassword: next },
          mine
        )
      ).status
    })
    assertEquals(status, 200)
    assert(await verifyPassword(next, await storedHash(db, userId)))
    assertEquals(warnings.length, 1)
    assert(warnings[0]!.includes('breached-password check skipped'))
    assert(!warnings[0]!.includes(next))
  })
})

test('an account without a password is refused with no_password', async () => {
  await withFixture({}, async ({ app, addUser }) => {
    const { cookie } = await addUser({ password: null })
    const res = await postJson(
      app,
      'change-password',
      { currentPassword: strongCredential(), newPassword: strongCredential() },
      await cookie()
    )
    assertEquals(res.status, 409)
    assertEquals((await res.json()).error, 'no_password')
  })
})

test('sign-up refuses a breached password with password_breached, creating nothing', async () => {
  const breachedPassword = strongCredential()
  const responder = await breachedBreachResponder(breachedPassword)
  await withFixture({ responder }, async ({ app, db }) => {
    const email = `chpw-${crypto.randomUUID()}@example.com`
    const refused = await postJson(app, 'sign-up', { email, password: breachedPassword })
    assertEquals(refused.status, 400)
    assertEquals((await refused.json()).error, 'password_breached')
    assertEquals(
      (await db.select({ id: user.id }).from(user).where(eq(user.email, email))).length,
      0
    )

    const accepted = await postJson(app, 'sign-up', { email, password: strongCredential() })
    assertEquals(accepted.status, 201)
  })
})
