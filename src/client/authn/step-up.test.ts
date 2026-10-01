import { assertEquals } from '@std/assert'
import { and, eq, inArray, like } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  account,
  environment,
  grant,
  organization,
  project,
  session,
  user,
  verification,
  workspace,
} from '../../db/schema.ts'
import { hashPassword } from '../../lib/secrets/password.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerEnvironmentRoutes } from '../environments/routes.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerOrganizationMemberRoutes } from '../organizations/members.ts'
import { registerReauthSettingsRoutes } from '../organizations/reauth-settings-routes.ts'
import { createAuthRateLimiter, setSharedAuthRateLimiterForTests } from './auth-rate-limit.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from './crypto.ts'
import { registerAuthRoutes } from './http.ts'
import { createSessionMiddleware } from './middleware.ts'
import { createSession } from './session-store.ts'
import { requireStepUpIfConfigured, STEP_UP_WINDOW_MS, stepUpIdentifier } from './step-up.ts'
import { STEP_UP_ACTIONS } from './step-up-actions.ts'
import { decodeBase32, generateTotp, TOTP_STEP_SECONDS } from './totp.ts'
import { BACKUP_CODE_VERIFIER_PURPOSE, enrollTotp, verifyTotpEnrollment } from './two-factor.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const API = `${CLIENT_API_PREFIX}`

type Db = ReturnType<typeof createDenoDb>
type Fixture = Awaited<ReturnType<typeof buildFixture>>

async function buildFixture(db: Db, reauthLimit = 1000) {
  const config = parseTestSecretsConfig('deno')
  const sessionSecrets = await deriveSecretsConfig(config, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(config, 'data-encryption')
  const backupCodeVerifierSecrets = await deriveSecretsConfig(config, BACKUP_CODE_VERIFIER_PURPOSE)
  const limiter = createAuthRateLimiter({
    defaultPolicy: { limit: 1000, windowMs: 60_000 },
    policies: { reauth: { limit: reauthLimit, windowMs: 60_000 } },
  })
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    c.set('authRateLimiter', limiter)
    return next()
  })
  const client = new Hono<AppEnv>()
  const opts = {
    secrets: sessionSecrets,
    backupCodeVerifierSecrets,
    runtime: 'deno' as const,
    signupEnvOverride: undefined,
  }
  registerAuthRoutes(client, opts)
  registerReauthSettingsRoutes(client, opts)
  registerOrganizationMemberRoutes(client, opts)
  registerEnvironmentRoutes(client, opts)
  // A stand-in destructive route: any route wired to the gate behaves like it.
  client.use('/probe/*', createSessionMiddleware(sessionSecrets))
  client.delete('/probe/:orgId', async (c) => {
    const gate = await requireStepUpIfConfigured(c, c.req.param('orgId'), 'project.delete')
    return gate ?? c.json({ ok: true })
  })
  app.route(CLIENT_API_PREFIX, client)
  return { app, sessionSecrets, dataEncryptionSecrets, backupCodeVerifierSecrets }
}

/** The reauth request body for a typed-in secret; the value is always built at run time. */
function proofBody(typed: string) {
  return { password: typed }
}

async function makeUser(db: Db, password: string | null) {
  const email = `step-up-${crypto.randomUUID()}@example.com`
  const [row] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = row!.id
  if (password !== null) {
    await db.insert(account).values({
      userId,
      providerId: 'credential',
      providerUserId: userId,
      password: await hashPassword(password),
    })
  }
  return { userId, email }
}

