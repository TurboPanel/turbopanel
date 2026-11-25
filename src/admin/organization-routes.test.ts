import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { ADMIN_API_PREFIX } from '../app/surfaces.ts'
import { getDatabaseUrl } from '../db/url.ts'
import { createDenoDb } from '../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../client/authn/crypto.ts'
import { createSession } from '../client/authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../lib/secrets/secrets.ts'
import {
  grant,
  organization,
  project,
  server,
  team,
  teammate,
  user,
  workspace,
} from '../db/schema.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { pinRootOrganizationForTest } from '../test-fixtures/root-organization.test.support.ts'
import { registerAdminRoutes } from './routes.ts'

const dbUrl = getDatabaseUrl()

/** Jest/Mocha-shaped alias for {@link Deno.test} (Sonar only recognizes `test()`). */
const test = Deno.test.bind(Deno)

type Item = {
  id: string
  name: string | null
  createdAt: string
  owner: { id: string; name: string | null; email: string } | null
  memberCount: number
  serverCount: number
  projectCount: number
  isRoot: boolean
}

async function addUser(db: ReturnType<typeof createDenoDb>, role: string, name: string | null) {
  const [u] = await db
    .insert(user)
    .values({
      email: `org-list-${crypto.randomUUID()}@example.com`,
      name,
      isEmailVerified: true,
      role,
    })
    .returning({ id: user.id, email: user.email })
  return u!
}

test('GET /organizations lists organizations with owner and counts, for platform admins only', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('admin organization list tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerAdminRoutes(app, { secrets, runtime: 'deno', devSurface: false })

  const [orgA] = await db.insert(organization).values({ name: 'List Org A' }).returning({
    id: organization.id,
  })
  const [orgB] = await db.insert(organization).values({ name: 'List Org B' }).returning({
    id: organization.id,
  })
  const restoreRoot = await pinRootOrganizationForTest(db, orgB!.id)
  const ownerA = await addUser(db, 'user', 'Owner A')
  const memberA = await addUser(db, 'user', null)
  const viaTeamA = await addUser(db, 'user', null)
  const plain = await addUser(db, 'user', null)
  const admin = await addUser(db, 'admin', 'Admin')
  const userIds = [ownerA.id, memberA.id, viaTeamA.id, plain.id, admin.id]
  try {
    // Org A: an owner, a manager, and a person who is only on a team. The owner
    // also holds a team grant and is on the team: still one member.
    const [teamA] = await db
      .insert(team)
      .values({ organizationId: orgA!.id, name: 'Team A' })
      .returning({ id: team.id })
    await db.insert(teammate).values([
      { teamId: teamA!.id, userId: viaTeamA.id },
      { teamId: teamA!.id, userId: ownerA.id },
    ])
    await db.insert(grant).values([
      {
        entityType: 'organization',
        entityId: orgA!.id,
        actorType: 'user',
        actorId: ownerA.id,
        permission: 'organization:own',
      },
      {
        entityType: 'organization',
        entityId: orgA!.id,
        actorType: 'user',
        actorId: memberA.id,
        permission: 'organization:manage',
      },
      {
        entityType: 'team',
        entityId: teamA!.id,
        actorType: 'user',
        actorId: ownerA.id,
        permission: 'team:own',
      },
    ])
    const now = new Date().toISOString()
    await db.insert(server).values([
      {
        organizationId: orgA!.id,
        name: 's1',
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
      },
      {
        organizationId: orgA!.id,
        name: 's2',
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
      },
    ])
    const [ws] = await db
      .insert(workspace)
      .values({ organizationId: orgA!.id, name: 'ws' })
      .returning({ id: workspace.id })
    await db.insert(project).values([
      { organizationId: orgA!.id, workspaceId: ws!.id, name: 'p1' },
      { organizationId: orgA!.id, workspaceId: ws!.id, name: 'p2' },
      { organizationId: orgA!.id, workspaceId: ws!.id, name: 'p3' },
    ])

    const cookieFor = async (userId: string) => {
      const { token } = await createSession(db, userId, {})
      return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
    }

    const denied = await app.request(`${ADMIN_API_PREFIX}/organizations`, {
      headers: { Cookie: await cookieFor(plain.id) },
    })
    assertEquals(denied.status, 403)
    const anon = await app.request(`${ADMIN_API_PREFIX}/organizations`)
    assertEquals(anon.status, 401)

    const res = await app.request(`${ADMIN_API_PREFIX}/organizations`, {
      headers: { Cookie: await cookieFor(admin.id) },
    })
    assertEquals(res.status, 200)
    const body = (await res.json()) as { ok: boolean; organizations: Item[] }
    assertEquals(body.ok, true)
    const a = body.organizations.find((o) => o.id === orgA!.id)!
    const b = body.organizations.find((o) => o.id === orgB!.id)!
    assertEquals(a.name, 'List Org A')
    assertEquals(a.owner, { id: ownerA.id, name: 'Owner A', email: ownerA.email })
    assertEquals(a.memberCount, 3)
    assertEquals(a.serverCount, 2)
    assertEquals(a.projectCount, 3)
    assertEquals(a.isRoot, false)
    assertEquals(typeof a.createdAt, 'string')
    assertEquals(b.owner, null)
    assertEquals([b.memberCount, b.serverCount, b.projectCount], [0, 0, 0])
    // Oldest first.
    const ids = body.organizations.map((o) => o.id)
    assertEquals(ids.indexOf(orgA!.id) < ids.indexOf(orgB!.id), true)
    // Exactly one organization is the root: the pinned one, whatever it is named.
    assertEquals(
      body.organizations.filter((o) => o.isRoot).map((o) => o.id),
      [orgB!.id]
    )
  } finally {
    await db.delete(server).where(eq(server.organizationId, orgA!.id))
    await db.delete(organization).where(inArray(organization.id, [orgA!.id, orgB!.id]))
    await restoreRoot()
    await db.delete(user).where(inArray(user.id, userIds))
    await db.delete(grant).where(eq(grant.actorId, ownerA.id))
  }
})
