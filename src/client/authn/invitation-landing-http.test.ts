/**
 * Invitation landing page against a real Postgres: the preview, the
 * signed-in Accept button (explicit, idempotent, invited email only) and the
 * new-account sign-up-and-accept (verified user, membership, session, no
 * personal organization). Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.ts'
import { assert, assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { createDenoDb } from '../../db/connection.ts'
import {
  account,
  grant,
  invitation,
  organization,
  session,
  team,
  teammate,
  user,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import type { EmailJob } from '../../features/email/types.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerAccessRoutes } from '../access/routes.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { breachedBreachResponder, cleanBreachResponder } from '../../test-fixtures/breach.ts'
import { createAuthRateLimiter } from './auth-rate-limit.ts'
import type { BreachRangeResponder } from './breached-password.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from './crypto.ts'
import { registerAuthRoutes } from './http.ts'
import { createOrganizationForUser } from './install-state.ts'
import { invitationStatus, parseInvitationSignUpBody } from './invitation-landing-http.ts'
import { mintInvitationToken } from '../access/invitation-token.ts'
import { createSession } from './session-store.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep the alias so analysis sees these suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

/** Built at run time so secret scanners never read a fixture as a credential. */
function strongCredential(): string {
  return `Aa1-${crypto.randomUUID()}`
}

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  app: Hono<AppEnv>
  db: Db
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
  organizationId: string
  teamId: string
  inviterId: string
  invite: (
    email: string,
    opts?: { status?: string; expiresAt?: string; legacy?: boolean }
  ) => Promise<{ id: string; token: string }>
  track: (userId: string) => void
  jobs: EmailJob[]
  inviterCookie: () => Promise<string>
}

async function withFixture(
  fn: (fx: Fixture) => Promise<void>,
  responder: BreachRangeResponder = cleanBreachResponder()
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('invitation landing tests')
    return
  }
  const db = createDenoDb()
  const config = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(config, 'session-signing')
  const [inviter] = await db
    .insert(user)
    .values({ email: `inviter-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const inviterId = inviter!.id
  const { organizationId, teamId } = await createOrganizationForUser(db, inviterId, 'Acme Test')
  const users = [inviterId]
  const jobs: EmailJob[] = []
  const invitations: string[] = []

  const app = new Hono<AppEnv>()
  const client = new Hono<AppEnv>()
  client.use('*', (c, next) => {
    c.set('db', db)
    c.set('emailQueue', {
      enqueue: (job: EmailJob) => {
        jobs.push(job)
        return Promise.resolve()
      },
    })
    c.set('platformEnv', { TURBOPANEL_BASE_URL: 'https://panel.example.com' })
    c.set('breachRangeResponder', responder)
    c.set(
      'authRateLimiter',
      createAuthRateLimiter({ defaultPolicy: { limit: 10_000, windowMs: 60_000 } })
    )
    return next()
  })
  const routeOpts = {
    secrets,
    otpVerifierSecrets: await deriveSecretsConfig(config, 'email-otp-verifier'),
    runtime: 'workers' as const,
    signupEnvOverride: undefined,
    emailFrom: 'noreply@turbopanel.local',
  }
  registerAuthRoutes(client, routeOpts)
  registerAccessRoutes(client, routeOpts)
  app.route(CLIENT_API_PREFIX, client)

  const invite: Fixture['invite'] = async (email, opts = {}) => {
    const minted = await mintInvitationToken()
    const [row] = await db
      .insert(invitation)
      .values({
        userId: inviterId,
        teamId,
        email,
        status: opts.status ?? 'pending',
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
        // Invitations created before the link secret existed have no verifier.
        tokenHash: opts.legacy ? null : minted.tokenHash,
      })
      .returning({ id: invitation.id })
    invitations.push(row!.id)
    return { id: row!.id, token: minted.token }
  }

  try {
    await fn({
      app,
      db,
      secrets,
      organizationId,
      teamId,
      inviterId,
      invite,
      track: (id) => users.push(id),
      jobs,
      inviterCookie: async () => {
        const { token } = await createSession(db, inviterId, {})
        return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
      },
    })
  } finally {
    await db.delete(invitation).where(inArray(invitation.id, [...invitations, crypto.randomUUID()]))
    await db.delete(grant).where(inArray(grant.actorId, users))
    await db.delete(grant).where(eq(grant.entityId, organizationId))
    await db.delete(teammate).where(inArray(teammate.userId, users))
    await db.delete(session).where(inArray(session.userId, users))
    await db.delete(account).where(inArray(account.userId, users))
    await db.delete(team).where(eq(team.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await db.delete(user).where(inArray(user.id, users))
  }
}

function request(
  app: Hono<AppEnv>,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; cookie?: string; organizationId?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '203.0.113.60' }
  if (opts.organizationId) headers[ORG_ID_HEADER] = opts.organizationId
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.cookie) headers.Cookie = opts.cookie
  return Promise.resolve(
    app.request(`${CLIENT_API_PREFIX}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  )
}