/** A signed-in cookie whose session is older than the step-up window. */
async function agedSession(db: Db, fx: Fixture, userId: string) {
  const { token } = await createSession(db, userId, {})
  const old = new Date(Date.now() - 2 * STEP_UP_WINDOW_MS).toISOString()
  const [row] = await db
    .update(session)
    .set({ createdAt: old })
    .where(eq(session.token, token))
    .returning({ id: session.id })
  const signed = await buildSignedCookie(token, fx.sessionSecrets)
  return { cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}`, sessionId: row!.id }
}

function req(fx: Fixture, method: string, path: string, cookie: string, body?: unknown) {
  return fx.app.request(`${API}${path}`, {
    method,
    headers: {
      cookie,
      'content-type': 'application/json',
      'X-Real-IP': '203.0.113.7',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function setOrgReauth(db: Db, organizationId: string, on: boolean) {
  await db
    .update(organization)
    .set({ options: { requireReauthForDestructive: on } })
    .where(eq(organization.id, organizationId))
}

async function withScene(
  fn: (s: {
    db: Db
    fx: Fixture
    orgA: string
    orgB: string
    owner: { userId: string; email: string }
    password: string
    cookie: string
    sessionId: string
  }) => Promise<void>,
  reauthLimit = 1000
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping step-up tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const fx = await buildFixture(db, reauthLimit)
  // Built at run time: never a password literal in a test file.
  const password = `pw-${crypto.randomUUID()}`
  const owner = await makeUser(db, password)
  const orgs = await db
    .insert(organization)
    .values([{ name: 'Step-up A' }, { name: 'Step-up B' }])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]
  await db.insert(grant).values(
    [orgA, orgB].map((entityId) => ({
      entityType: 'organization',
      entityId,
      actorType: 'user',
      actorId: owner.userId,
      permission: 'organization:own',
    }))
  )
  const { cookie, sessionId } = await agedSession(db, fx, owner.userId)
  setSharedAuthRateLimiterForTests(undefined)
  try {
    await fn({ db, fx, orgA, orgB, owner, password, cookie, sessionId })
  } finally {
    setSharedAuthRateLimiterForTests(undefined)
    await db.delete(verification).where(like(verification.identifier, 'reauth:%'))
    await db
      .delete(verification)
      .where(
        inArray(verification.identifier, [
          `2fa-attempts:${owner.userId}`,
          `2fa-used:${owner.userId}`,
        ])
      )
    await db.delete(session).where(eq(session.userId, owner.userId))
    await db.delete(grant).where(eq(grant.actorId, owner.userId))
    await db.delete(organization).where(inArray(organization.id, [orgA, orgB]))
    await db.delete(user).where(eq(user.id, owner.userId))
  }
}

test('registry names every gated action once', () => {
  const keys = Object.keys(STEP_UP_ACTIONS)
  assertEquals(new Set(keys).size, keys.length)
  assertEquals(keys.includes('environment.delete'), true)
})

test('setting off: permanent actions are unchanged', async () => {
  await withScene(async ({ fx, orgA, cookie }) => {
    const res = await req(fx, 'DELETE', `/probe/${orgA}`, cookie)
    assertEquals(res.status, 200)
  })
})

test('setting on: 403 reauth_required, then pass after reauth, then expiry', async () => {
  await withScene(async ({ db, fx, orgA, cookie, sessionId, password }) => {
    await setOrgReauth(db, orgA, true)

    const refused = await req(fx, 'DELETE', `/probe/${orgA}`, cookie)
    assertEquals(refused.status, 403)
    const body = (await refused.json()) as Record<string, unknown>
    assertEquals(body.error, 'reauth_required')
    assertEquals(body.code, 'reauth_required')
    assertEquals(body.action, 'project.delete')
    assertEquals(body.methods, ['password'])

    const reauth = await req(fx, 'POST', '/auth/reauth', cookie, { password })
    assertEquals(reauth.status, 200)
    assertEquals((await req(fx, 'DELETE', `/probe/${orgA}`, cookie)).status, 200)

    // The stamp lapses on its own: push it into the past and the gate returns.
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(verification.identifier, stepUpIdentifier(sessionId)))
    assertEquals((await req(fx, 'DELETE', `/probe/${orgA}`, cookie)).status, 403)
  })
})

test('a session that just signed in is not asked again', async () => {
  await withScene(async ({ db, fx, orgA, owner }) => {
    await setOrgReauth(db, orgA, true)
    const { token } = await createSession(db, owner.userId, {})
    const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(
      token,
      fx.sessionSecrets
    )}`
    assertEquals((await req(fx, 'DELETE', `/probe/${orgA}`, cookie)).status, 200)
  })
})

test('a wrong password is refused and the gate stays shut', async () => {
  await withScene(async ({ db, fx, orgA, cookie }) => {
    await setOrgReauth(db, orgA, true)
    const wrong = await req(fx, 'POST', '/auth/reauth', cookie, proofBody(crypto.randomUUID()))
    assertEquals(wrong.status, 403)
    assertEquals((await req(fx, 'DELETE', `/probe/${orgA}`, cookie)).status, 403)
  })
})

