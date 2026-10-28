/**
 * Tunnel routes against a real database and a faked provider: create and
 * remove a tunnel, change where it runs, add and remove hostnames with their
 * DNS names, and the rules around them. Skips without TURBOPANEL_DATABASE_URL.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  audit,
  datacenter,
  doorway,
  grant,
  ip,
  network,
  organization,
  portal,
  secret,
  server,
  tunnel,
  user,
} from '../../db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { decryptSecret } from '../../lib/secrets/data-encryption.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { insertBadge, insertCarrier, sealToken } from '../../features/tunnels/records.ts'
import { loadRoutingFacts } from '../../features/tunnels/route-facts.ts'
import { NO_CAPABILITIES } from '../../features/tunnels/vocabulary.ts'
import { registerOrganizationTunnelRoutes } from './tunnel-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>
type Called = { status: number; text: string; body: Record<string, unknown> }

const TOKEN = 'cf-api-token-0123456789abcdefghijklmnopqrstuv'
const RUN_TOKEN = 'run-token-abcdefghijklmnopqrstuvwxyz0123456789'
const ACCOUNT = 'a'.repeat(32)

/** What the faked provider saw and how it answers. */
const provider = {
  calls: [] as string[],
  routeBodies: [] as unknown[],
  failRoutes: false,
  failTunnelCreate: false,
}

const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const refused = (status: number, message: string) =>
  Response.json({ success: false, errors: [{ code: 1, message }] }, { status })

const fakeProvider: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  const path = url.pathname.replace('/client/v4', '')
  const method = init?.method ?? 'GET'
  provider.calls.push(`${method} ${path}`)
  if (path === '/accounts') return ok([{ id: ACCOUNT, name: 'Main' }])
  if (path === `/accounts/${ACCOUNT}/cfd_tunnel` && method === 'POST') {
    if (provider.failTunnelCreate) return refused(500, 'could not create')
    return ok({ id: 'tunnel-ext-1', token: RUN_TOKEN })
  }
  if (path.endsWith('/configurations') && method === 'PUT') {
    if (provider.failRoutes) return refused(500, 'routes failed')
    provider.routeBodies.push(JSON.parse(String(init?.body)))
    return ok({})
  }
  if (path === '/zones')
    return ok([{ id: 'zone-1', name: 'example.com', account: { id: ACCOUNT } }])
  if (path === '/zones/zone-1/dns_records' && method === 'POST') return ok({ id: 'rec-1' })
  if (path === '/zones/zone-1/dns_records/rec-1' && method === 'DELETE') return ok({ id: 'rec-1' })
  if (path === '/zones/zone-1/dns_records') return ok([])
  if (path === `/accounts/${ACCOUNT}/cfd_tunnel/tunnel-ext-1` && method === 'DELETE') return ok({})
  return refused(404, 'not found')
}

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  managerCookie: string
  memberCookie: string
  otherManagerCookie: string
  carrierId: string
  datacenterId: string
  servers: [string, string, string]
  secrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
}

