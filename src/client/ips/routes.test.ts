import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
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
  hosting,
  ip,
  membership,
  network,
  organization,
  peer,
  server,
  service,
  environment,
  project,
  vpn,
  workspace,
  user,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerIpRoutes } from './routes.ts'
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

test('DELETE /ips returns 409 when hosting references ipId', async () => {
  if (!dbUrl) {
    console.warn('Skipping ip route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerIpRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'IP Test Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `ip-test-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const now = new Date().toISOString()
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: ws!.id, name: 'P', createdAt: now, updatedAt: now })
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

  const [ipRow] = await db
    .insert(ip)
    .values({
      organizationId,
      address: '203.0.113.10',
      allocation: 'dedicated',
      scope: 'public',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: ip.id })

  const [host] = await db
    .insert(hosting)
    .values({
      serviceId: svc!.id,
      ipId: ipRow!.id,
      name: 'H',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request(`/ips/${ipRow!.id}`, {
    method: 'DELETE',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })

  assertEquals(res.status, 409)
  const body = await res.json()
  assertEquals(body.error, 'ip_in_use')

  await db.delete(hosting).where(eq(hosting.id, host!.id))
  await db.delete(ip).where(eq(ip.id, ipRow!.id))
  await db.delete(service).where(eq(service.id, svc!.id))
  await db.delete(environment).where(eq(environment.id, env!.id))
  await db.delete(project).where(eq(project.id, proj!.id))
  await db.delete(workspace).where(eq(workspace.id, ws!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('GET /ips returns 403 for org member without organization:manage', async () => {
  if (!dbUrl) {
    console.warn('Skipping ip route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerIpRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'IP List Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `ip-list-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request('/ips', {
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

test('POST /ips derives version and supports VPN-scoped addresses across meshes', async () => {
  if (!dbUrl) {
    console.warn('Skipping ip route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerIpRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'IP VPN Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `ip-vpn-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const [vpnA] = await db
    .insert(vpn)
    .values({ organizationId, cidr: '10.0.0.0/24', name: 'A' })
    .returning({ id: vpn.id })
  const [vpnB] = await db
    .insert(vpn)
    .values({ organizationId, cidr: '10.0.1.0/24', name: 'B' })
    .returning({ id: vpn.id })

  const cookie = await sessionCookie(db, secrets, userId)

  const versionRejected = await app.request('/ips', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '203.0.113.50',
      version: 4,
      allocation: 'dedicated',
      scope: 'public',
    }),
  })
  assertEquals(versionRejected.status, 400)

  const publicCreate = await app.request('/ips', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '203.0.113.50',
      allocation: 'dedicated',
      scope: 'public',
    }),
  })
  assertEquals(publicCreate.status, 200)
  const publicBody = await publicCreate.json() as { ok: true; id: string }

  const publicGet = await app.request(`/ips/${publicBody.id}`, {
    headers: { cookie, [ORG_ID_HEADER]: organizationId },
  })
  assertEquals(publicGet.status, 200)
  const publicRow = await publicGet.json() as { ip: { version: number; vpnId: string | null } }
  assertEquals(publicRow.ip.version, 4)
  assertEquals(publicRow.ip.vpnId, null)

  const overlayA = await app.request('/ips', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '10.0.0.10',
      allocation: 'dedicated',
      scope: 'vpn',
      vpnId: vpnA!.id,
    }),
  })
  assertEquals(overlayA.status, 200)
  const overlayABody = await overlayA.json() as { ok: true; id: string }

  // A distinct address (within vpnB's own CIDR) is allowed on a different
  // VPN — same-org VPN CIDRs are unique (`uniq_vpn_organization_id_cidr`),
  // so overlay address spaces never overlap for same-org meshes.
  const overlayB = await app.request('/ips', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '10.0.1.10',
      allocation: 'dedicated',
      scope: 'vpn',
      vpnId: vpnB!.id,
    }),
  })
  assertEquals(overlayB.status, 200)
  const overlayBBody = await overlayB.json() as { ok: true; id: string }

  const filtered = await app.request(`/ips?vpnId=${vpnA!.id}`, {
    headers: { cookie, [ORG_ID_HEADER]: organizationId },
  })
  assertEquals(filtered.status, 200)
  const filteredBody = await filtered.json() as {
    ips: Array<{ id: string; vpnId: string | null; version: number }>
  }
  assertEquals(filteredBody.ips.length, 1)
  assertEquals(filteredBody.ips[0]?.id, overlayABody.id)
  assertEquals(filteredBody.ips[0]?.vpnId, vpnA!.id)
  assertEquals(filteredBody.ips[0]?.version, 4)

  await db.delete(ip).where(eq(ip.id, publicBody.id))
  await db.delete(ip).where(eq(ip.id, overlayABody.id))
  await db.delete(ip).where(eq(ip.id, overlayBBody.id))
  await db.delete(vpn).where(eq(vpn.id, vpnA!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnB!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('DELETE /ips returns 409 when peer.tunnel_ip_id references the IP', async () => {
  if (!dbUrl) {
    console.warn('Skipping ip route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerIpRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'IP Peer Ref Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({
      email: `ip-peer-ref-${crypto.randomUUID()}@example.com`,
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
    allow: true,
  })

  const [vpnRow] = await db
    .insert(vpn)
    .values({ organizationId, cidr: '10.66.0.0/24', name: 'Mesh' })
    .returning({ id: vpn.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'PeerHost' })
    .returning({ id: server.id })
  const [tunnel] = await db
    .insert(ip)
    .values({
      organizationId,
      vpnId: vpnRow!.id,
      serverId: srv!.id,
      address: '10.66.0.10',
      allocation: 'dedicated',
      scope: 'vpn',
    })
    .returning({ id: ip.id })
  const [peerRow] = await db
    .insert(peer)
    .values({
      vpnId: vpnRow!.id,
      serverId: srv!.id,
      tunnelIpId: tunnel!.id,
      publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      role: 'member',
    })
    .returning({ id: peer.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request(`/ips/${tunnel!.id}`, {
    method: 'DELETE',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })
  assertEquals(res.status, 409)
  assertEquals((await res.json() as { error: string }).error, 'ip_in_use')

  await db.delete(peer).where(eq(peer.id, peerRow!.id))
  await db.delete(ip).where(eq(ip.id, tunnel!.id))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('POST /ips rejects a scope=vpn address outside the vpn cidr', async () => {
  if (!dbUrl) {
    console.warn('Skipping ip route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerIpRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'IP VPN CIDR Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `ip-vpn-cidr-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const [vpnRow] = await db
    .insert(vpn)
    .values({ organizationId, cidr: '10.77.0.0/24', name: 'CidrMesh' })
    .returning({ id: vpn.id })

  const cookie = await sessionCookie(db, secrets, userId)

  const outOfCidr = await app.request('/ips', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '10.77.1.10',
      allocation: 'dedicated',
      scope: 'vpn',
      vpnId: vpnRow!.id,
    }),
  })
  assertEquals(outOfCidr.status, 400)

  const inCidr = await app.request('/ips', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '10.77.0.10',
      allocation: 'dedicated',
      scope: 'vpn',
      vpnId: vpnRow!.id,
    }),
  })
  assertEquals(inCidr.status, 200)
  const inCidrBody = await inCidr.json() as { ok: true; id: string }

  await db.delete(ip).where(eq(ip.id, inCidrBody.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('PATCH /ips/:id rejects reassigning a scope=vpn address to a vpn whose cidr excludes it', async () => {
  if (!dbUrl) {
    console.warn('Skipping ip route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerIpRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'IP VPN Patch CIDR Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `ip-vpn-patch-cidr-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const [vpnA] = await db
    .insert(vpn)
    .values({ organizationId, cidr: '10.88.0.0/24', name: 'PatchMeshA' })
    .returning({ id: vpn.id })
  const [vpnB] = await db
    .insert(vpn)
    .values({ organizationId, cidr: '10.88.1.0/24', name: 'PatchMeshB' })
    .returning({ id: vpn.id })

  const [overlayIp] = await db
    .insert(ip)
    .values({
      organizationId,
      vpnId: vpnA!.id,
      address: '10.88.0.10',
      allocation: 'dedicated',
      scope: 'vpn',
    })
    .returning({ id: ip.id })

  const cookie = await sessionCookie(db, secrets, userId)

  // vpnB's cidr (10.88.1.0/24) excludes the existing address (10.88.0.10).
  const reassignOutOfCidr = await app.request(`/ips/${overlayIp!.id}`, {
    method: 'PATCH',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ vpnId: vpnB!.id }),
  })
  assertEquals(reassignOutOfCidr.status, 400)

  const [unchanged] = await db
    .select({ vpnId: ip.vpnId })
    .from(ip)
    .where(eq(ip.id, overlayIp!.id))
    .limit(1)
  assertEquals(unchanged?.vpnId, vpnA!.id)

  await db.delete(ip).where(eq(ip.id, overlayIp!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnA!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnB!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('POST /ips rejects datacenterId together with networkId', async () => {
  if (!dbUrl) {
    console.warn('Skipping ip route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerIpRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'IP DC Network Create Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({
      email: `ip-dc-net-create-${crypto.randomUUID()}@example.com`,
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
    allow: true,
  })

  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, name: 'DC' })
    .returning({ id: datacenter.id })
  const [net] = await db
    .insert(network)
    .values({
      organizationId,
      datacenterId: dc!.id,
      kind: 'datacenter',
      cidr: '10.40.0.0/16',
      name: 'DC LAN',
    })
    .returning({ id: network.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request('/ips', {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '203.0.113.80',
      allocation: 'dedicated',
      scope: 'public',
      datacenterId: dc!.id,
      networkId: net!.id,
    }),
  })
  assertEquals(res.status, 400)

  await db.delete(network).where(eq(network.id, net!.id))
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('PATCH /ips/:id rejects datacenterId when the row already has networkId', async () => {
  if (!dbUrl) {
    console.warn('Skipping ip route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerIpRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'IP DC Network Patch Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({
      email: `ip-dc-net-patch-${crypto.randomUUID()}@example.com`,
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
    allow: true,
  })

  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId, name: 'DC' })
    .returning({ id: datacenter.id })
  const [net] = await db
    .insert(network)
    .values({
      organizationId,
      datacenterId: dc!.id,
      kind: 'datacenter',
      cidr: '10.41.0.0/16',
      name: 'DC LAN',
    })
    .returning({ id: network.id })

  const [existingIp] = await db
    .insert(ip)
    .values({
      organizationId,
      networkId: net!.id,
      address: '203.0.113.81',
      allocation: 'dedicated',
      scope: 'public',
    })
    .returning({ id: ip.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request(`/ips/${existingIp!.id}`, {
    method: 'PATCH',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ datacenterId: dc!.id }),
  })
  assertEquals(res.status, 400)

  const [unchanged] = await db
    .select({ datacenterId: ip.datacenterId, networkId: ip.networkId })
    .from(ip)
    .where(eq(ip.id, existingIp!.id))
    .limit(1)
  assertEquals(unchanged?.datacenterId, null)
  assertEquals(unchanged?.networkId, net!.id)

  await db.delete(ip).where(eq(ip.id, existingIp!.id))
  await db.delete(network).where(eq(network.id, net!.id))
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('PATCH /ips/:id rejects vpnId: null when scope is vpn', async () => {
  if (!dbUrl) {
    console.warn('Skipping ip route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerIpRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ name: 'IP VPN Clear Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `ip-vpn-clear-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const [vpnRow] = await db
    .insert(vpn)
    .values({ organizationId, cidr: '10.88.2.0/24', name: 'ClearMesh' })
    .returning({ id: vpn.id })

  const [overlayIp] = await db
    .insert(ip)
    .values({
      organizationId,
      vpnId: vpnRow!.id,
      address: '10.88.2.10',
      allocation: 'dedicated',
      scope: 'vpn',
    })
    .returning({ id: ip.id })

  const cookie = await sessionCookie(db, secrets, userId)

  const clearVpnId = await app.request(`/ips/${overlayIp!.id}`, {
    method: 'PATCH',
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ vpnId: null }),
  })
  assertEquals(clearVpnId.status, 400)

  const [unchanged] = await db
    .select({ vpnId: ip.vpnId })
    .from(ip)
    .where(eq(ip.id, overlayIp!.id))
    .limit(1)
  assertEquals(unchanged?.vpnId, vpnRow!.id)

  await db.delete(ip).where(eq(ip.id, overlayIp!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(membership).where(eq(membership.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})
