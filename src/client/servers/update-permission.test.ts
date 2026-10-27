/**
 * Who may start daemon updates (`POST /servers/:id/update`,
 * `POST /servers/updates`): owners and managers of the server's own
 * organization and instance admins, on TurboPanel High Availability (Workers)
 * as well as self-hosted. Anyone else gets 403, and a manager never reaches
 * another organization's servers. Needs Postgres (`TURBOPANEL_DATABASE_URL`).
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { DaemonCell, DaemonCellRegistry } from '../../contracts/cell.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { grant, organization, server, team, teammate, upgrade, user } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  resetUpdateManifestCacheForTests,
  seedUpdateManifestCacheForTests,
  type UpdateManifestTarget,
} from '../../features/update/manifest.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerServerRoutes } from './routes.ts'
import { canUpdateOrgServers } from './update-permission.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

function daemonTarget(kind: 'daemon' | 'instance' | 'ui'): UpdateManifestTarget {
  return {
    commit: `${kind}-target-commit`,
    version: '0.1.21-canary.3',
    buildId: `${kind}-build`,
    builtAt: '2026-10-27T15:30:53.000Z',
    channel: 'release',
    manifestUrl: `https://example.test/${kind}/manifest.json`,
  }
}

function idleRegistry(): DaemonCellRegistry {
  const cell = {
    getSnapshot: () =>
      Promise.resolve({ serverId: '', version: 0, updatedAt: '', connected: false }),
    enqueue: () => Promise.reject(new Error('an offline server is never dispatched')),
  } as unknown as DaemonCell
  return {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  serverA: string
  serverB: string
  managerA: string
  memberA: string
  admin: string
  superadmin: string
  cookie: (userId: string) => Promise<string>
}

async function insertUser(db: Db, label: string, role: 'user' | 'admin' | 'superadmin') {
  const [row] = await db
    .insert(user)
    .values({ email: `${label}-${crypto.randomUUID()}@example.com`, isEmailVerified: true, role })
    .returning({ id: user.id })
  return row!.id
}

async function insertOrgWithServer(db: Db, name: string) {
  const [org] = await db.insert(organization).values({ name }).returning({ id: organization.id })
  const now = new Date().toISOString()
  const [row] = await db
    .insert(server)
    .values({ createdAt: now, updatedAt: now, organizationId: org!.id, name: `${name} Host` })
    .returning({ id: server.id })
  return { organizationId: org!.id, serverId: row!.id }
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  const registry = idleRegistry()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', registry)
    return next()
  })
  registerServerRoutes(app, { secrets, runtime: 'workers', signupEnvOverride: undefined })
  resetUpdateManifestCacheForTests()
  for (const kind of ['daemon', 'instance', 'ui'] as const) {
    seedUpdateManifestCacheForTests(daemonTarget(kind), 'release', kind)
  }

  const a = await insertOrgWithServer(db, 'Update Permission A')
  const b = await insertOrgWithServer(db, 'Update Permission B')
  const managerA = await insertUser(db, 'update-manager-a', 'user')
  const memberA = await insertUser(db, 'update-member-a', 'user')
  const admin = await insertUser(db, 'update-admin', 'admin')
  const superadmin = await insertUser(db, 'update-superadmin', 'superadmin')
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: a.organizationId,
    actorType: 'user',
    actorId: managerA,
    permission: 'organization:manage',
  })
  const [teamRow] = await db
    .insert(team)
    .values({ name: 'Update Permission Members', organizationId: a.organizationId })
    .returning({ id: team.id })
  await db.insert(teammate).values([
    { teamId: teamRow!.id, userId: managerA },
    { teamId: teamRow!.id, userId: memberA },
  ])
  const users = [managerA, memberA, admin, superadmin]
  try {
    await fn({
      db,
      app,
      orgA: a.organizationId,
      orgB: b.organizationId,
      serverA: a.serverId,
      serverB: b.serverId,
      managerA,
      memberA,
      admin,
      superadmin,
      cookie: async (userId) => {
        const { token } = await createSession(db, userId, {})
        return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
      },
    })
  } finally {
    await db.delete(upgrade).where(inArray(upgrade.startedBy, users))
    await db.delete(teammate).where(eq(teammate.teamId, teamRow!.id))
    await db.delete(team).where(eq(team.id, teamRow!.id))
    await db.delete(grant).where(eq(grant.actorId, managerA))
    await db.delete(server).where(inArray(server.id, [a.serverId, b.serverId]))
    await db.delete(user).where(inArray(user.id, users))
    await db
      .delete(organization)
      .where(inArray(organization.id, [a.organizationId, b.organizationId]))
    resetUpdateManifestCacheForTests()
    await endDbConnection(db)
  }
}

async function postAs(fx: Fixture, userId: string, path: string, orgId: string) {
  const res = await fx.app.request(path, {
    method: 'POST',
    headers: { Cookie: await fx.cookie(userId), [ORG_ID_HEADER]: orgId },
  })
  const body = (await res.json()) as { ok?: boolean; error?: string }
  return { status: res.status, body }
}

function startServerUpdate(fx: Fixture, userId: string, serverId: string, orgId: string) {
  return postAs(fx, userId, `/servers/${serverId}/update`, orgId)
}

function startFleetUpdate(fx: Fixture, userId: string, orgId: string) {
  return postAs(fx, userId, '/servers/updates', orgId)
}

/**
 * Past the permission check: the run starts, or answers 409
 * `upgrade_run_active` when another run is open (the run is instance-wide).
 * Never 401/403, and never the old hosted `updates_managed` refusal.
 */
