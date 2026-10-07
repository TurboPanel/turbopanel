import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import {
  datacenter,
  environment,
  grant,
  hosting,
  hostname,
  ip,
  network,
  organization,
  project,
  server,
  service,
  user,
  workspace,
} from '../../db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerHostingRoutes } from './routes.ts'
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
  userId: string
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

test('PATCH /hostings rejects public bind with non-public ip scope', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('hosting route tests')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerHostingRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Hosting IP Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({
      email: `host-ip-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: ws!.id, organizationId, name: 'P', createdAt: now, updatedAt: now })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'E', createdAt: now, updatedAt: now })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({
      environmentId: env!.id,
      name: 's',
      composeServiceName: 's',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })

  const [privateServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Private bind server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })

  const [privateDc] = await db
    .insert(datacenter)
    .values({
      organizationId,
      name: 'Private DC',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: datacenter.id })
  const [privateNet] = await db
    .insert(network)
    .values({
      organizationId,
      datacenterId: privateDc!.id,
      kind: 'datacenter',
      cidr: '10.0.0.0/24',
      name: 'Private LAN',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: network.id })

  const [privateIp] = await db
    .insert(ip)
    .values({
      organizationId,
      datacenterId: privateDc!.id,
      networkId: privateNet!.id,
      serverId: privateServer!.id,
      address: '10.0.0.1',
      allocation: 'dedicated',
      scope: 'datacenter',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: ip.id })

  const [host] = await db
    .insert(hosting)
    .values({
      serviceId: svc!.id,
      name: 'Site',
      options: { bind: 'public' },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request(`/hostings/${host!.id}`, {
    method: 'PATCH',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ipId: privateIp!.id }),
  })

  assertEquals(res.status, 400)
  const body = (await res.json()) as { error: string }
  assertEquals(body.error, 'hosting_bind_scope_mismatch')

  await db.delete(hosting).where(eq(hosting.id, host!.id))
  await db.delete(ip).where(eq(ip.id, privateIp!.id))
  await db.delete(network).where(eq(network.id, privateNet!.id))
  await db.delete(datacenter).where(eq(datacenter.id, privateDc!.id))
  await db.delete(server).where(eq(server.id, privateServer!.id))
  await db.delete(service).where(eq(service.id, svc!.id))
  await db.delete(environment).where(eq(environment.id, env!.id))
  await db.delete(project).where(eq(project.id, proj!.id))
  await db.delete(workspace).where(eq(workspace.id, ws!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('PATCH /hostings returns 404 when ipId belongs to another org', async () => {
  if (!dbUrl) return

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerHostingRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Host Org A' })
    .returning({ id: organization.id })
  const [orgB] = await db
    .insert(organization)
    .values({ name: 'Host Org B' })
    .returning({ id: organization.id })

  const [u] = await db
    .insert(user)
    .values({
      email: `host-xorg-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: orgA!.id,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [ws] = await db
    .insert(workspace)
    .values({
      organizationId: orgA!.id,
      name: 'WS',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      workspaceId: ws!.id,
      organizationId: orgA!.id,
      name: 'P',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'E', createdAt: now, updatedAt: now })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({
      environmentId: env!.id,
      name: 's',
      composeServiceName: 's',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })

  const [host] = await db
    .insert(hosting)
    .values({
      serviceId: svc!.id,
      name: 'Site',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })

  const [foreignIp] = await db
    .insert(ip)
    .values({
      organizationId: orgB!.id,
      address: '203.0.113.55',
      allocation: 'dedicated',
      scope: 'public',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: ip.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request(`/hostings/${host!.id}`, {
    method: 'PATCH',
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ipId: foreignIp!.id }),
  })

  assertEquals(res.status, 404)

  await db.delete(hosting).where(eq(hosting.id, host!.id))
  await db.delete(ip).where(eq(ip.id, foreignIp!.id))
  await db.delete(service).where(eq(service.id, svc!.id))
  await db.delete(environment).where(eq(environment.id, env!.id))
  await db.delete(project).where(eq(project.id, proj!.id))
  await db.delete(workspace).where(eq(workspace.id, ws!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, orgA!.id))
  await db.delete(organization).where(eq(organization.id, orgB!.id))
})

async function createHostingTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerHostingRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, secrets }
}

