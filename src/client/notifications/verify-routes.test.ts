/**
 * The email-verification routes against a real Postgres: a stranger's address
 * is created unverified and mailed a link; the link needs no session, works
 * once and only ever redirects to a fixed page; a resend is rate-limited and
 * owner-gated. Skipped without TURBOPANEL_DATABASE_URL like every Postgres
 * suite.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert'
import { eq, like } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  grant,
  notificationChannel,
  organization,
  team,
  teammate,
  user,
  verification,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import type { EmailJob, EmailQueue } from '../../features/email/types.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { CHANNEL_VERIFIED_PAGE, CHANNEL_VERIFY_FAILED_PAGE } from './verify-routes.ts'
import { registerNotificationVerifyRoutes } from './verify-routes.ts'
import { registerNotificationRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  sent: EmailJob[]
  organizationId: string
  managerEmail: string
  managerCookie: string
  memberCookie: string
  outsiderCookie: string
}

async function cookieFor(
  db: Db,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
}

async function insertUser(db: Db, label: string): Promise<{ id: string; email: string }> {
  const email = `vr-${label}-${crypto.randomUUID()}@example.com`
  const [row] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  return { id: row!.id, email }
}

function buildApp(
  db: Db,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  queue?: EmailQueue
) {
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('runtime', 'deno')
    if (queue) c.set('emailQueue', queue)
    c.set('emailFrom', 'noreply@example.com')
    return next()
  })
  const opts = {
    secrets,
    runtime: 'deno' as const,
    signupEnvOverride: undefined,
    baseUrl: 'https://panel.example.com',
  }
  registerNotificationVerifyRoutes(app, opts)
  registerNotificationRoutes(app, opts)
  return app
}

async function withFixture(
  fn: (f: Fixture) => Promise<void>,
  opts: { queue?: boolean } = {}
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('verification route tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const sent: EmailJob[] = []
  const queue: EmailQueue = {
    enqueue: (job) => {
      sent.push(job)
      return Promise.resolve()
    },
  }
  const [org] = await db
    .insert(organization)
    .values({ name: 'Verify Routes Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const manager = await insertUser(db, 'manager')
  const member = await insertUser(db, 'member')
  const outsider = await insertUser(db, 'outsider')
  const [t] = await db
    .insert(team)
    .values({ name: 'Verify Team', organizationId })
    .returning({ id: team.id })
  await db.insert(teammate).values([
    { teamId: t!.id, userId: manager.id },
    { teamId: t!.id, userId: member.id },
  ])
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: manager.id,
    permission: 'organization:manage',
  })
  try {
    await fn({
      db,
      app: buildApp(db, secrets, opts.queue === false ? undefined : queue),
      sent,
      organizationId,
      managerEmail: manager.email,
      managerCookie: await cookieFor(db, secrets, manager.id),
      memberCookie: await cookieFor(db, secrets, member.id),
      outsiderCookie: await cookieFor(db, secrets, outsider.id),
    })
  } finally {
    await db.delete(verification).where(like(verification.identifier, 'notification-channel:%'))
    await db.delete(organization).where(eq(organization.id, organizationId))
    for (const u of [manager, member, outsider]) await db.delete(user).where(eq(user.id, u.id))
    await endDbConnection(db)
  }
}

function call(
  f: Fixture,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; org?: boolean } = {}
) {
  return f.app.request(path, {
    method,
    redirect: 'manual',
    headers: {
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      'content-type': 'application/json',
      ...(opts.org ? { [ORG_ID_HEADER]: f.organizationId } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })
}

function verificationJob(f: Fixture): Extract<EmailJob, { type: 'channel-verification' }> {
  const job = f.sent.at(-1)
  if (job?.type !== 'channel-verification') throw new TypeError('expected a verification email')
  return job
}

function linkPath(job: { verifyUrl: string }): string {
  // The test app mounts the routes without the API prefix.
  return new URL(job.verifyUrl).pathname.replace('/api/client/v1', '')
}

async function channelRow(db: Db, id: string) {
  const [row] = await db.select().from(notificationChannel).where(eq(notificationChannel.id, id))
  return row
}

const STRANGER = () => `pager-${crypto.randomUUID()}@example.org`

test("a stranger's address is created unverified and mailed a link that confirms it without a session", async () => {
  await withFixture(async (f) => {
    const address = STRANGER()
    const created = await call(f, 'POST', '/notification-channels/email', {
      cookie: f.managerCookie,
      org: true,
      body: { scope: 'organization', label: 'Pager', address, rules: [{ event: '*' }] },
    })
    assertEquals(created.status, 201)
    const body = (await created.json()) as {
      verification: string
      channel: { id: string; verifiedAt: string | null }
    }
    assertEquals(body.verification, 'sent')
    assertEquals(body.channel.verifiedAt, null)
    assertEquals(f.sent.length, 1)
    const job = verificationJob(f)
    assertEquals(job.to, address)
    assertEquals(job.organizationName, 'Verify Routes Org')
    assertEquals(job.requestedByEmail, f.managerEmail)
    assertStringIncludes(
      job.verifyUrl,
      'https://panel.example.com/api/client/v1/notification-channels/verify/'
    )

    const click = await call(f, 'GET', linkPath(job))
    assertEquals(click.status, 302)
    assertEquals(click.headers.get('location'), CHANNEL_VERIFIED_PAGE)
    assertNotEquals((await channelRow(f.db, body.channel.id))?.verifiedAt, null)

    const again = await call(f, 'GET', linkPath(job))
    assertEquals(again.headers.get('location'), CHANNEL_VERIFY_FAILED_PAGE)
  })
})

test("the caller's own address and a member's account email need no verification", async () => {
  await withFixture(async (f) => {
    const own = await call(f, 'POST', '/notification-channels/email', {
      cookie: f.managerCookie,
      body: { label: 'Mine', address: f.managerEmail },
    })
    assertEquals(own.status, 201)
    const ownBody = (await own.json()) as {
      verification: string
      channel: { verifiedAt: string | null }
    }
    assertEquals(ownBody.verification, 'not_needed')
    assertNotEquals(ownBody.channel.verifiedAt, null)
    assertEquals(f.sent.length, 0)

    const other = await call(f, 'POST', '/notification-channels/email', {
      cookie: f.managerCookie,
      body: { label: 'Not mine', address: 'someone-else@example.org' },
    })
    assertEquals(((await other.json()) as { verification: string }).verification, 'sent')
  })
})

test('a malformed link or token redirects to the failure page and changes nothing', async () => {
  await withFixture(async (f) => {
    for (const token of ['nope', 'f'.repeat(64), 'F'.repeat(64), `${'a'.repeat(63)}%2F`]) {
      const res = await call(f, 'GET', `/notification-channels/verify/${token}`)
      assertEquals(res.status, 302)
      assertEquals(res.headers.get('location'), CHANNEL_VERIFY_FAILED_PAGE)
    }
  })
})

test('the redirect targets are fixed, relative paths', () => {
  for (const page of [CHANNEL_VERIFIED_PAGE, CHANNEL_VERIFY_FAILED_PAGE]) {
    assertEquals(page.startsWith('/') && !page.startsWith('//'), true)
  }
})

test('without an email queue a stranger cannot be added, and nothing is left behind', async () => {
  await withFixture(
    async (f) => {
      const res = await call(f, 'POST', '/notification-channels/email', {
        cookie: f.managerCookie,
        body: { label: 'Pager', address: STRANGER() },
      })
      assertEquals(res.status, 503)
      assertEquals(((await res.json()) as { error: string }).error, 'email_unavailable')
      const rows = await f.db
        .select()
        .from(notificationChannel)
        .where(eq(notificationChannel.label, 'Pager'))
      assertEquals(rows.length, 0)
    },
    { queue: false }
  )
})

test('a queue that refuses the mail rolls the channel back', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const refusing: EmailQueue = { enqueue: () => Promise.reject(new Error('queue down')) }
  const app = buildApp(db, secrets, refusing)
  const person = await insertUser(db, 'solo')
  try {
    const res = await app.request('/notification-channels/email', {
      method: 'POST',
      headers: {
        Cookie: await cookieFor(db, secrets, person.id),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ label: 'Doomed', address: STRANGER() }),
    })
    assertEquals(res.status, 502)
    assertEquals(((await res.json()) as { error: string }).error, 'email_send_failed')
    const rows = await db
      .select()
      .from(notificationChannel)
      .where(eq(notificationChannel.label, 'Doomed'))
    assertEquals(rows.length, 0)
  } finally {
    await db.delete(user).where(eq(user.id, person.id))
    await endDbConnection(db)
  }
})

test('creation needs a session, a valid address, and a manager for an organization channel', async () => {
  await withFixture(async (f) => {
    const anonymous = await call(f, 'POST', '/notification-channels/email', {
      body: { label: 'x', address: STRANGER() },
    })
    assertEquals(anonymous.status, 401)
    const badAddress = await call(f, 'POST', '/notification-channels/email', {
      cookie: f.managerCookie,
      body: { label: 'x', address: 'not an address' },
    })
    assertEquals(badAddress.status, 400)
    const notManager = await call(f, 'POST', '/notification-channels/email', {
      cookie: f.memberCookie,
      org: true,
      body: { scope: 'organization', label: 'x', address: STRANGER() },
    })
    assertEquals(notManager.status, 403)
    assertEquals(f.sent.length, 0)
  })
})

test('a request body that names another kind is still an email channel', async () => {
  await withFixture(async (f) => {
    const res = await call(f, 'POST', '/notification-channels/email', {
      cookie: f.managerCookie,
      body: { kind: 'webhook', label: 'x', address: STRANGER() },
    })
    assertEquals(res.status, 201)
    assertEquals(((await res.json()) as { channel: { kind: string } }).channel.kind, 'email')
  })
})

test('resend: owner only, cooled down, replaces the link, and stops once verified', async () => {
  await withFixture(async (f) => {
    const created = await call(f, 'POST', '/notification-channels/email', {
      cookie: f.managerCookie,
      org: true,
      body: { scope: 'organization', label: 'Pager', address: STRANGER() },
    })
    const id = ((await created.json()) as { channel: { id: string } }).channel.id
    const firstLink = linkPath(verificationJob(f))

    const tooSoon = await call(f, 'POST', `/notification-channels/${id}/verify`, {
      cookie: f.managerCookie,
      org: true,
    })
    assertEquals(tooSoon.status, 429)
    assertNotEquals(tooSoon.headers.get('retry-after'), null)
    assertEquals(f.sent.length, 1)

    // Age the live link past the cooldown, as a minute of waiting would.
    await f.db
      .update(verification)
      .set({ updatedAt: new Date(Date.now() - 120_000).toISOString() })
      .where(eq(verification.identifier, `notification-channel:${id}`))

    for (const cookie of [f.outsiderCookie, f.memberCookie]) {
      const denied = await call(f, 'POST', `/notification-channels/${id}/verify`, {
        cookie,
        org: true,
      })
      assertEquals([403, 404].includes(denied.status), true)
    }
    assertEquals(f.sent.length, 1)

    const resent = await call(f, 'POST', `/notification-channels/${id}/verify`, {
      cookie: f.managerCookie,
      org: true,
    })
    assertEquals(resent.status, 200)
    assertEquals(f.sent.length, 2)
    const secondLink = linkPath(verificationJob(f))
    assertNotEquals(secondLink, firstLink)
    assertEquals(
      (await call(f, 'GET', firstLink)).headers.get('location'),
      CHANNEL_VERIFY_FAILED_PAGE
    )
    assertEquals((await call(f, 'GET', secondLink)).headers.get('location'), CHANNEL_VERIFIED_PAGE)

    const done = await call(f, 'POST', `/notification-channels/${id}/verify`, {
      cookie: f.managerCookie,
      org: true,
    })
    assertEquals(done.status, 409)
  })
})

test('resend refuses a channel that is not an email channel, or that does not exist', async () => {
  await withFixture(async (f) => {
    const [hook] = await f.db
      .insert(notificationChannel)
      .values({
        scope: 'organization',
        organizationId: f.organizationId,
        kind: 'slack',
        label: 'Hook',
        address: 'sealed',
      })
      .returning({ id: notificationChannel.id })
    const notEmail = await call(f, 'POST', `/notification-channels/${hook!.id}/verify`, {
      cookie: f.managerCookie,
      org: true,
    })
    assertEquals(notEmail.status, 400)
    const missing = await call(f, 'POST', `/notification-channels/${crypto.randomUUID()}/verify`, {
      cookie: f.managerCookie,
      org: true,
    })
    assertEquals(missing.status, 404)
    const anonymous = await call(f, 'POST', `/notification-channels/${hook!.id}/verify`)
    assertEquals(anonymous.status, 401)
  })
})

function createBody(label: string, address: string) {
  return { label, address, rules: [{ event: '*' }] }
}

async function createFor(f: Fixture, cookie: string, label: string, address: string) {
  return await call(f, 'POST', '/notification-channels/email', {
    cookie,
    body: createBody(label, address),
  })
}

test('a user can hold only a few unverified email channels at once', async () => {
  await withFixture(async (f) => {
    for (let i = 0; i < 5; i++) {
      assertEquals((await createFor(f, f.outsiderCookie, `Pager ${i}`, STRANGER())).status, 201)
    }
    const sixth = await createFor(f, f.outsiderCookie, 'Pager 6', STRANGER())
    assertEquals(sixth.status, 429)
    assertEquals(((await sixth.json()) as { error: string }).error, 'too_many_unverified_channels')
    assertEquals(f.sent.length, 5)

    // Another user is not affected by this one's budget.
    assertEquals((await createFor(f, f.memberCookie, 'Pager', STRANGER())).status, 201)
  })
})

test('one stranger address is mailed a verification link only a few times a day', async () => {
  await withFixture(async (f) => {
    const address = STRANGER()
    const cookies = [f.managerCookie, f.memberCookie, f.outsiderCookie]
    for (const cookie of cookies) {
      assertEquals((await createFor(f, cookie, 'Pager', address)).status, 201)
    }
    // A fourth request, from anyone, finds the address already used up.
    const again = await createFor(f, f.managerCookie, 'Pager two', address)
    assertEquals(again.status, 429)
    assertEquals(((await again.json()) as { error: string }).error, 'address_verification_limit')
    assertEquals(f.sent.length, 3)
    // The refused channel is not left behind.
    const rows = await f.db
      .select({ id: notificationChannel.id })
      .from(notificationChannel)
      .where(eq(notificationChannel.address, address))
    assertEquals(rows.length, 3)
  })
})

test('resending counts against the same per-address allowance', async () => {
  await withFixture(async (f) => {
    const address = STRANGER()
    const created = await createFor(f, f.managerCookie, 'Pager', address)
    const id = ((await created.json()) as { channel: { id: string } }).channel.id
    let statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      await f.db
        .update(verification)
        .set({ updatedAt: new Date(Date.now() - 120_000).toISOString() })
        .where(eq(verification.identifier, `notification-channel:${id}`))
      const res = await call(f, 'POST', `/notification-channels/${id}/verify`, {
        cookie: f.managerCookie,
      })
      statuses = [...statuses, res.status]
    }
    assertEquals(statuses, [200, 200, 429])
    assertEquals(f.sent.length, 3)
  })
})

test('the daily verification mail budget is per user', async () => {
  await withFixture(async (f) => {
    // Ten distinct addresses are fine for a day; the eleventh is not, even
    // though each earlier channel was removed again.
    for (let i = 0; i < 10; i++) {
      const res = await createFor(f, f.outsiderCookie, `Pager ${i}`, STRANGER())
      assertEquals(res.status, 201)
      const id = ((await res.json()) as { channel: { id: string } }).channel.id
      await f.db.delete(notificationChannel).where(eq(notificationChannel.id, id))
    }
    const over = await createFor(f, f.outsiderCookie, 'Pager x', STRANGER())
    assertEquals(over.status, 429)
    assertEquals(((await over.json()) as { error: string }).error, 'verification_mail_budget')
  })
})

test('organization-scope channels count against the creator too', async () => {
  await withFixture(async (f) => {
    let made = 0
    for (let i = 0; i < 8; i++) {
      const res = await call(f, 'POST', '/notification-channels/email', {
        cookie: f.managerCookie,
        org: true,
        body: { scope: 'organization', ...createBody(`Pager ${i}`, STRANGER()) },
      })
      if (res.status === 201) made += 1
      else assertEquals(res.status, 429)
    }
    assertEquals(made, 5)
  })
})

test('a verification request refuses a recipient list and a link in the label', async () => {
  await withFixture(async (f) => {
    const list = await createFor(f, f.managerCookie, 'Pager', `${STRANGER()}, ${STRANGER()}`)
    assertEquals(list.status, 400)
    const link = await createFor(f, f.managerCookie, 'Verify at https://evil.example', STRANGER())
    assertEquals(link.status, 400)
    assertEquals(f.sent.length, 0)
  })
})