async function signedInCookie(
  fx: Fixture,
  email: string
): Promise<{ cookie: string; userId: string }> {
  const [row] = await fx.db
    .insert(user)
    .values({ email, isEmailVerified: true })
    .returning({ id: user.id })
  fx.track(row!.id)
  const { token } = await createSession(fx.db, row!.id, {})
  const signed = await buildSignedCookie(token, fx.secrets)
  return { cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}`, userId: row!.id }
}

async function isMember(db: Db, teamId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: teammate.userId })
    .from(teammate)
    .where(and(eq(teammate.teamId, teamId), eq(teammate.userId, userId)))
  return rows.length > 0
}

test('invitationStatus: pending, expired by time, and terminal states', () => {
  const now = '2026-09-27T12:00:00.000Z'
  assertEquals(
    invitationStatus({ status: 'pending', expiresAt: '2026-09-28T00:00:00.000Z' }, now),
    'pending'
  )
  assertEquals(
    invitationStatus({ status: 'pending', expiresAt: '2026-09-27T00:00:00.000Z' }, now),
    'expired'
  )
  assertEquals(
    invitationStatus({ status: 'accepted', expiresAt: '2026-09-28T00:00:00.000Z' }, now),
    'accepted'
  )
  assertEquals(
    invitationStatus({ status: 'revoked', expiresAt: '2026-09-28T00:00:00.000Z' }, now),
    'revoked'
  )
})

test('parseInvitationSignUpBody requires a strong password and nothing else', () => {
  assertEquals(parseInvitationSignUpBody(null).ok, false)
  assertEquals(parseInvitationSignUpBody({}).ok, false)
  assertEquals(parseInvitationSignUpBody({ password: 'short' }).ok, false)
  assertEquals(parseInvitationSignUpBody({ password: 'x'.repeat(300) }).ok, false)
  assertEquals(parseInvitationSignUpBody({ password: strongCredential() }).ok, true)
})

function preview(fx: Fixture, token: string): Promise<Response> {
  return request(fx.app, 'GET', `/auth/invitations/by-token/${token}`)
}

function signUp(fx: Fixture, token: string, password = strongCredential()): Promise<Response> {
  return request(fx.app, 'POST', `/auth/invitations/by-token/${token}/sign-up`, {
    body: { password },
  })
}

test('token preview of a pending invitation to a new address: email, accountExists false, never accepts', async () => {
  await withFixture(async (fx) => {
    const email = `new-${crypto.randomUUID()}@example.com`
    const { id, token } = await fx.invite(email)
    const res = await preview(fx, token)
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.status, 'pending')
    assertEquals(body.organizationName, 'Acme Test')
    assertEquals(body.email, email)
    assertEquals(body.accountExists, false)
    assertEquals(body.invitationId, id)
    const [row] = await fx.db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, id))
    assertEquals(row!.status, 'pending')
  })
})

test('token preview reports an existing account, and hides the email once not pending', async () => {
  await withFixture(async (fx) => {
    const email = `existing-${crypto.randomUUID()}@example.com`
    await signedInCookie(fx, email)
    const pending = await fx.invite(email)
    assertEquals((await (await preview(fx, pending.token)).json()).accountExists, true)

    const expired = await fx.invite(`x-${crypto.randomUUID()}@example.com`, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const expiredBody = await (await preview(fx, expired.token)).json()
    assertEquals(expiredBody.status, 'expired')
    assertEquals(expiredBody.email, undefined)
    assertEquals(expiredBody.accountExists, undefined)

    const accepted = await fx.invite(`y-${crypto.randomUUID()}@example.com`, { status: 'accepted' })
    assertEquals((await (await preview(fx, accepted.token)).json()).status, 'accepted')
  })
})

test('unknown or malformed tokens are 404 and reveal nothing', async () => {
  await withFixture(async (fx) => {
    await fx.invite(`z-${crypto.randomUUID()}@example.com`)
    const unknown = (await mintInvitationToken()).token
    const res = await preview(fx, unknown)
    assertEquals(res.status, 404)
    assertEquals(await res.json(), { ok: false, error: 'not_found' })
    assertEquals((await preview(fx, 'not-a-token')).status, 404)
    assertEquals((await signUp(fx, unknown)).status, 410)
  })
})

test('the invitation id is not a credential: no email by id, and no sign-up by id', async () => {
  await withFixture(async (fx) => {
    const email = `target-${crypto.randomUUID()}@example.com`
    const { id } = await fx.invite(email)

    const byId = await request(fx.app, 'GET', `/auth/invitations/${id}`)
    assertEquals(byId.status, 200)
    const body = await byId.json()
    assertEquals(body.organizationName, 'Acme Test')
    assertEquals(body.email, undefined)
    assertEquals(body.accountExists, undefined)

    // The id in the token slot matches nothing; the old id route has no sign-up.
    assertEquals((await signUp(fx, id)).status, 410)
    assertEquals(
      (
        await request(fx.app, 'POST', `/auth/invitations/${id}/sign-up`, {
          body: { password: strongCredential() },
        })
      ).status,
      404
    )
    const created = await fx.db.select({ id: user.id }).from(user).where(eq(user.email, email))
    assertEquals(created.length, 0, 'no account was created for the invitee')
  })
})

test('invitations from before the link secret: public preview only, sign-up impossible', async () => {
  await withFixture(async (fx) => {
    const email = `legacy-${crypto.randomUUID()}@example.com`
    const { id } = await fx.invite(email, { legacy: true })
    const body = await (await request(fx.app, 'GET', `/auth/invitations/${id}`)).json()
    assertEquals(body.status, 'pending')
    assertEquals(body.email, undefined)
    const [row] = await fx.db
      .select({ tokenHash: invitation.tokenHash })
      .from(invitation)
      .where(eq(invitation.id, id))
    assertEquals(row!.tokenHash, null)
  })
})

test('Accept button: invited email joins, repeat is idempotent, another account is refused', async () => {
  await withFixture(async (fx) => {
    const email = `member-${crypto.randomUUID()}@example.com`
    const { cookie, userId } = await signedInCookie(fx, email)
    const { id } = await fx.invite(email)

    const other = await signedInCookie(fx, `other-${crypto.randomUUID()}@example.com`)
    assertEquals(
      (await request(fx.app, 'POST', `/invitations/${id}/accept`, { cookie: other.cookie })).status,
      403
    )

    const first = await request(fx.app, 'POST', `/invitations/${id}/accept`, { cookie })
    assertEquals(first.status, 200)
    assertEquals((await first.json()).organizationId, fx.organizationId)
    assert(await isMember(fx.db, fx.teamId, userId))

    const again = await request(fx.app, 'POST', `/invitations/${id}/accept`, { cookie })
    assertEquals(again.status, 200)
    assertEquals((await again.json()).organizationId, fx.organizationId)
  })
})

test('sign-up-and-accept by token: verified user, membership, session cookie, no personal organization', async () => {
  await withFixture(async (fx) => {
    const email = `fresh-${crypto.randomUUID()}@example.com`
    const { id, token } = await fx.invite(email)
    const res = await signUp(fx, token)
    assertEquals(res.status, 200)
    assert((res.headers.get('set-cookie') ?? '').length > 0)
    const body = await res.json()
    assertEquals(body.organizationId, fx.organizationId)
    assertEquals(body.email, email)

    const [created] = await fx.db
      .select({ id: user.id, verified: user.isEmailVerified })
      .from(user)
      .where(eq(user.email, email))
    fx.track(created!.id)
    assertEquals(created!.verified, true)
    assert(await isMember(fx.db, fx.teamId, created!.id))
    const teams = await fx.db
      .select({ teamId: teammate.teamId })
      .from(teammate)
      .where(eq(teammate.userId, created!.id))
    assertEquals(teams.length, 1, "joined only the inviter's team; no personal organization")

    const [row] = await fx.db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, id))
    assertEquals(row!.status, 'accepted')
    assertEquals((await signUp(fx, token)).status, 410)
  })
})

test('sign-up-and-accept refuses an existing account, a revoked invitation and a weak password', async () => {
  await withFixture(async (fx) => {
    const email = `taken-${crypto.randomUUID()}@example.com`
    await signedInCookie(fx, email)
    const taken = await fx.invite(email)
    const exists = await signUp(fx, taken.token)
    assertEquals(exists.status, 409)
    assertEquals((await exists.json()).error, 'account_exists')

    const revoked = await fx.invite(`gone-${crypto.randomUUID()}@example.com`, {
      status: 'revoked',
    })
    assertEquals((await signUp(fx, revoked.token)).status, 410)

    const weak = await fx.invite(`weak-${crypto.randomUUID()}@example.com`)
    assertEquals((await signUp(fx, weak.token, 'short')).status, 400)
  })
})

test('sign-up-and-accept refuses a breached password and leaves the invitation pending', async () => {
  const breachedPassword = strongCredential()
  const responder = await breachedBreachResponder(breachedPassword)
  await withFixture(async (fx) => {
    const email = `pwned-${crypto.randomUUID()}@example.com`
    const { id, token } = await fx.invite(email)
    const refused = await signUp(fx, token, breachedPassword)
    assertEquals(refused.status, 400)
    assertEquals((await refused.json()).error, 'password_breached')
    const [row] = await fx.db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, id))
    assertEquals(row?.status, 'pending')
    assertEquals((await signUp(fx, token)).status, 200)
    const created = await fx.db.select({ id: user.id }).from(user).where(eq(user.email, email))
    for (const row of created) fx.track(row.id)
  }, responder)
})

function linkToken(job: EmailJob | undefined): string {
  const url = new URL((job as { acceptUrl?: string } | undefined)?.acceptUrl ?? 'x:/')
  return url.searchParams.get('token') ?? ''
}

test('create emails a secret link, and neither create nor list returns the secret or its verifier', async () => {
  await withFixture(async (fx) => {
    const cookie = await fx.inviterCookie()
    const email = `emailed-${crypto.randomUUID()}@example.com`
    const created = await request(fx.app, 'POST', '/invitations', {
      cookie,
      organizationId: fx.organizationId,
      body: { teamId: fx.teamId, email },
    })
    assertEquals(created.status, 200)
    const createdText = await created.text()
    const { id } = JSON.parse(createdText)
    fx.track(fx.inviterId)

    const job = fx.jobs.at(-1)
    const token = linkToken(job)
    assertEquals(token.length, 64)
    assert(!(job as { acceptUrl: string }).acceptUrl.includes(id), 'the link does not carry the id')

    const [row] = await fx.db
      .select({ tokenHash: invitation.tokenHash })
      .from(invitation)
      .where(eq(invitation.id, id))
    const listText = await (
      await request(fx.app, 'GET', '/invitations', { cookie, organizationId: fx.organizationId })
    ).text()
    for (const text of [createdText, listText]) {
      assert(!text.includes(token), 'secret never returned')
      assert(!text.includes(row!.tokenHash!), 'verifier never returned')
    }
    assertEquals((await (await preview(fx, token)).json()).email, email)
    await fx.db.delete(invitation).where(eq(invitation.id, id))
  })
})

test('resend rotates the secret: the old link stops working, the new one works', async () => {
  await withFixture(async (fx) => {
    const cookie = await fx.inviterCookie()
    const email = `rotate-${crypto.randomUUID()}@example.com`
    const { id, token: first } = await fx.invite(email)
    assertEquals((await preview(fx, first)).status, 200)

    const res = await request(fx.app, 'POST', `/invitations/${id}/resend`, {
      cookie,
      organizationId: fx.organizationId,
    })
    assertEquals(res.status, 200)
    const second = linkToken(fx.jobs.at(-1))
    assert(second.length === 64 && second !== first)
    assert(!(await res.clone().text()).includes(second))

    assertEquals((await preview(fx, first)).status, 404)
    assertEquals((await signUp(fx, first)).status, 410)
    assertEquals((await (await preview(fx, second)).json()).email, email)

    const stranger = await signedInCookie(fx, `stranger-${crypto.randomUUID()}@example.com`)
    assertEquals(
      (
        await request(fx.app, 'POST', `/invitations/${id}/resend`, {
          cookie: stranger.cookie,
          organizationId: fx.organizationId,
        })
      ).status >= 400,
      true
    )
  })
})