async function withHostingFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    serviceId: string
    serverId: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) return

  const db = createDenoDb()
  const { app, secrets } = await createHostingTestApp(db)

  const [orgRow] = await db
    .insert(organization)
    .values({ name: 'Hosting CRUD Org' })
    .returning({ id: organization.id })
  const organizationId = orgRow!.id

  const [userRow] = await db
    .insert(user)
    .values({
      email: `host-crud-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
    })
    .returning({ id: user.id })
  const userId = userRow!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const now = new Date().toISOString()
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: ws!.id, organizationId, name: 'P', createdAt: now, updatedAt: now })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'E', createdAt: now, updatedAt: now })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({
      environmentId: env!.id,
      name: 'web',
      composeServiceName: 'web',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })
  const serviceId = svc!.id

  const [srv] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Host Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = srv!.id

  try {
    await fn({ db, app, secrets, userId, organizationId, serviceId, serverId })
  } finally {
    await db.delete(hosting).where(eq(hosting.serviceId, serviceId))
    await db.delete(ip).where(eq(ip.organizationId, organizationId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(eq(grant.actorId, userId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('hosting CRUD covers list, filter, create, patch, and delete', async () => {
  await withHostingFixtures(
    async ({ app, secrets, db, userId, organizationId, serviceId, serverId }) => {
      const cookie = await sessionCookie(db, secrets, userId)
      const headers = {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      }

      const empty = await app.request('/hostings', {
        headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
      })
      assertEquals(empty.status, 200)
      const emptyBody = (await empty.json()) as { hostings: unknown[] }
      assertEquals(emptyBody.hostings.length, 0)

      const now = new Date().toISOString()
      const [publicIp] = await db
        .insert(ip)
        .values({
          organizationId,
          serverId,
          address: '203.0.113.10',
          allocation: 'dedicated',
          scope: 'public',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: ip.id })

      const create = await app.request('/hostings', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          serviceId,
          name: 'Primary Site',
          description: 'Main entrypoint',
          options: {
            bind: 'public',
            hostnames: ['app.example.test'],
          },
          ipId: publicIp!.id,
        }),
      })
      assertEquals(create.status, 200)
      const { id: hostingId } = (await create.json()) as { ok: true; id: string }

      const list = await app.request('/hostings', {
        headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
      })
      assertEquals(list.status, 200)
      const listBody = (await list.json()) as {
        hostings: Array<{ id: string; name: string | null }>
      }
      assertEquals(listBody.hostings.length, 1)
      assertEquals(listBody.hostings[0]?.name, 'Primary Site')

      const filtered = await app.request(`/hostings?serviceId=${serviceId}`, {
        headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
      })
      assertEquals(filtered.status, 200)
      const filteredBody = (await filtered.json()) as {
        hostings: Array<{ id: string }>
      }
      assertEquals(filteredBody.hostings.length, 1)
      assertEquals(filteredBody.hostings[0]?.id, hostingId)

      const detail = await app.request(`/hostings/${hostingId}`, {
        headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
      })
      assertEquals(detail.status, 200)
      const detailBody = (await detail.json()) as {
        hosting: {
          id: string
          name: string | null
          description: string | null
        }
      }
      assertEquals(detailBody.hosting.id, hostingId)
      assertEquals(detailBody.hosting.description, 'Main entrypoint')

      const patch = await app.request(`/hostings/${hostingId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          name: 'Renamed Site',
          options: { bind: 'datacenter' },
          ipId: null,
        }),
      })
      assertEquals(patch.status, 200)

      const del = await app.request(`/hostings/${hostingId}`, {
        method: 'DELETE',
        headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
      })
      assertEquals(del.status, 200)
    }
  )
})

