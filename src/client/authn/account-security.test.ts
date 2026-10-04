/**
 * Account-security journeys against a real Postgres, through the real auth
 * routes (checklist rows auth-signin, auth-signin-throttle, auth-verify-email,
 * auth-totp-enroll, auth-totp-disable, auth-password-change reset half,
 * auth-oauth-link unlink). Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, inArray, like } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { account, session, user, verification } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { hashPassword } from '../../lib/secrets/password.ts'
import { forEachSequential, mapSequential } from '../../lib/sequential.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  type AuthRateLimiter,
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from './auth-rate-limit.ts'
import { buildSignedCookie, HTTPS_SESSION_COOKIE_NAME } from './crypto.ts'
import { createEmailVerificationToken } from './email-verification.ts'
import { registerAuthnRoutes, registerAuthRoutes } from './http.ts'
import { createPasswordResetToken } from './password-reset.ts'
import { createSession } from './session-store.ts'
import { decodeBase32, generateTotp } from './totp.ts'
import { BACKUP_CODE_VERIFIER_PURPOSE, TWO_FACTOR_CHALLENGE_PURPOSE } from './two-factor.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep the alias so analysis sees these suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const ORIGIN = 'https://panel.example.com'
const AUTH = `${CLIENT_API_PREFIX}/auth`

type Db = ReturnType<typeof createDenoDb>
type Runtime = 'deno' | 'workers'

/** Built at run time so secret scanners never read a fixture as a credential. */
function strongCredential(): string {
  return `Aa1-${crypto.randomUUID()}`
}

function uniqueIp(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2))
  return `198.51.${bytes[0]}.${bytes[1]}`
}

type Fixture = {
  app: Hono<AppEnv>
  db: Db
  addUser: (opts?: { password?: string | null; verified?: boolean }) => Promise<{
    userId: string
    email: string
    password: string
  }>
}

/** `limiter: 'shipped'` leaves the process-wide limiter with its shipped policies in charge. */
type FixtureOptions = { runtime?: Runtime; limiter?: AuthRateLimiter | 'shipped' }

function resolveLimiter(option: FixtureOptions['limiter']): AuthRateLimiter | undefined {
  if (option === 'shipped') return undefined
  return option ?? createAuthRateLimiter({ defaultPolicy: { limit: 1000, windowMs: 60_000 } })
}

async function withFixture(
  options: FixtureOptions,
  fn: (fx: Fixture) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('account-security tests')
    return
  }
  const runtime = options.runtime ?? 'deno'
  const db = createDenoDb()
  const config = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(config, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(config, 'data-encryption')
  const twoFactorChallengeSecrets = await deriveSecretsConfig(config, TWO_FACTOR_CHALLENGE_PURPOSE)
  const backupCodeVerifierSecrets = await deriveSecretsConfig(config, BACKUP_CODE_VERIFIER_PURPOSE)
  const limiter = resolveLimiter(options.limiter)
  setSharedAuthRateLimiterForTests(limiter)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    if (limiter) c.set('authRateLimiter', limiter)
    return next()
  })
  const client = new Hono<AppEnv>()
  const routeOpts = {
    secrets,
    twoFactorChallengeSecrets,
    backupCodeVerifierSecrets,
    runtime,
    signupEnvOverride: undefined,
    baseUrl: ORIGIN,
  }
  registerAuthRoutes(client, routeOpts)
  registerAuthnRoutes(client, routeOpts)
  app.route(CLIENT_API_PREFIX, client)

  const userIds: string[] = []
  const emails: string[] = []
  const addUser: Fixture['addUser'] = async (opts = {}) => {
    const email = `sec-${crypto.randomUUID()}@example.com`
    const password = opts.password ?? strongCredential()
    const [inserted] = await db
      .insert(user)
      .values({ email, isEmailVerified: opts.verified ?? true, role: 'user' })
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
    return { userId, email, password }
  }

  try {
    await fn({ app, db, addUser })
  } finally {
    setSharedAuthRateLimiterForTests(undefined)
    if (userIds.length > 0) {
      await db.delete(session).where(inArray(session.userId, userIds))
      await db.delete(account).where(inArray(account.userId, userIds))
      await db.delete(user).where(inArray(user.id, userIds))
    }
    await db.delete(verification).where(like(verification.identifier, 'sec-%@example.com'))
    await Promise.all(
      userIds.map((userId) =>
        db.delete(verification).where(like(verification.identifier, `%:${userId}`))
      )
    )
    await endDbConnection(db)
  }
}

function postJson(
  app: Hono<AppEnv>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return Promise.resolve(
    app.request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': uniqueIp(), ...headers },
      body: JSON.stringify(body),
    })
  )
}

/** `name=value` of the session cookie a response set. */
function sessionCookieOf(res: Response): string {
  const line = res.headers.getSetCookie().find((entry) => entry.includes('turbopanel'))
  assert(line, 'no session cookie was set')
  return line.split(';')[0]!
}

function signIn(app: Hono<AppEnv>, email: string, password: string, ip?: string) {
  return postJson(
    app,
    `${AUTH}/sign-in`,
    { email, password },
    ip ? { 'CF-Connecting-IP': ip, 'X-Real-IP': ip } : {}
  )
}