function assertAllowed(result: { status: number; body: { ok?: boolean; error?: string } }): void {
  assertNotEquals(result.body.error, 'updates_managed')
  if (result.status === 409) {
    assertEquals(result.body.error, 'upgrade_run_active')
    return
  }
  assertEquals(result, { status: 200, body: { ...result.body, ok: true } })
}

function assertForbidden(result: { status: number }): void {
  assertEquals(result.status, 403)
}

test('canUpdateOrgServers: own-organization manager and instance admins only', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('server update permission tests')
    return
  }
  await withFixture(async (fx) => {
    const onServer = (id: string) => ({ kind: 'server' as const, id })
    assertEquals(await canUpdateOrgServers(fx.db, fx.managerA, onServer(fx.serverA)), true)
    assertEquals(await canUpdateOrgServers(fx.db, fx.managerA, onServer(fx.serverB)), false)
    assertEquals(await canUpdateOrgServers(fx.db, fx.memberA, onServer(fx.serverA)), false)
    assertEquals(await canUpdateOrgServers(fx.db, fx.admin, onServer(fx.serverB)), true)
    assertEquals(await canUpdateOrgServers(fx.db, fx.superadmin, onServer(fx.serverB)), true)
    assertEquals(
      await canUpdateOrgServers(fx.db, fx.managerA, { kind: 'organization', id: fx.orgB }),
      false
    )
  })
})

test('POST /servers/:id/update on the hosted control plane: manager of the server organization may start it', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('server update permission tests')
    return
  }
  await withFixture(async (fx) => {
    assertAllowed(await startServerUpdate(fx, fx.managerA, fx.serverA, fx.orgA))
  })
})

test('POST /servers/:id/update refuses a manager of another organization and a plain member', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('server update permission tests')
    return
  }
  await withFixture(async (fx) => {
    assertForbidden(await startServerUpdate(fx, fx.managerA, fx.serverB, fx.orgA))
    assertForbidden(await startServerUpdate(fx, fx.memberA, fx.serverA, fx.orgA))
  })
})

test('POST /servers/:id/update lets an instance admin update a server in any organization', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('server update permission tests')
    return
  }
  await withFixture(async (fx) => {
    assertAllowed(await startServerUpdate(fx, fx.admin, fx.serverB, fx.orgB))
    assertAllowed(await startServerUpdate(fx, fx.superadmin, fx.serverA, fx.orgA))
  })
})

test('POST /servers/updates is scoped to the manager organization', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('server update permission tests')
    return
  }
  await withFixture(async (fx) => {
    assertAllowed(await startFleetUpdate(fx, fx.managerA, fx.orgA))
    assertForbidden(await startFleetUpdate(fx, fx.managerA, fx.orgB))
    assertForbidden(await startFleetUpdate(fx, fx.memberA, fx.orgA))
    assertAllowed(await startFleetUpdate(fx, fx.admin, fx.orgB))
  })
})

test('GET /servers/:id/update no longer reports hosted updates as platform-managed', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('server update permission tests')
    return
  }
  await withFixture(async (fx) => {
    const res = await fx.app.request(`/servers/${fx.serverA}/update`, {
      headers: { Cookie: await fx.cookie(fx.managerA), [ORG_ID_HEADER]: fx.orgA },
    })
    assertEquals(res.status, 200)
    const body = (await res.json()) as { updateBlockedCode?: string }
    assertNotEquals(body.updateBlockedCode, 'updates_managed')
  })
})