async function insertUser(db: Db, organizationId: string, permission: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({
      email: `tt-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: row!.id,
    permission,
  })
  return row!.id
}

/** A datacenter of three servers, each with one datacenter address. */
async function insertDatacenter(
  db: Db,
  organizationId: string
): Promise<{ datacenterId: string; servers: [string, string, string] }> {
  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, name: 'Tunnel Test DC' })
    .returning({ id: datacenter.id })
  const [net] = await db
    .insert(network)
    .values({
      organizationId,
      datacenterId: dc!.id,
      kind: 'datacenter',
      cidr: '10.93.0.0/24',
      name: 'LAN',
    })
    .returning({ id: network.id })
  const rows = await db
    .insert(server)
    .values([1, 2, 3].map((n) => ({ organizationId, name: `Tunnel Test ${n}` })))
    .returning({ id: server.id })
  const ids = rows.map((r) => r.id) as [string, string, string]
  await db.insert(ip).values(
    ids.map((serverId, index) => ({
      organizationId,
      datacenterId: dc!.id,
      networkId: net!.id,
      serverId,
      address: `10.93.0.${10 + index}`,
      allocation: 'dedicated',
      scope: 'datacenter',
    }))
  )
  return { datacenterId: dc!.id, servers: ids }
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel route tests')
    return
  }
  provider.calls = []
  provider.routeBodies = []
  provider.failRoutes = false
  provider.failTunnelCreate = false
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const sessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const secrets = await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', secrets)
    return next()
  })
  registerOrganizationTunnelRoutes(
    app,
    { secrets: sessionSecrets, runtime: 'deno', signupEnvOverride: undefined },
    fakeProvider
  )
  const orgs = await db
    .insert(organization)
    .values([{ name: 'Tunnel Org A' }, { name: 'Tunnel Org B' }])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]
  const userIds: string[] = []
  try {
    const ids = {
      manager: await insertUser(db, orgA, 'organization:manage'),
      member: await insertUser(db, orgA, 'organization:read'),
      otherManager: await insertUser(db, orgB, 'organization:manage'),
    }
    userIds.push(...Object.values(ids))
    const cookie = async (userId: string) => {
      const { token } = await createSession(db, userId, {})
      return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, sessionSecrets)}`
    }
    const owner = await insertCarrier(db, {
      organizationId: orgA,
      provider: 'cloudflare',
      name: 'Main Account',
      externalAccountId: ACCOUNT,
    })
    await insertBadge(db, {
      organizationId: orgA,
      carrier: owner,
      label: 'Main',
      sealed: await sealToken(secrets, TOKEN),
      lastFour: TOKEN.slice(-4),
      report: {
        accounts: [{ id: ACCOUNT, name: 'Main' }],
        zones: [{ id: 'zone-1', name: 'example.com' }],
        accountVisible: true,
        capabilities: {
          ...NO_CAPABILITIES,
          tunnels: true,
          dns: [{ id: 'zone-1', name: 'example.com' }],
        },
        missing: [],
        token: { kind: 'account', id: 'tok-1', status: 'active', expiresAt: null },
      },
    })
    const dc = await insertDatacenter(db, orgA)
    await fn({
      db,
      app,
      orgA,
      orgB,
      managerCookie: await cookie(ids.manager),
      memberCookie: await cookie(ids.member),
      otherManagerCookie: await cookie(ids.otherManager),
      carrierId: owner.id,
      datacenterId: dc.datacenterId,
      servers: dc.servers,
      secrets,
    })
  } finally {
    const orgIds = [orgA, orgB]
    await db.delete(audit).where(inArray(audit.organizationId, orgIds))
    // An all-servers tunnel blocks its datacenter, and servers hold the organization with
    // RESTRICT; portals and hostnames go with the tunnel.
    await db.delete(tunnel).where(inArray(tunnel.organizationId, orgIds))
    await db.delete(ip).where(inArray(ip.organizationId, orgIds))
    await db.delete(server).where(inArray(server.organizationId, orgIds))
    await db.delete(network).where(inArray(network.organizationId, orgIds))
    await db.delete(datacenter).where(inArray(datacenter.organizationId, orgIds))
    await db.delete(organization).where(inArray(organization.id, orgIds))
    if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds))
    await endDbConnection(db)
  }
}

async function call(
  f: Fixture,
  method: string,
  path: string,
  cookie: string | null,
  body?: unknown
): Promise<Called> {
  const res = await f.app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      [ORG_ID_HEADER]: cookie === f.otherManagerCookie ? f.orgB : f.orgA,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return {
    status: res.status,
    text,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  }
}

async function makeTunnel(f: Fixture, extra: Record<string, unknown> = {}): Promise<string> {
  const made = await call(f, 'POST', `/organizations/${f.orgA}/tunnels`, f.managerCookie, {
    carrierId: f.carrierId,
    name: 'Main Tunnel',
    placement: 'chosen',
    serverIds: [f.servers[0], f.servers[1]],
    ...extra,
  })
  assertEquals(made.status, 201, made.text)
  return (made.body.tunnel as { id: string }).id
}