test('wrong-password guesses are throttled: 429 once the reauth bucket is spent', async () => {
  await withScene(async ({ db, fx, orgA, cookie }) => {
    await setOrgReauth(db, orgA, true)
    const statuses: number[] = []
    for (let i = 0; i < 4; i += 1) {
      const res = await req(fx, 'POST', '/auth/reauth', cookie, proofBody(crypto.randomUUID()))
      statuses.push(res.status)
    }
    assertEquals(statuses, [403, 403, 429, 429])
  }, 2)
})

test('authenticator path: code required, password refused, replay refused', async () => {
  await withScene(async ({ db, fx, orgA, owner, cookie, password }) => {
    await setOrgReauth(db, orgA, true)
    const enrolled = await enrollTotp(db, {
      userId: owner.userId,
      email: owner.email,
      dataEncryptionSecrets: fx.dataEncryptionSecrets,
    })
    const secret = decodeBase32(enrolled.secret)
    const now = Math.floor(Date.now() / 1000)
    await verifyTotpEnrollment(db, {
      userId: owner.userId,
      code: await generateTotp(secret, { unixSeconds: now - TOTP_STEP_SECONDS }),
      dataEncryptionSecrets: fx.dataEncryptionSecrets,
      backupCodeVerifierSecrets: fx.backupCodeVerifierSecrets,
    })

    const refused = await req(fx, 'DELETE', `/probe/${orgA}`, cookie)
    assertEquals(((await refused.json()) as { methods: string[] }).methods, ['totp'])

    // The password alone is weaker than their sign-in, so it is not accepted.
    assertEquals((await req(fx, 'POST', '/auth/reauth', cookie, { password })).status, 400)
    assertEquals((await req(fx, 'POST', '/auth/reauth', cookie, { code: '000000' })).status, 403)
    assertEquals((await req(fx, 'DELETE', `/probe/${orgA}`, cookie)).status, 403)

    const code = await generateTotp(secret, { unixSeconds: now })
    assertEquals((await req(fx, 'POST', '/auth/reauth', cookie, { code })).status, 200)
    assertEquals((await req(fx, 'DELETE', `/probe/${orgA}`, cookie)).status, 200)

    // The same code twice is a replay, even from a signed-in session.
    assertEquals((await req(fx, 'POST', '/auth/reauth', cookie, { code })).status, 403)
  })
})

test('cross-org and cross-session isolation', async () => {
  await withScene(async ({ db, fx, orgA, orgB, owner, cookie, password }) => {
    await setOrgReauth(db, orgB, true)
    // Org A never turned it on, so org A is untouched by org B's setting.
    assertEquals((await req(fx, 'DELETE', `/probe/${orgA}`, cookie)).status, 200)
    assertEquals((await req(fx, 'DELETE', `/probe/${orgB}`, cookie)).status, 403)

    await req(fx, 'POST', '/auth/reauth', cookie, { password })
    assertEquals((await req(fx, 'DELETE', `/probe/${orgB}`, cookie)).status, 200)

    // The stamp belongs to one session: the same person's other session is
    // still asked.
    const other = await agedSession(db, fx, owner.userId)
    assertEquals((await req(fx, 'DELETE', `/probe/${orgB}`, other.cookie)).status, 403)
  })
})

test('only an owner can change the setting', async () => {
  await withScene(async ({ db, fx, orgA, cookie }) => {
    const manager = await makeUser(db, null)
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: orgA,
      actorType: 'user',
      actorId: manager.userId,
      permission: 'organization:manage',
    })
    const managerSession = await agedSession(db, fx, manager.userId)
    try {
      const path = `/organizations/${orgA}/reauth-settings`
      const denied = await req(fx, 'PUT', path, managerSession.cookie, {
        requireReauthForDestructive: true,
      })
      assertEquals(denied.status, 403)
      assertEquals(
        (
          (await (await req(fx, 'GET', path, cookie)).json()) as {
            requireReauthForDestructive: boolean
          }
        ).requireReauthForDestructive,
        false
      )

      assertEquals(
        (await req(fx, 'PUT', path, cookie, { requireReauthForDestructive: 'yes' })).status,
        400
      )
      const ok = await req(fx, 'PUT', path, cookie, {
        requireReauthForDestructive: true,
      })
      assertEquals(ok.status, 200)
      const [row] = await db
        .select({ options: organization.options })
        .from(organization)
        .where(eq(organization.id, orgA))
      assertEquals((row!.options as Record<string, unknown>).requireReauthForDestructive, true)
    } finally {
      await db.delete(session).where(eq(session.userId, manager.userId))
      await db.delete(grant).where(eq(grant.actorId, manager.userId))
      await db.delete(user).where(eq(user.id, manager.userId))
    }
  })
})