function sessionStatus(app: Hono<AppEnv>, cookie: string): Promise<number> {
  return Promise.resolve(
    app.request(`${ORIGIN}${CLIENT_API_PREFIX}/authn/session`, { headers: { cookie } })
  ).then((res) => res.status)
}

async function sessionRowCount(db: Db, userId: string): Promise<number> {
  const rows = await db.select({ id: session.id }).from(session).where(eq(session.userId, userId))
  return rows.length
}

test('sign-in sets an HttpOnly Secure cookie; sign-out deletes the session row and the old cookie is dead', async () => {
  await withFixture({ runtime: 'workers' }, async ({ app, db, addUser }) => {
    const { userId, email, password } = await addUser()

    const res = await signIn(app, email, password)
    assertEquals(res.status, 200)
    const setCookie = res.headers.getSetCookie().join('\n')
    assert(setCookie.includes('HttpOnly'), setCookie)
    assert(setCookie.includes('Secure'), setCookie)
    assert(setCookie.includes('SameSite=Lax'), setCookie)
    const cookie = sessionCookieOf(res)

    assertEquals(await sessionRowCount(db, userId), 1)
    assertEquals(await sessionStatus(app, cookie), 200)

    const out = await postJson(app, `${AUTH}/sign-out`, {}, { cookie })
    assertEquals(out.status, 200)
    assertEquals(await sessionRowCount(db, userId), 0, 'sign-out must delete the session row')
    assertEquals(await sessionStatus(app, cookie), 401, 'the signed cookie alone no longer works')
  })
})

test('a session past its expiry is refused, so a stale tab gets 401 rather than data', async () => {
  await withFixture({ runtime: 'workers' }, async ({ app, db, addUser }) => {
    const { userId, email, password } = await addUser()
    const cookie = sessionCookieOf(await signIn(app, email, password))
    assertEquals(await sessionStatus(app, cookie), 200)

    await db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(session.userId, userId))
    assertEquals(await sessionStatus(app, cookie), 401)
  })
})

