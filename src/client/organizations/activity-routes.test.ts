/**
 * `GET /organizations/:id/activity` against a real database (skips without
 * TURBOPANEL_DATABASE_URL, like the other real-database suites). Everything is
 * seeded inside one transaction that is rolled back.
 *
 * The cross-organization matrix (`../idor-matrix.test.ts`) also calls this
 * route with B's id from A's session; here the rows themselves are checked:
 * A sees only A's commands, `total` counts only A's, a plain member is refused.
 */
import { assert, assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb, type Db } from '../../db/connection.ts'
import {
  command,
  environment,
  grant,
  organization,
  project,
  server,
  team,
  teammate,
  user,
  workspace,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { registerClientRoutes } from '../routes.ts'

const test = Deno.test.bind(Deno)
const dbUrl = getDatabaseUrl()

class RollbackFixture extends Error {}

async function insertId(promise: Promise<{ id: string }[]>): Promise<string> {
  const [row] = await promise
  return row!.id
}

type Seeded = {
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  cookieOwnerA: string
  cookieMemberA: string
  cookieOwnerB: string
  nonce: string
  serverB: string
}

async function seed(db: Db): Promise<Seeded> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerClientRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const nonce = crypto.randomUUID().slice(0, 8)
  const orgs = await db
    .insert(organization)
    .values([{ name: `Activity A ${nonce}` }, { name: `Activity B ${nonce}` }])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]

  const makeUser = (label: string) =>
    insertId(
      db
        .insert(user)
        .values({
          email: `activity-${label}-${crypto.randomUUID()}@example.com`,
          isEmailVerified: true,
          role: 'user',
        })
        .returning({ id: user.id })
    )
  const cookieFor = async (userId: string) => {
    const { token } = await createSession(db, userId, {})
    return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  }

  const ownerA = await makeUser('owner-a')
  const memberA = await makeUser('member-a')
  const ownerB = await makeUser('owner-b')
  for (const [org, actor] of [
    [orgA, ownerA],
    [orgB, ownerB],
  ] as const) {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: org,
      actorType: 'user',
      actorId: actor,
      permission: 'organization:own',
    })
  }
  const teamA = await insertId(
    db
      .insert(team)
      .values({ organizationId: orgA, name: `activity-team-${nonce}` })
      .returning({ id: team.id })
  )
  await db.insert(teammate).values({ teamId: teamA, userId: memberA })

  const seedOrg = async (org: string, actor: string, label: string, names: string[]) => {
    const serverId = await insertId(
      db
        .insert(server)
        .values({ organizationId: org, name: `activity-${label}-${nonce}` })
        .returning({ id: server.id })
    )
    const workspaceId = await insertId(
      db
        .insert(workspace)
        .values({ organizationId: org, name: `ws-${label}-${nonce}` })
        .returning({ id: workspace.id })
    )
    const projectId = await insertId(
      db
        .insert(project)
        .values({ workspaceId, organizationId: org, name: `Project ${label} ${nonce}` })
        .returning({ id: project.id })
    )
    const environmentId = await insertId(
      db
        .insert(environment)
        .values({ projectId, name: `Env ${label} ${nonce}`, serverId })
        .returning({ id: environment.id })
    )
    for (const [index, spec] of names.entries()) {
      const [name, status] = spec.split(':')
      await db.insert(command).values({
        serverId,
        actorType: 'user',
        actorId: actor,
        name: name!,
        status: status!,
        context: { environmentId, projectId },
        errorMessage: status === 'failed' ? `boom ${label}` : null,
        createdAt: new Date(Date.now() - index * 1000).toISOString(),
      })
    }
    return serverId
  }
  await seedOrg(orgA, ownerA, 'a', [
    'environment.deploy:running',
    'environment.deploy:failed',
    'environment.lifecycle:queued',
    'environment.deploy:succeeded',
    'environment.stop:cancelled',
    'server.ping:running',
  ])
  const serverB = await seedOrg(orgB, ownerB, 'b', [
    'environment.deploy:running',
    'environment.deploy:running',
    'environment.deploy:failed',
  ])
  return {
    app,
    orgA,
    orgB,
    cookieOwnerA: await cookieFor(ownerA),
    cookieMemberA: await cookieFor(memberA),
    cookieOwnerB: await cookieFor(ownerB),
    nonce,
    serverB,
  }
}