type HostingCall = (method: string, path: string, body: unknown) => Promise<Response>

function hostingCaller(app: Hono<AppEnv>, cookie: string, organizationId: string): HostingCall {
  return async (method, path, body) =>
    await app.request(path, {
      method,
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
}

async function createHostingId(call: HostingCall, serviceId: string, options: unknown) {
  const res = await call('POST', '/hostings', { serviceId, name: 'Site', options })
  assertEquals(res.status, 200)
  return ((await res.json()) as { id: string }).id
}

async function hostnameRows(db: ReturnType<typeof createDenoDb>, hostingId: string) {
  const rows = await db
    .select({ hostname: hostname.hostname })
    .from(hostname)
    .where(eq(hostname.hostingId, hostingId))
  return rows.map((row) => row.hostname).sort((a, b) => a.localeCompare(b))
}

test("POST /hostings refuses a typed name another hosting's www choice already answers on", async () => {
  await withHostingFixtures(async ({ app, secrets, db, userId, organizationId, serviceId }) => {
    const call = hostingCaller(app, await sessionCookie(db, secrets, userId), organizationId)
    const a = await createHostingId(call, serviceId, { hostnames: ['example.com'], www: 'both' })
    assertEquals(await hostnameRows(db, a), ['example.com', 'www.example.com'])

    const b = await call('POST', '/hostings', {
      serviceId,
      name: 'Other',
      options: { hostnames: ['www.example.com'] },
    })
    assertEquals(b.status, 409)
    assertEquals(await b.json(), { error: 'hostname_in_use' })

    // A redirect-only spelling is claimed too.
    const redirectOnly = await createHostingId(call, serviceId, {
      hostnames: ['shop.example.com'],
      www: 'www-to-root',
    })
    assertEquals(await hostnameRows(db, redirectOnly), ['shop.example.com', 'www.shop.example.com'])
    const clash = await call('POST', '/hostings', {
      serviceId,
      name: 'Other',
      options: { hostnames: ['www.shop.example.com'] },
    })
    assertEquals(clash.status, 409)
    assertEquals(await clash.json(), { error: 'hostname_in_use' })
  })
})

test('PATCH /hostings refuses a www choice that adds a name another hosting typed, and off frees it', async () => {
  await withHostingFixtures(async ({ app, secrets, db, userId, organizationId, serviceId }) => {
    const call = hostingCaller(app, await sessionCookie(db, secrets, userId), organizationId)
    const b = await createHostingId(call, serviceId, { hostnames: ['www.example.com'] })
    const a = await createHostingId(call, serviceId, { hostnames: ['example.com'] })

    const refused = await call('PATCH', `/hostings/${a}`, {
      options: { hostnames: ['example.com'], www: 'root-to-www' },
    })
    assertEquals(refused.status, 409)
    assertEquals(await refused.json(), { error: 'hostname_in_use' })
    // The refused write left both hostings as they were.
    assertEquals(await hostnameRows(db, a), ['example.com'])
    const [unchanged] = await db
      .select({ options: hosting.options })
      .from(hosting)
      .where(eq(hosting.id, a))
    assertEquals(unchanged?.options, { hostnames: ['example.com'] })

    // Free the name, let A take it with its www choice, then turn it off again.
    await db.delete(hosting).where(eq(hosting.id, b))
    const taken = await call('PATCH', `/hostings/${a}`, {
      options: { hostnames: ['example.com'], www: 'root-to-www' },
    })
    assertEquals(taken.status, 200)
    assertEquals(await hostnameRows(db, a), ['example.com', 'www.example.com'])
    const blocked = await call('POST', '/hostings', {
      serviceId,
      name: 'Other',
      options: { hostnames: ['www.example.com'] },
    })
    assertEquals(blocked.status, 409)

    const off = await call('PATCH', `/hostings/${a}`, {
      options: { hostnames: ['example.com'], www: 'off' },
    })
    assertEquals(off.status, 200)
    assertEquals(await hostnameRows(db, a), ['example.com'])
    const saved = await createHostingId(call, serviceId, { hostnames: ['www.example.com'] })
    assertEquals(await hostnameRows(db, saved), ['www.example.com'])
  })
})

test('PATCH /hostings: turning www off frees the added name for a hosting that already exists', async () => {
  await withHostingFixtures(async ({ app, secrets, db, userId, organizationId, serviceId }) => {
    const call = hostingCaller(app, await sessionCookie(db, secrets, userId), organizationId)
    const a = await createHostingId(call, serviceId, { hostnames: ['example.com'], www: 'both' })
    const b = await createHostingId(call, serviceId, { hostnames: ['other.example.com'] })

    const typed = { options: { hostnames: ['www.example.com'] } }
    const before = await call('PATCH', `/hostings/${b}`, typed)
    assertEquals(before.status, 409)
    assertEquals(await before.json(), { error: 'hostname_in_use' })

    const off = await call('PATCH', `/hostings/${a}`, { options: { hostnames: ['example.com'] } })
    assertEquals(off.status, 200)
    const after = await call('PATCH', `/hostings/${b}`, typed)
    assertEquals(after.status, 200)
    assertEquals(await hostnameRows(db, b), ['www.example.com'])
  })
})

test('POST /hostings accepts tcp protocol with port mappings', async () => {
  await withHostingFixtures(async ({ app, secrets, db, userId, organizationId, serviceId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/hostings', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceId,
        name: 'Postgres Proxy',
        options: {
          protocol: 'tcp',
          bind: 'local',
          ports: [{ published: 5432, target: 5432 }],
        },
      }),
    })
    assertEquals(res.status, 200)
    const { id } = (await res.json()) as { ok: true; id: string }

    const detail = await app.request(`/hostings/${id}`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(detail.status, 200)
    const body = (await detail.json()) as {
      hosting: {
        options: {
          protocol?: string
          ports?: Array<{ published: number; target: number }>
        }
      }
    }
    assertEquals(body.hosting.options.protocol, 'tcp')
    assertEquals(body.hosting.options.ports?.[0]?.published, 5432)

    await db.delete(hosting).where(eq(hosting.id, id))
  })
})

