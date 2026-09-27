/**
 * Invitation landing page against a real Postgres: the preview, the
 * signed-in Accept button (explicit, idempotent, invited email only) and the
 * new-account sign-up-and-accept (verified user, membership, session, no
 * personal organization). Skips without TURBOPANEL_DATABASE_URL.
 */
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
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerAccessRoutes } from '../access/routes.ts'
import { createAuthRateLimiter } from './auth-rate-limit.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from './crypto.ts'
import { registerAuthRoutes } from './http.ts'
import { createOrganizationForUser } from './install-state.ts'
import { invitationStatus, parseInvitationSignUpBody } from './invitation-landing-http.ts'
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
  invite: (email: string, opts?: { status?: string; expiresAt?: string }) => Promise<string>
  track: (userId: string) => void
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping invitation landing tests: TURBOPANEL_DATABASE_URL not set')
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
  const invitations: string[] = []

  const app = new Hono<AppEnv>()
  const client = new Hono<AppEnv>()
  client.use('*', (c, next) => {
    c.set('db', db)
    c.set('platformEnv', { TURBOPANEL_BASE_URL: 'https://panel.example.com' })
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
    const [row] = await db
      .insert(invitation)
      .values({
        userId: inviterId,
        teamId,
        email,
        status: opts.status ?? 'pending',
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
      })
      .returning({ id: invitation.id })
    invitations.push(row!.id)
    return row!.id
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
  opts: { body?: unknown; cookie?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '203.0.113.60' }
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

test('preview of a pending invitation to a new address: accountExists false, never accepts', async () => {
  await withFixture(async (fx) => {
    const email = `new-${crypto.randomUUID()}@example.com`
    const id = await fx.invite(email)
    const res = await request(fx.app, 'GET', `/auth/invitations/${id}`)
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.status, 'pending')
    assertEquals(body.organizationName, 'Acme Test')
    assertEquals(body.email, email)
    assertEquals(body.accountExists, false)
    const [row] = await fx.db
      .select({ status: invitation.status })
      .from(invitation)
      .where(eq(invitation.id, id))
    assertEquals(row!.status, 'pending')
  })
})

test('preview reports an existing account, expired and accepted states, and 404s', async () => {
  await withFixture(async (fx) => {
    const email = `existing-${crypto.randomUUID()}@example.com`
    await signedInCookie(fx, email)
    const pending = await fx.invite(email)
    assertEquals(
      (await (await request(fx.app, 'GET', `/auth/invitations/${pending}`)).json()).accountExists,
      true
    )

    const expired = await fx.invite(`x-${crypto.randomUUID()}@example.com`, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const expiredBody = await (await request(fx.app, 'GET', `/auth/invitations/${expired}`)).json()
    assertEquals(expiredBody.status, 'expired')
    assertEquals(expiredBody.email, undefined)
    assertEquals(expiredBody.accountExists, undefined)

    const accepted = await fx.invite(`y-${crypto.randomUUID()}@example.com`, { status: 'accepted' })
    assertEquals(
      (await (await request(fx.app, 'GET', `/auth/invitations/${accepted}`)).json()).status,
      'accepted'
    )

    assertEquals(
      (await request(fx.app, 'GET', `/auth/invitations/${crypto.randomUUID()}`)).status,
      404
    )
    assertEquals((await request(fx.app, 'GET', '/auth/invitations/not-a-uuid')).status, 404)
  })
})

test('Accept button: invited email joins, repeat is idempotent, another account is refused', async () => {
  await withFixture(async (fx) => {
    const email = `member-${crypto.randomUUID()}@example.com`
    const { cookie, userId } = await signedInCookie(fx, email)
    const id = await fx.invite(email)

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

test('sign-up-and-accept: verified user, membership, session cookie, no personal organization', async () => {
  await withFixture(async (fx) => {
    const email = `fresh-${crypto.randomUUID()}@example.com`
    const id = await fx.invite(email)
    const res = await request(fx.app, 'POST', `/auth/invitations/${id}/sign-up`, {
      body: { password: strongCredential() },
    })
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

    const reused = await request(fx.app, 'POST', `/auth/invitations/${id}/sign-up`, {
      body: { password: strongCredential() },
    })
    assertEquals(reused.status, 410)
  })
})

test('sign-up-and-accept refuses an existing account, a used invitation and a weak password', async () => {
  await withFixture(async (fx) => {
    const email = `taken-${crypto.randomUUID()}@example.com`
    await signedInCookie(fx, email)
    const id = await fx.invite(email)
    const exists = await request(fx.app, 'POST', `/auth/invitations/${id}/sign-up`, {
      body: { password: strongCredential() },
    })
    assertEquals(exists.status, 409)
    assertEquals((await exists.json()).error, 'account_exists')

    const revoked = await fx.invite(`gone-${crypto.randomUUID()}@example.com`, {
      status: 'revoked',
    })
    assertEquals(
      (
        await request(fx.app, 'POST', `/auth/invitations/${revoked}/sign-up`, {
          body: { password: strongCredential() },
        })
      ).status,
      410
    )

    const weak = await fx.invite(`weak-${crypto.randomUUID()}@example.com`)
    assertEquals(
      (
        await request(fx.app, 'POST', `/auth/invitations/${weak}/sign-up`, {
          body: { password: 'short' },
        })
      ).status,
      400
    )
  })
})