async function withSeed(fn: (s: Seeded) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping activity route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  try {
    await createDenoDb().transaction(async (tx) => {
      await fn(await seed(tx as unknown as Db))
      throw new RollbackFixture()
    })
  } catch (error) {
    if (!(error instanceof RollbackFixture)) throw error
  }
}

type Feed = {
  items: {
    id: string
    state: string
    action: string
    serverId: string
    projectName: string | null
  }[]
  total: number
  hasMore: boolean
}

async function get(s: Seeded, cookie: string, orgId: string, query = '', header?: string) {
  const headers: Record<string, string> = { cookie }
  if (header !== undefined) headers['X-Turbopanel-Organization-Id'] = header
  const res = await s.app.request(`/api/client/v1/organizations/${orgId}/activity${query}`, {
    headers,
  })
  return { status: res.status, text: await res.text() }
}

test('an owner sees only their own organization’s running and failed commands', async () => {
  await withSeed(async (s) => {
    const res = await get(s, s.cookieOwnerA, s.orgA)
    assertEquals(res.status, 200, res.text)
    const feed = JSON.parse(res.text) as Feed
    // running deploy, failed deploy, queued lifecycle: not succeeded, cancelled or ping
    assertEquals(feed.total, 3)
    assertEquals(
      feed.items.map((i) => [i.action, i.state]),
      [
        ['deploy', 'deploying'],
        ['deploy', 'failed'],
        ['restart', 'deploying'],
      ]
    )
    assert(feed.items.every((i) => i.serverId !== s.serverB))
    assert(feed.items.every((i) => i.projectName === `Project a ${s.nonce}`))
    assert(!res.text.includes('boom b'))
    assert(!res.text.includes(`Project b ${s.nonce}`))
  })
})

test('filters and pagination count only the caller’s organization', async () => {
  await withSeed(async (s) => {
    const deploying = JSON.parse(
      (await get(s, s.cookieOwnerA, s.orgA, '?filter=deploying')).text
    ) as Feed
    assertEquals(deploying.total, 2)
    const failed = JSON.parse((await get(s, s.cookieOwnerA, s.orgA, '?filter=failed')).text) as Feed
    assertEquals(failed.total, 1)
    assertEquals(failed.items[0]?.state, 'failed')
    const page = JSON.parse(
      (await get(s, s.cookieOwnerA, s.orgA, '?limit=2&offset=0')).text
    ) as Feed
    assertEquals([page.items.length, page.total, page.hasMore], [2, 3, true])
    const last = JSON.parse(
      (await get(s, s.cookieOwnerA, s.orgA, '?limit=2&offset=2')).text
    ) as Feed
    assertEquals([last.items.length, last.total, last.hasMore], [1, 3, false])
    const b = JSON.parse((await get(s, s.cookieOwnerB, s.orgB)).text) as Feed
    assertEquals(b.total, 3)
  })
})

test('another organization, a plain member, bad queries and no session are all refused', async () => {
  await withSeed(async (s) => {
    for (const header of [undefined, s.orgA, s.orgB]) {
      const foreign = await get(s, s.cookieOwnerA, s.orgB, '', header)
      assertEquals(foreign.status, 404, foreign.text)
      assert(!foreign.text.includes(s.nonce))
    }
    assertEquals((await get(s, s.cookieOwnerA, 'not-a-uuid')).status, 404)
    assertEquals((await get(s, s.cookieMemberA, s.orgA)).status, 403)
    assertEquals((await get(s, s.cookieOwnerA, s.orgA, '?filter=crashing')).status, 400)
    assertEquals((await get(s, s.cookieOwnerA, s.orgA, '?limit=0')).status, 400)
    assertEquals((await get(s, '', s.orgA)).status, 401)
  })
})