test('sign-in throttle: repeated wrong passwords across rotating IPs get 429 with Retry-After, even for the right password', async () => {
  // The shipped limiter (sign-in: 10 per 60 s per identity and per IP).
  await withFixture({ limiter: 'shipped' }, async ({ app, addUser }) => {
    const { email, password } = await addUser()
    const wrong = strongCredential()
    // A new source address every time: only the per-identity bucket can trip.
    const statuses = await mapSequential(Array.from({ length: 10 }), async () => {
      const res = await signIn(app, email, wrong, uniqueIp())
      return res.status
    })
    assertEquals(statuses, Array(10).fill(401))

    const blocked = await signIn(app, email, password, uniqueIp())
    assertEquals(blocked.status, 429)
    assertEquals(await blocked.json(), { ok: false, error: 'Too many requests' })
    const retryAfter = Number(blocked.headers.get('Retry-After'))
    assert(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`)
  })
})

test('sign-in throttle: many accounts from one IP trip the IP bucket, and the real user gets in once the window passes', async () => {
  let nowMs = Date.UTC(2026, 0, 1)
  const limiter = createAuthRateLimiter({
    policies: { 'sign-in': { limit: 10, windowMs: 60_000 } },
    now: () => nowMs,
  })
  await withFixture({ limiter }, async ({ app, addUser }) => {
    const { email, password } = await addUser()
    const attackerIp = uniqueIp()
    await forEachSequential(Array.from({ length: 10 }), async (_, i) => {
      const probe = await signIn(
        app,
        `nobody-${i}-${crypto.randomUUID()}@example.com`,
        'x',
        attackerIp
      )
      assertEquals(probe.status, 401)
    })
    const sameIp = await signIn(app, email, password, attackerIp)
    assertEquals(sameIp.status, 429)
    assert(sameIp.headers.get('Retry-After') !== null)

    nowMs += 61_000
    const later = await signIn(app, email, password, attackerIp)
    assertEquals(later.status, 200)
  })
})

test('verify-email: a used link and an expired link both fail cleanly and verify nothing', async () => {
  await withFixture({}, async ({ app, db, addUser }) => {
    const { userId, email } = await addUser({ verified: false })
    const used = await createEmailVerificationToken(db, email)
    const linkOf = (token: string) =>
      `${ORIGIN}${AUTH}/verify-email?token=${encodeURIComponent(token)}`

    assertEquals((await app.request(linkOf(used))).status, 200)
    const verifiedRows = await db
      .select({ ok: user.isEmailVerified })
      .from(user)
      .where(eq(user.id, userId))
    assertEquals(verifiedRows[0]?.ok, true)

    const reuse = await app.request(linkOf(used))
    assertEquals(reuse.status, 400)
    assertEquals(await reuse.json(), { ok: false, error: 'Invalid or expired token' })

    const second = await addUser({ verified: false })
    const stale = await createEmailVerificationToken(db, second.email)
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(verification.identifier, second.email))
    assertEquals((await app.request(linkOf(stale))).status, 400)
    const rows = await db
      .select({ ok: user.isEmailVerified })
      .from(user)
      .where(eq(user.id, second.userId))
    assertEquals(rows[0]?.ok, false)
  })
})

test('password reset: the old password stops working at once and the new one signs in', async () => {
  await withFixture({}, async ({ app, db, addUser }) => {
    const { userId, email, password } = await addUser()
    const cookie = sessionCookieOf(await signIn(app, email, password))
    const next = strongCredential()
    const token = await createPasswordResetToken(db, userId)

    const reset = await postJson(app, `${AUTH}/reset-password`, { newPassword: next, token })
    assertEquals(reset.status, 200)

    assertEquals((await signIn(app, email, password)).status, 401)
    assertEquals((await signIn(app, email, next)).status, 200)
    assertEquals(await sessionStatus(app, cookie), 401, 'the session from before the reset is gone')
  })
})

type Enrolled = { cookie: string; secret: Uint8Array; backupCodes: string[] }

async function enrolTotp(
  fx: Fixture,
  who: { email: string; password: string }
): Promise<Enrolled & { verifyBody: string; code: string }> {
  const cookie = sessionCookieOf(await signIn(fx.app, who.email, who.password))
  const enrol = await postJson(
    fx.app,
    `${AUTH}/2fa/totp/enroll`,
    { password: who.password },
    { cookie }
  )
  assertEquals(enrol.status, 200)
  const secret = decodeBase32(((await enrol.json()) as { secret: string }).secret)
  const code = await generateTotp(secret, { unixSeconds: Math.floor(Date.now() / 1000) })
  const verify = await postJson(fx.app, `${AUTH}/2fa/totp/verify`, { code }, { cookie })
  assertEquals(verify.status, 200)
  const verifyBody = await verify.text()
  const { backupCodes } = JSON.parse(verifyBody) as { backupCodes: string[] }
  return { cookie, secret, backupCodes, verifyBody, code }
}

test('TOTP enrolment: the code is accepted once and backup codes are shown only at that moment; disable then lifts the second factor', async () => {
  await withFixture({}, async (fx) => {
    const who = await fx.addUser()
    const { cookie, backupCodes, code } = await enrolTotp(fx, who)
    assertEquals(backupCodes.length, 10)

    const replay = await postJson(fx.app, `${AUTH}/2fa/totp/verify`, { code }, { cookie })
    assert(replay.status >= 400, `enrolment code accepted twice: ${replay.status}`)

    const status = await fx.app.request(`${ORIGIN}${AUTH}/2fa`, { headers: { cookie } })
    const statusText = await status.text()
    assertEquals(JSON.parse(statusText).backupCodesRemaining, 10)
    for (const backup of backupCodes) {
      assert(!statusText.includes(backup), 'status must never echo a backup code')
    }

    const challenged = await signIn(fx.app, who.email, who.password)
    assertEquals(((await challenged.json()) as { requires2fa?: boolean }).requires2fa, true)

    const disabled = await postJson(
      fx.app,
      `${AUTH}/2fa/disable`,
      { password: who.password },
      { cookie }
    )
    assertEquals(disabled.status, 200)

    const after = await signIn(fx.app, who.email, who.password)
    assertEquals(after.status, 200)
    assert(after.headers.getSetCookie().some((entry) => entry.includes('turbopanel')))
    assertEquals(((await after.json()) as { requires2fa?: boolean }).requires2fa, undefined)
  })
})

function unlink(fx: Fixture, provider: string, cookie: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    fx.app.request(`${ORIGIN}${AUTH}/oauth/${provider}`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json', 'CF-Connecting-IP': uniqueIp() },
      body: JSON.stringify(body),
    })
  )
}

async function linkGithub(db: Db, userId: string): Promise<void> {
  await db
    .insert(account)
    .values({ userId, providerId: 'github', providerUserId: `gh-${crypto.randomUUID()}` })
}

test('unlinking GitHub needs the password, and the last way in cannot be removed', async () => {
  await withFixture({}, async (fx) => {
    const both = await fx.addUser()
    await linkGithub(fx.db, both.userId)
    const cookie = sessionCookieOf(await signIn(fx.app, both.email, both.password))

    assertEquals((await unlink(fx, 'github', cookie, {})).status, 403)
    assertEquals((await unlink(fx, 'github', cookie, { password: strongCredential() })).status, 403)
    const linked = await fx.db.select().from(account).where(eq(account.userId, both.userId))
    assert(
      linked.some((row) => row.providerId === 'github'),
      'refused unlink must change nothing'
    )

    assertEquals((await unlink(fx, 'github', cookie, { password: both.password })).status, 200)
    const left = await fx.db.select().from(account).where(eq(account.userId, both.userId))
    assertEquals(
      left.map((row) => row.providerId),
      ['credential']
    )

    const oauthOnly = await fx.addUser({ password: null })
    await linkGithub(fx.db, oauthOnly.userId)
    const { token } = await createSession(fx.db, oauthOnly.userId, {})
    const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
    const onlyCookie = `${HTTPS_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
    const last = await unlink(fx, 'github', onlyCookie, {})
    assertEquals(last.status, 409)
  })
})
