import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import {
  datacenter,
  grant,
  membership,
  network,
  organization,
  server,
  user,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerNetworkRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

async function createNetworkRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno' })
  return { app, secrets }
}

async function withNetworkFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createNetworkRoutesTestApp(db)

  const [org] = await db
    .insert(organization)
    .values({ name: 'Network Route Fixture Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id

  const [u] = await db
    .insert(user)
    .values({
      email: `net-fixture-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  try {
    await fn({ db, app, secrets, userId, organizationId })
  } finally {
    await db.delete(network).where(eq(network.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(membership).where(and(
      eq(membership.userId, userId),
      eq(membership.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST /networks requires dockerNetworkName for kind=docker', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Docker Net Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `docker-net-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const cookie = await sessionCookie(db, secrets, userId)
  const missing = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      options: {},
    }),
  })
  assertEquals(missing.status, 400)
  assertEquals((await missing.json()).error, 'docker_network_name_required')

  const created = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      options: { dockerNetworkName: '  turbopanel-shared  ' },
    }),
  })
  assertEquals(created.status, 200)
  const createdBody = await created.json() as { ok: true; id: string }
  assertEquals(createdBody.ok, true)

  await db.delete(network).where(eq(network.id, createdBody.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('POST /networks rejects datacenterId and serverId together', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Net Test Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `net-test-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, name: 'DC1', createdAt: now, updatedAt: now })
    .returning({ id: datacenter.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Host1', createdAt: now, updatedAt: now })
    .returning({ id: server.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      datacenterId: dc!.id,
      serverId: srv!.id,
      options: { dockerNetworkName: 'shared' },
    }),
  })

  assertEquals(res.status, 400)
  const body = await res.json()
  assertEquals(body.error, 'network_single_scope_conflict')

  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('POST /networks rejects kind=vpn and requires per-kind scope FKs', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Net Scope Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `net-scope-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, name: 'DC1', createdAt: now, updatedAt: now })
    .returning({ id: datacenter.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Host1', createdAt: now, updatedAt: now })
    .returning({ id: server.id })

  const cookie = await sessionCookie(db, secrets, userId)

  const vpnKind = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'vpn',
      cidr: '203.0.113.0/24',
    }),
  })
  assertEquals(vpnKind.status, 400)

  const missingDc = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'datacenter',
    }),
  })
  assertEquals(missingDc.status, 400)
  assertEquals((await missingDc.json()).error, 'network_scope_required')

  const missingServer = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'server',
    }),
  })
  assertEquals(missingServer.status, 400)

  const dockerWithServer = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      serverId: srv!.id,
      options: { dockerNetworkName: 'turbopanel-shared' },
    }),
  })
  assertEquals(dockerWithServer.status, 200)
  const dockerBody = await dockerWithServer.json() as { ok: true; id: string }
  await db.delete(network).where(eq(network.id, dockerBody.id))

  const dockerWithDc = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'docker',
      datacenterId: dc!.id,
      options: { dockerNetworkName: 'turbopanel-shared' },
    }),
  })
  assertEquals(dockerWithDc.status, 400)
  assertEquals((await dockerWithDc.json()).error, 'network_single_scope_conflict')

  const okDc = await app.request('/networks', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      organizationId,
      kind: 'datacenter',
      datacenterId: dc!.id,
    }),
  })
  assertEquals(okDc.status, 200)
  const okDcBody = await okDc.json() as { ok: true; id: string }

  await db.delete(network).where(eq(network.id, okDcBody.id))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('GET /networks returns 403 for org member without organization:manage', async () => {
  if (!dbUrl) {
    console.warn('Skipping network route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerNetworkRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Net List Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `net-list-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request('/networks', {
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })

  assertEquals(res.status, 403)

  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('GET /networks lists networks and applies kind and scope filters', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Filter DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [srv] = await db
      .insert(server)
      .values({ organizationId, name: 'Filter Host', createdAt: now, updatedAt: now })
      .returning({ id: server.id })

    const [dcNet] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.0.0.0/24',
        name: 'DC LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })
    const [dockerNet] = await db
      .insert(network)
      .values({
        organizationId,
        serverId: srv!.id,
        kind: 'docker',
        name: 'Host Docker',
        options: { dockerNetworkName: 'turbopanel-filter' },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = { cookie, [ORG_ID_HEADER]: organizationId }

    const all = await app.request('/networks', { headers })
    assertEquals(all.status, 200)
    const allBody = await all.json() as { networks: Array<{ id: string }> }
    assertEquals(allBody.networks.length, 2)

    const dockerOnly = await app.request('/networks?kind=docker', { headers })
    assertEquals(dockerOnly.status, 200)
    const dockerBody = await dockerOnly.json() as { networks: Array<{ id: string }> }
    assertEquals(dockerBody.networks.map((row) => row.id), [dockerNet!.id])

    const byDc = await app.request(`/networks?datacenterId=${dc!.id}`, { headers })
    assertEquals(byDc.status, 200)
    const dcBody = await byDc.json() as { networks: Array<{ id: string }> }
    assertEquals(dcBody.networks.map((row) => row.id), [dcNet!.id])

    const byServer = await app.request(`/networks?serverId=${srv!.id}`, { headers })
    assertEquals(byServer.status, 200)
    const serverBody = await byServer.json() as { networks: Array<{ id: string }> }
    assertEquals(serverBody.networks.map((row) => row.id), [dockerNet!.id])
  })
})

test('GET /networks returns 404 when datacenterId belongs to another org', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [localDc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Local DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [localNet] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: localDc!.id,
        kind: 'datacenter',
        cidr: '10.9.0.0/24',
        name: 'Local LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Foreign Net Org' })
      .returning({ id: organization.id })
    const [foreignDc] = await db
      .insert(datacenter)
      .values({
        organizationId: otherOrg!.id,
        name: 'Foreign DC',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks?datacenterId=${foreignDc!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 404)

    await db.delete(network).where(eq(network.id, localNet!.id))
    await db.delete(datacenter).where(eq(datacenter.id, localDc!.id))
    await db.delete(datacenter).where(eq(datacenter.id, foreignDc!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

test('GET /networks/:id returns network detail', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Detail DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.1.0.0/24',
        name: 'Detail LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 200)
    const body = await res.json() as {
      network: { id: string; displayName: string; cidr: string; kind: string }
    }
    assertEquals(body.network.id, netRow!.id)
    assertEquals(body.network.displayName, 'Detail LAN')
    assertEquals(body.network.cidr, '10.1.0.0/24')
    assertEquals(body.network.kind, 'datacenter')
  })
})

test('GET /networks/:id returns 404 for network in another org', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Foreign Detail Org' })
      .returning({ id: organization.id })
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({
        organizationId: otherOrg!.id,
        name: 'Foreign Detail DC',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId: otherOrg!.id,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.2.0.0/24',
        name: 'Foreign LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 404)

    await db.delete(network).where(eq(network.id, netRow!.id))
    await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

test('PATCH /networks/:id updates displayName and cidr', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Patch DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.3.0.0/24',
        name: 'Before',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      method: 'PATCH',
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'After', cidr: '10.3.1.0/24' }),
    })
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true })

    const [row] = await db
      .select({ name: network.name, cidr: network.cidr })
      .from(network)
      .where(eq(network.id, netRow!.id))
      .limit(1)
    assertEquals(row?.name, 'After')
    assertEquals(row?.cidr, '10.3.1.0/24')
  })
})