test('POST /hostings strips client-supplied compose-ownership markers', async () => {
  await withHostingFixtures(async ({ app, secrets, db, userId, organizationId, serviceId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/hostings', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceId,
        name: 'Forged Compose Owner',
        metadata: {
          composeOwned: true,
          composeServiceName: 'web',
          composeRoute: 'forged/route',
          note: 'kept',
        },
      }),
    })
    assertEquals(res.status, 200)
    const { id } = (await res.json()) as { ok: true; id: string }

    const [row] = await db
      .select({ metadata: hosting.metadata })
      .from(hosting)
      .where(eq(hosting.id, id))
      .limit(1)
    const metadata = row?.metadata as Record<string, unknown> | null
    assertEquals(metadata?.composeOwned, undefined)
    assertEquals(metadata?.composeServiceName, undefined)
    assertEquals(metadata?.composeRoute, undefined)
    assertEquals(metadata?.note, 'kept')

    await db.delete(hosting).where(eq(hosting.id, id))
  })
})

test('POST /hostings returns 400 without serviceId', async () => {
  await withHostingFixtures(async ({ app, secrets, db, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/hostings', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Missing Service' }),
    })
    assertEquals(res.status, 400)
  })
})

test('POST /hostings returns 404 when service belongs to another org', async () => {
  await withHostingFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const now = new Date().toISOString()
    const [foreignOrg] = await db
      .insert(organization)
      .values({ name: 'Foreign Hosting Org' })
      .returning({ id: organization.id })
    const [foreignWs] = await db
      .insert(workspace)
      .values({
        organizationId: foreignOrg!.id,
        name: 'FW',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: workspace.id })
    const [foreignProj] = await db
      .insert(project)
      .values({
        workspaceId: foreignWs!.id,
        organizationId: foreignOrg!.id,
        name: 'FP',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: project.id })
    const [foreignEnv] = await db
      .insert(environment)
      .values({
        projectId: foreignProj!.id,
        name: 'FE',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: environment.id })
    const [foreignSvc] = await db
      .insert(service)
      .values({
        environmentId: foreignEnv!.id,
        name: 'foreign',
        composeServiceName: 'foreign',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: service.id })

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request('/hostings', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          serviceId: foreignSvc!.id,
          name: 'Foreign',
        }),
      })
      assertEquals(res.status, 404)
    } finally {
      await db.delete(service).where(eq(service.id, foreignSvc!.id))
      await db.delete(environment).where(eq(environment.id, foreignEnv!.id))
      await db.delete(project).where(eq(project.id, foreignProj!.id))
      await db.delete(workspace).where(eq(workspace.id, foreignWs!.id))
      await db.delete(organization).where(eq(organization.id, foreignOrg!.id))
    }
  })
})