test('every tunnel route refuses a request without a session', async () => {
  await withFixture(async (f) => {
    const id = crypto.randomUUID()
    for (const [method, path] of [
      ['GET', `/organizations/${f.orgA}/tunnels`],
      ['POST', `/organizations/${f.orgA}/tunnels`],
      ['GET', `/organizations/${f.orgA}/tunnels/${id}`],
      ['PUT', `/organizations/${f.orgA}/tunnels/${id}/placement`],
      ['DELETE', `/organizations/${f.orgA}/tunnels/${id}`],
      ['GET', `/organizations/${f.orgA}/tunnels/${id}/hostnames`],
      ['POST', `/organizations/${f.orgA}/tunnels/${id}/hostnames`],
      ['DELETE', `/organizations/${f.orgA}/tunnels/${id}/hostnames/${id}`],
      ['PUT', `/organizations/${f.orgA}/servers/${id}/tunnel-carrying`],
    ]) {
      assertEquals((await call(f, method!, path!, null, {})).status, 401, `${method} ${path}`)
    }
  })
})

test("a read-only member and another organization's manager are refused", async () => {
  await withFixture(async (f) => {
    for (const cookie of [f.memberCookie, f.otherManagerCookie]) {
      assertEquals((await call(f, 'GET', `/organizations/${f.orgA}/tunnels`, cookie)).status, 403)
      const made = await call(f, 'POST', `/organizations/${f.orgA}/tunnels`, cookie, {
        carrierId: f.carrierId,
        name: 'Nope',
        placement: 'chosen',
        serverIds: [f.servers[0]],
      })
      assertEquals(made.status, 403)
    }
    assertEquals(
      (await f.db.select().from(tunnel).where(eq(tunnel.organizationId, f.orgA))).length,
      0
    )
  })
})

test('a tunnel is created at the provider, its run token is sealed and never returned', async () => {
  await withFixture(async (f) => {
    const made = await call(f, 'POST', `/organizations/${f.orgA}/tunnels`, f.managerCookie, {
      carrierId: f.carrierId,
      name: 'Main Tunnel',
      placement: 'chosen',
      serverIds: [f.servers[0], f.servers[1]],
    })
    assertEquals(made.status, 201, made.text)
    assert(!made.text.includes(RUN_TOKEN))
    const shown = made.body.tunnel as {
      id: string
      carryingServerIds: string[]
      warnings: string[]
    }
    assertEquals(shown.carryingServerIds.length, 2)
    assertEquals(shown.warnings, [])
    const [row] = await f.db.select().from(tunnel).where(eq(tunnel.id, shown.id))
    assertEquals(row!.externalId, 'tunnel-ext-1')
    assertEquals(row!.organizationId, row!.routingOrganizationId)
    const [sealed] = await f.db.select().from(secret).where(eq(secret.id, row!.secretId!))
    assertEquals(sealed!.provider, 'tunnel_run')
    assert(!sealed!.secretEnvelope.includes(RUN_TOKEN))
    assertEquals(await decryptSecret(f.secrets, sealed!.secretEnvelope), RUN_TOKEN)
    assertEquals((await f.db.select().from(portal).where(eq(portal.tunnelId, row!.id))).length, 2)
    // The listing carries no token either.
    const listed = await call(f, 'GET', `/organizations/${f.orgA}/tunnels`, f.managerCookie)
    assert(!listed.text.includes(RUN_TOKEN))
    assertEquals((listed.body.tunnels as unknown[]).length, 1)
  })
})

test('a single connector is warned about, and a duplicate name is refused', async () => {
  await withFixture(async (f) => {
    const made = await call(f, 'POST', `/organizations/${f.orgA}/tunnels`, f.managerCookie, {
      carrierId: f.carrierId,
      name: 'Solo',
      placement: 'one',
      serverIds: [f.servers[0]],
    })
    assertEquals(made.status, 201, made.text)
    assert((made.body.tunnel as { warnings: string[] }).warnings[0]!.includes('Only one server'))
    const again = await call(f, 'POST', `/organizations/${f.orgA}/tunnels`, f.managerCookie, {
      carrierId: f.carrierId,
      name: 'Solo',
      placement: 'one',
      serverIds: [f.servers[1]],
    })
    assertEquals(again.status, 409)
    assertEquals(again.body.error, 'tunnel_exists')
  })
})