test('PATCH /networks/:id rejects immutable scope fields', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Immutable DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.4.0.0/24',
        name: 'Immutable LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      method: 'PATCH',
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ datacenterId: dc!.id }),
    })
    assertEquals(res.status, 400)
  })
})

test('DELETE /networks/:id removes network', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const now = new Date().toISOString()
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Delete DC', createdAt: now, updatedAt: now })
      .returning({ id: datacenter.id })
    const [netRow] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.5.0.0/24',
        name: 'Delete LAN',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: network.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/networks/${netRow!.id}`, {
      method: 'DELETE',
      headers: { cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true })

    const rows = await db
      .select({ id: network.id })
      .from(network)
      .where(eq(network.id, netRow!.id))
    assertEquals(rows.length, 0)
  })
})

test('POST /networks returns 403 when organizationId is not accessible', async () => {
  await withNetworkFixtures(async ({
    app,
    db,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Inaccessible Net Org' })
      .returning({ id: organization.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/networks', {
      method: 'POST',
      headers: {
        cookie,
        [ORG_ID_HEADER]: otherOrg!.id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: otherOrg!.id,
        kind: 'docker',
        options: { dockerNetworkName: 'foreign-net' },
      }),
    })
    assertEquals(res.status, 403)

    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

test('POST /networks returns 404 when datacenterId belongs to another org', async () => {
  await withNetworkFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Cross Org Net Org' })
      .returning({ id: organization.id })
    const now = new Date().toISOString()
    const [foreignDc] = await db
      .insert(datacenter)
      .values({
        organizationId: otherOrg!.id,
        name: 'Cross Org DC',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datacenter.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/networks', {
      method: 'POST',
      headers: {
        cookie,
        [ORG_ID_HEADER]: organizationId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId,
        kind: 'datacenter',
        datacenterId: foreignDc!.id,
      }),
    })
    assertEquals(res.status, 404)

    await db.delete(datacenter).where(eq(datacenter.id, foreignDc!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})