test('GET /hostings/:id returns 404 for a hosting in another org', async () => {
  await withHostingFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const now = new Date().toISOString()
    const [foreignOrg] = await db
      .insert(organization)
      .values({ name: 'Foreign Hosting Detail Org' })
      .returning({ id: organization.id })
    const [foreignWs] = await db
      .insert(workspace)
      .values({
        organizationId: foreignOrg!.id,
        name: 'FW',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: workspace.id })
    const [foreignProj] = await db
      .insert(project)
      .values({
        workspaceId: foreignWs!.id,
        organizationId: foreignOrg!.id,
        name: 'FP',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: project.id })
    const [foreignEnv] = await db
      .insert(environment)
      .values({
        projectId: foreignProj!.id,
        name: 'FE',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: environment.id })
    const [foreignSvc] = await db
      .insert(service)
      .values({
        environmentId: foreignEnv!.id,
        name: 'foreign',
        composeServiceName: 'foreign',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: service.id })
    const [foreignHost] = await db
      .insert(hosting)
      .values({
        serviceId: foreignSvc!.id,
        name: 'Foreign Site',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: hosting.id })

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/hostings/${foreignHost!.id}`, {
        headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
      })
      assertEquals(res.status, 404)
    } finally {
      await db.delete(hosting).where(eq(hosting.id, foreignHost!.id))
      await db.delete(service).where(eq(service.id, foreignSvc!.id))
      await db.delete(environment).where(eq(environment.id, foreignEnv!.id))
      await db.delete(project).where(eq(project.id, foreignProj!.id))
      await db.delete(workspace).where(eq(workspace.id, foreignWs!.id))
      await db.delete(organization).where(eq(organization.id, foreignOrg!.id))
    }
  })
})

test('POST /hostings returns 400 for malformed tlsId', async () => {
  await withHostingFixtures(async ({ app, secrets, db, userId, organizationId, serviceId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/hostings', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceId,
        name: 'Bad TLS',
        tlsId: 'not-a-valid-uuid',
      }),
    })
    assertEquals(res.status, 400)
    const body = (await res.json()) as { error: string }
    assertEquals(body.error, 'Invalid request')
  })
})

test('PATCH /hostings returns 403 for a member without manage grants', async () => {
  await withHostingFixtures(async ({ db, app, secrets, organizationId, serviceId }) => {
    const [viewer] = await db
      .insert(user)
      .values({
        email: `host-viewer-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
      })
      .returning({ id: user.id })
    const viewerId = viewer!.id

    const now = new Date().toISOString()
    const [host] = await db
      .insert(hosting)
      .values({
        serviceId,
        name: 'Locked Site',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: hosting.id })

    try {
      const cookie = await sessionCookie(db, secrets, viewerId)
      const res = await app.request(`/hostings/${host!.id}`, {
        method: 'PATCH',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Nope' }),
      })
      assertEquals(res.status, 403)
    } finally {
      await db.delete(hosting).where(eq(hosting.id, host!.id))
      await db.delete(user).where(eq(user.id, viewerId))
    }
  })
})