test('a failed create at the provider leaves nothing behind', async () => {
  await withFixture(async (f) => {
    provider.failTunnelCreate = true
    const made = await call(f, 'POST', `/organizations/${f.orgA}/tunnels`, f.managerCookie, {
      carrierId: f.carrierId,
      name: 'Broken',
      placement: 'one',
      serverIds: [f.servers[0]],
    })
    assertEquals(made.status, 502)
    assertEquals(
      (await f.db.select().from(tunnel).where(eq(tunnel.organizationId, f.orgA))).length,
      0
    )
  })
})

test('servers of another organization or outside the datacenter are refused', async () => {
  await withFixture(async (f) => {
    const other = await insertDatacenter(f.db, f.orgB)
    const made = await call(f, 'POST', `/organizations/${f.orgA}/tunnels`, f.managerCookie, {
      carrierId: f.carrierId,
      name: 'Cross',
      placement: 'one',
      serverIds: [other.servers[0]],
    })
    assertEquals(made.status, 400)
    assertEquals(made.body.error, 'server_invalid')
    const outside = await call(f, 'POST', `/organizations/${f.orgA}/tunnels`, f.managerCookie, {
      carrierId: f.carrierId,
      name: 'Outside',
      placement: 'all',
      datacenterId: other.datacenterId,
    })
    assertEquals(outside.status, 400)
    assertEquals(outside.body.error, 'datacenter_invalid')
  })
})

test('all covers the datacenter, except the servers left out and servers set to never carry', async () => {
  await withFixture(async (f) => {
    const id = await makeTunnel(f, {
      placement: 'all',
      datacenterId: f.datacenterId,
      serverIds: undefined,
      exceptServerIds: [f.servers[2]],
    })
    const read = async () =>
      (
        (await call(f, 'GET', `/organizations/${f.orgA}/tunnels/${id}`, f.managerCookie)).body
          .tunnel as { carryingServerIds: string[] }
      ).carryingServerIds
    assertEquals((await read()).sort(), [f.servers[0], f.servers[1]].sort())
    const never = await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/servers/${f.servers[1]}/tunnel-carrying`,
      f.managerCookie,
      { carry: false }
    )
    assertEquals(never.status, 200, never.text)
    assertEquals(await read(), [f.servers[0]])
    // A server set to never carry cannot be chosen.
    const chosen = await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/tunnels/${id}/placement`,
      f.managerCookie,
      { placement: 'chosen', serverIds: [f.servers[1]] }
    )
    assertEquals(chosen.status, 409)
    assertEquals(chosen.body.error, 'server_never_carries')
  })
})

test('a hostname gets its route and its DNS name, and removing it takes both away', async () => {
  await withFixture(async (f) => {
    const id = await makeTunnel(f)
    const added = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/tunnels/${id}/hostnames`,
      f.managerCookie,
      { hostname: 'Shop.Example.com' }
    )
    assertEquals(added.status, 201, added.text)
    const shown = added.body.hostname as {
      id: string
      hostname: string
      dns: string
      status: string
    }
    assertEquals(shown.hostname, 'shop.example.com')
    assertEquals(shown.dns, 'created')
    assertEquals(shown.status, 'live')
    assert(provider.calls.includes('POST /zones/zone-1/dns_records'))
    const sent = JSON.stringify(provider.routeBodies.at(-1))
    assert(sent.includes('shop.example.com') && sent.includes('https://localhost'))

    const dup = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/tunnels/${id}/hostnames`,
      f.managerCookie,
      { hostname: 'shop.example.com' }
    )
    assertEquals(dup.status, 409)
    assertEquals(dup.body.error, 'hostname_in_use')

    const refusedDelete = await call(
      f,
      'DELETE',
      `/organizations/${f.orgA}/tunnels/${id}`,
      f.managerCookie
    )
    assertEquals(refusedDelete.status, 409)
    assertEquals(refusedDelete.body.error, 'tunnel_in_use')

    const removed = await call(
      f,
      'DELETE',
      `/organizations/${f.orgA}/tunnels/${id}/hostnames/${shown.id}`,
      f.managerCookie
    )
    assertEquals(removed.status, 200, removed.text)
    assert(provider.calls.includes('DELETE /zones/zone-1/dns_records/rec-1'))
    assertEquals(
      (await f.db.select().from(doorway).where(eq(doorway.routingOrganizationId, f.orgA))).length,
      0
    )

    const gone = await call(f, 'DELETE', `/organizations/${f.orgA}/tunnels/${id}`, f.managerCookie)
    assertEquals(gone.status, 200, gone.text)
    assert(provider.calls.includes('DELETE /accounts/' + ACCOUNT + '/cfd_tunnel/tunnel-ext-1'))
    assertEquals(
      (await f.db.select().from(tunnel).where(eq(tunnel.organizationId, f.orgA))).length,
      0
    )
    assertEquals(
      (await f.db.select().from(secret).where(eq(secret.organizationId, f.orgA))).length,
      1
    )
  })
})