test('remove member is wired to the gate', async () => {
  await withScene(async ({ db, fx, orgA, cookie, password }) => {
    await setOrgReauth(db, orgA, true)
    const member = await makeUser(db, null)
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: orgA,
      actorType: 'user',
      actorId: member.userId,
      permission: 'organization:manage',
    })
    try {
      const path = `/organizations/${orgA}/members/${member.userId}`
      const refused = await req(fx, 'DELETE', path, cookie)
      assertEquals(refused.status, 403)
      assertEquals(((await refused.json()) as { action: string }).action, 'member.remove')
      const stillThere = await db
        .select({ id: grant.id })
        .from(grant)
        .where(and(eq(grant.actorId, member.userId), eq(grant.entityId, orgA)))
      assertEquals(stillThere.length, 1)

      await req(fx, 'POST', '/auth/reauth', cookie, { password })
      assertEquals((await req(fx, 'DELETE', path, cookie)).status, 200)
    } finally {
      await db.delete(grant).where(eq(grant.actorId, member.userId))
      await db.delete(user).where(eq(user.id, member.userId))
    }
  })
})

/** A project with one never-deployed environment in the org: nothing blocks its delete. */
async function makeStoppedEnvironment(db: Db, organizationId: string, label: string) {
  const [ws] = await db
    .insert(workspace)
    .values({ name: `Step-up Workspace ${label}`, organizationId })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ name: `Step-up Project ${label}`, workspaceId: ws!.id, organizationId })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: `Step-up Environment ${label}` })
    .returning({ id: environment.id })
  return { workspaceId: ws!.id, projectId: proj!.id, environmentId: env!.id }
}

function deleteEnvironment(fx: Fixture, orgId: string, envId: string, cookie: string) {
  return fx.app.request(`${API}/environments/${envId}`, {
    method: 'DELETE',
    headers: { cookie, [ORG_ID_HEADER]: orgId, 'X-Real-IP': '203.0.113.7' },
  })
}

async function environmentExists(db: Db, envId: string) {
  const rows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.id, envId))
  return rows.length === 1
}

test('delete environment is wired to the gate', async () => {
  await withScene(async ({ db, fx, orgA, cookie, password }) => {
    const off = await makeStoppedEnvironment(db, orgA, 'off')
    const on = await makeStoppedEnvironment(db, orgA, 'on')
    try {
      // Setting off: the delete is not prompted.
      assertEquals((await deleteEnvironment(fx, orgA, off.environmentId, cookie)).status, 200)
      assertEquals(await environmentExists(db, off.environmentId), false)

      await setOrgReauth(db, orgA, true)
      const refused = await deleteEnvironment(fx, orgA, on.environmentId, cookie)
      assertEquals(refused.status, 403)
      const body = (await refused.json()) as { error: string; action: string }
      assertEquals(body.error, 'reauth_required')
      assertEquals(body.action, 'environment.delete')
      assertEquals(await environmentExists(db, on.environmentId), true)

      await req(fx, 'POST', '/auth/reauth', cookie, proofBody(password))
      assertEquals((await deleteEnvironment(fx, orgA, on.environmentId, cookie)).status, 200)
      assertEquals(await environmentExists(db, on.environmentId), false)
    } finally {
      await db.delete(environment).where(eq(environment.projectId, off.projectId))
      await db.delete(environment).where(eq(environment.projectId, on.projectId))
      await db.delete(project).where(eq(project.workspaceId, off.workspaceId))
      await db.delete(project).where(eq(project.workspaceId, on.workspaceId))
      await db.delete(workspace).where(eq(workspace.organizationId, orgA))
    }
  })
})