test('a hostname outside every reachable zone is still routed, with no DNS name made', async () => {
  await withFixture(async (f) => {
    const id = await makeTunnel(f)
    const added = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/tunnels/${id}/hostnames`,
      f.managerCookie,
      { hostname: 'shop.elsewhere.org' }
    )
    assertEquals(added.status, 201, added.text)
    assertEquals((added.body.hostname as { dns: string }).dns, 'none')
    assert(!provider.calls.includes('POST /zones/zone-1/dns_records'))
  })
})

test('a failed route change removes the hostname again', async () => {
  await withFixture(async (f) => {
    const id = await makeTunnel(f)
    provider.failRoutes = true
    const added = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/tunnels/${id}/hostnames`,
      f.managerCookie,
      { hostname: 'shop.example.com' }
    )
    assertEquals(added.status, 502)
    assertEquals(
      (await f.db.select().from(doorway).where(eq(doorway.routingOrganizationId, f.orgA))).length,
      0
    )
  })
})

test('a bad hostname and an unknown tunnel are refused', async () => {
  await withFixture(async (f) => {
    const id = await makeTunnel(f)
    const bad = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/tunnels/${id}/hostnames`,
      f.managerCookie,
      { hostname: 'not a host' }
    )
    assertEquals(bad.status, 400)
    const missing = await call(
      f,
      'GET',
      `/organizations/${f.orgA}/tunnels/${crypto.randomUUID()}`,
      f.managerCookie
    )
    assertEquals(missing.status, 404)
  })
})

test('the placement can be changed, and the route facts carry exact datacenter addresses', async () => {
  await withFixture(async (f) => {
    const id = await makeTunnel(f)
    await call(f, 'POST', `/organizations/${f.orgA}/tunnels/${id}/hostnames`, f.managerCookie, {
      hostname: 'shop.example.com',
    })
    const moved = await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/tunnels/${id}/placement`,
      f.managerCookie,
      { placement: 'one', serverIds: [f.servers[2]] }
    )
    assertEquals(moved.status, 200, moved.text)
    assertEquals((moved.body.tunnel as { carryingServerIds: string[] }).carryingServerIds, [
      f.servers[2],
    ])
    const facts = await loadRoutingFacts(f.db, f.orgA)
    assertEquals(facts.tunnels.length, 1)
    assertEquals(facts.tunnels[0]!.carrying, [f.servers[2]])
    // The site is not deployed anywhere yet, so the name has no server to forward to.
    assertEquals(facts.tunnels[0]!.doorways, [
      { hostname: 'shop.example.com', siteServerIds: [], isLocalOnly: true },
    ])
    assertEquals(facts.addresses.get(f.servers[2]), ['10.93.0.12'])
    const bad = await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/tunnels/${id}/placement`,
      f.managerCookie,
      { placement: 'one', serverIds: [f.servers[0], f.servers[1]] }
    )
    assertEquals(bad.status, 400)
  })
})
