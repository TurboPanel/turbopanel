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
  ip,
  member,
  network,
  organization,
  peer,
  server,
  vpn,
  user,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerVpnRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'

const WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

function createRecordingCommandQueue(): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: async (envelope) => {
      envelopes.push(envelope)
    },
  }
}

function createStubRegistry(): DaemonCellRegistry {
  return {
    getCell: () => ({
      enqueueOutbound: async () => {},
      waitForRequest: async () => null,
    }),
  } as unknown as DaemonCellRegistry
}

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('POST /vpns stores cidr directly on the vpn row', async () => {
  if (!dbUrl) {
    console.warn('Skipping vpn route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerVpnRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ displayName: 'Mesh CIDR Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `vpn-mesh-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const cookie = await sessionCookie(db, secrets, userId)
  const cidr = '203.0.113.0/24'

  const res = await app.request('/vpns', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ displayName: 'East mesh', cidr }),
  })

  assertEquals(res.status, 200)
  const body = await res.json() as { ok: boolean; id: string; networkId?: string }
  assertEquals(body.ok, true)
  assertEquals(typeof body.id, 'string')
  assertEquals(body.networkId, undefined)

  const [vpnRow] = await db
    .select({ cidr: vpn.cidr })
    .from(vpn)
    .where(eq(vpn.id, body.id))
    .limit(1)
  assertEquals(vpnRow?.cidr, cidr)

  const getRes = await app.request(`/vpns/${body.id}`, {
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })
  assertEquals(getRes.status, 200)
  const getBody = await getRes.json() as { vpn: { cidr: string } }
  assertEquals(getBody.vpn.cidr, cidr)

  await db.delete(vpn).where(eq(vpn.id, body.id))
  await db.delete(grant).where(eq(grant.entityId, organizationId))
  await db.delete(member).where(eq(member.organizationId, organizationId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

test('GET /vpns/:id/peers never returns presharedKey', async () => {
  if (!dbUrl) {
    console.warn('Skipping vpn route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerVpnRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ displayName: 'VPN Test Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `vpn-test-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const now = new Date().toISOString()
  const [vpnRow] = await db
    .insert(vpn)
    .values({ organizationId, cidr: '203.0.113.0/24', displayName: 'Mesh', createdAt: now, updatedAt: now })
    .returning({ id: vpn.id })

  const [srv] = await db
    .insert(server)
    .values({ organizationId, displayName: 'PeerHost', createdAt: now, updatedAt: now })
    .returning({ id: server.id })

  const secretMarker = `secret-marker-${crypto.randomUUID()}`
  const [peerRow] = await db
    .insert(peer)
    .values({
      vpnId: vpnRow!.id,
      serverId: srv!.id,
      publicKey: 'test-public-key',
      presharedKey: secretMarker,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: peer.id })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request(`/vpns/${vpnRow!.id}/peers`, {
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })

  assertEquals(res.status, 200)
  const text = await res.text()
  assertEquals(text.includes('presharedKey'), false)
  assertEquals(text.includes(secretMarker), false)
  const body = JSON.parse(text) as { peers: Record<string, unknown>[] }
  assertEquals(body.peers.length, 1)
  assertEquals('presharedKey' in body.peers[0], false)
  assertEquals('tunnelAddress' in body.peers[0], false)
  assertEquals('ipId' in body.peers[0], false)
  assertEquals('endpointIpId' in body.peers[0], true)
  assertEquals('tunnelIpId' in body.peers[0], true)
  assertEquals(body.peers[0].role, 'member')

  await db.delete(peer).where(eq(peer.id, peerRow!.id))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, userId))
  await db.delete(member).where(eq(member.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('GET /vpns returns 403 for org member without organization:manage', async () => {
  if (!dbUrl) {
    console.warn('Skipping vpn route tests: TURBOPANEL_DATABASE_URL not set')
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
  registerVpnRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db
    .insert(organization)
    .values({ displayName: 'VPN List Org' })
    .returning({ id: organization.id })
  const organizationId = orgA!.id

  const [u] = await db
    .insert(user)
    .values({ email: `vpn-list-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id

  await db.insert(member).values({ organizationId, userId })

  const cookie = await sessionCookie(db, secrets, userId)
  const res = await app.request('/vpns', {
    headers: {
      cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })

  assertEquals(res.status, 403)

  await db.delete(member).where(eq(member.userId, userId))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

test('POST /vpns/:id/apply returns 403 for org member without organization:manage', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db.insert(organization).values({ displayName: 'Apply Org' }).returning({ id: organization.id })
  const [u] = await db.insert(user).values({ email: `vpn-apply-${crypto.randomUUID()}@example.com`, isEmailVerified: true }).returning({ id: user.id })
  await db.insert(member).values({ organizationId: orgA!.id, userId: u!.id })
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, cidr: '203.0.113.0/24', displayName: 'Mesh' }).returning({ id: vpn.id })

  const cookie = await sessionCookie(db, secrets, u!.id)
  const res = await app.request(`/vpns/${vpnRow!.id}/apply`, {
    method: 'POST',
    headers: { cookie, [ORG_ID_HEADER]: orgA!.id },
  })
  assertEquals(res.status, 403)

  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(member).where(eq(member.userId, u!.id))
  await db.delete(user).where(eq(user.id, u!.id))
  await db.delete(organization).where(eq(organization.id, orgA!.id))
})

test('POST /vpns/:id/peers returns 400 for invalid publicKey', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db.insert(organization).values({ displayName: 'PeerKey Org' }).returning({ id: organization.id })
  const [u] = await db.insert(user).values({ email: `vpn-peer-key-${crypto.randomUUID()}@example.com`, isEmailVerified: true }).returning({ id: user.id })
  await db.insert(member).values({ organizationId: orgA!.id, userId: u!.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: orgA!.id,
    actorType: 'user',
    actorId: u!.id,
    permission: 'organization:manage',
    allow: true,
  })
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, cidr: '203.0.113.0/24', displayName: 'Mesh' }).returning({ id: vpn.id })
  const [srv] = await db.insert(server).values({ organizationId: orgA!.id, displayName: 'Host' }).returning({ id: server.id })

  const cookie = await sessionCookie(db, secrets, u!.id)
  const res = await app.request(`/vpns/${vpnRow!.id}/peers`, {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serverId: srv!.id,
      publicKey: 'not-a-valid-wireguard-key',
    }),
  })
  assertEquals(res.status, 400)
  const body = await res.json() as { error: string }
  assertEquals(body.error, 'Invalid WireGuard public key')

  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, u!.id))
  await db.delete(member).where(eq(member.userId, u!.id))
  await db.delete(user).where(eq(user.id, u!.id))
  await db.delete(organization).where(eq(organization.id, orgA!.id))
})

test('PATCH /vpns/:id/peers/:peerId returns 400 for invalid publicKey', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db.insert(organization).values({ displayName: 'PeerPatchKey Org' }).returning({ id: organization.id })
  const [u] = await db.insert(user).values({ email: `vpn-peer-patch-${crypto.randomUUID()}@example.com`, isEmailVerified: true }).returning({ id: user.id })
  await db.insert(member).values({ organizationId: orgA!.id, userId: u!.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: orgA!.id,
    actorType: 'user',
    actorId: u!.id,
    permission: 'organization:manage',
    allow: true,
  })
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, cidr: '203.0.113.0/24', displayName: 'Mesh' }).returning({ id: vpn.id })
  const [srv] = await db.insert(server).values({ organizationId: orgA!.id, displayName: 'Host' }).returning({ id: server.id })
  const [peerRow] = await db.insert(peer).values({
    vpnId: vpnRow!.id,
    serverId: srv!.id,
    publicKey: WG_PUBKEY,
  }).returning({ id: peer.id })

  const cookie = await sessionCookie(db, secrets, u!.id)
  const res = await app.request(`/vpns/${vpnRow!.id}/peers/${peerRow!.id}`, {
    method: 'PATCH',
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ publicKey: 'still-not-valid!!' }),
  })
  assertEquals(res.status, 400)
  const body = await res.json() as { error: string }
  assertEquals(body.error, 'Invalid WireGuard public key')

  await db.delete(peer).where(eq(peer.id, peerRow!.id))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, u!.id))
  await db.delete(member).where(eq(member.userId, u!.id))
  await db.delete(user).where(eq(user.id, u!.id))
  await db.delete(organization).where(eq(organization.id, orgA!.id))
})

test('POST /vpns/:id/apply returns 422 when a peer lacks tunnel_address', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', createStubRegistry())
    c.set('commandQueue', createRecordingCommandQueue())
    return next()
  })
  registerVpnRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db.insert(organization).values({ displayName: 'Apply422 Org' }).returning({ id: organization.id })
  const [u] = await db.insert(user).values({ email: `vpn-apply422-${crypto.randomUUID()}@example.com`, isEmailVerified: true }).returning({ id: user.id })
  await db.insert(member).values({ organizationId: orgA!.id, userId: u!.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: orgA!.id,
    actorType: 'user',
    actorId: u!.id,
    permission: 'organization:manage',
    allow: true,
  })
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, cidr: '203.0.113.0/24', displayName: 'Mesh' }).returning({ id: vpn.id })
  const [srv] = await db.insert(server).values({ organizationId: orgA!.id, displayName: 'Host' }).returning({ id: server.id })
  await db.insert(peer).values({
    vpnId: vpnRow!.id,
    serverId: srv!.id,
    publicKey: WG_PUBKEY,
  })

  const cookie = await sessionCookie(db, secrets, u!.id)
  const res = await app.request(`/vpns/${vpnRow!.id}/apply`, {
    method: 'POST',
    headers: { cookie, [ORG_ID_HEADER]: orgA!.id },
  })
  assertEquals(res.status, 422)
  const body = await res.json() as { error: string }
  assertEquals(body.error, 'peer_tunnel_address_required')

  await db.delete(peer).where(eq(peer.vpnId, vpnRow!.id))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, u!.id))
  await db.delete(member).where(eq(member.userId, u!.id))
  await db.delete(user).where(eq(user.id, u!.id))
  await db.delete(organization).where(eq(organization.id, orgA!.id))
})

test('POST /vpns/:id/apply enqueues one command per peer without presharedKey in response', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const commandQueue = createRecordingCommandQueue()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', createStubRegistry())
    c.set('commandQueue', commandQueue)
    return next()
  })
  registerVpnRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db.insert(organization).values({ displayName: 'ApplyHappy Org' }).returning({ id: organization.id })
  const [u] = await db.insert(user).values({ email: `vpn-apply-ok-${crypto.randomUUID()}@example.com`, isEmailVerified: true }).returning({ id: user.id })
  await db.insert(member).values({ organizationId: orgA!.id, userId: u!.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: orgA!.id,
    actorType: 'user',
    actorId: u!.id,
    permission: 'organization:manage',
    allow: true,
  })
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, cidr: '203.0.113.0/24', displayName: 'Mesh' }).returning({ id: vpn.id })
  const [srvA] = await db.insert(server).values({ organizationId: orgA!.id, displayName: 'A' }).returning({ id: server.id })
  const [srvB] = await db.insert(server).values({ organizationId: orgA!.id, displayName: 'B' }).returning({ id: server.id })
  const [tunnelA] = await db.insert(ip).values({
    organizationId: orgA!.id,
    vpnId: vpnRow!.id,
    address: '203.0.113.10',
    allocation: 'dedicated',
    scope: 'vpn',
  }).returning({ id: ip.id })
  const [tunnelB] = await db.insert(ip).values({
    organizationId: orgA!.id,
    vpnId: vpnRow!.id,
    address: '203.0.113.11',
    allocation: 'dedicated',
    scope: 'vpn',
  }).returning({ id: ip.id })
  await db.insert(peer).values({
    vpnId: vpnRow!.id,
    serverId: srvA!.id,
    publicKey: WG_PUBKEY,
    tunnelIpId: tunnelA!.id,
    role: 'member',
    presharedKey: 'secret-should-not-leak',
  })
  await db.insert(peer).values({
    vpnId: vpnRow!.id,
    serverId: srvB!.id,
    publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    tunnelIpId: tunnelB!.id,
    role: 'member',
  })

  const cookie = await sessionCookie(db, secrets, u!.id)
  const res = await app.request(`/vpns/${vpnRow!.id}/apply`, {
    method: 'POST',
    headers: { cookie, [ORG_ID_HEADER]: orgA!.id },
  })
  assertEquals(res.status, 200)
  const text = await res.text()
  assertEquals(text.includes('presharedKey'), false)
  assertEquals(text.includes('secret-should-not-leak'), false)
  const body = JSON.parse(text) as { results: { status: string }[] }
  assertEquals(body.results.length, 2)
  assertEquals(body.results.every((row) => row.status === 'queued'), true)
  assertEquals(commandQueue.envelopes.length, 2)

  await db.delete(peer).where(eq(peer.vpnId, vpnRow!.id))
  await db.delete(ip).where(eq(ip.vpnId, vpnRow!.id))
  await db.delete(server).where(eq(server.id, srvA!.id))
  await db.delete(server).where(eq(server.id, srvB!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, u!.id))
  await db.delete(member).where(eq(member.userId, u!.id))
  await db.delete(user).where(eq(user.id, u!.id))
  await db.delete(organization).where(eq(organization.id, orgA!.id))
})

async function seedVpnManageSession(
  db: ReturnType<typeof createDenoDb>,
  label: string,
): Promise<{
  organizationId: string
  userId: string
  vpnId: string
  cookie: string
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
}> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const [orgA] = await db.insert(organization).values({ displayName: `${label} Org` }).returning({
    id: organization.id,
  })
  const [u] = await db.insert(user).values({
    email: `vpn-${label}-${crypto.randomUUID()}@example.com`,
    isEmailVerified: true,
  }).returning({ id: user.id })
  await db.insert(member).values({ organizationId: orgA!.id, userId: u!.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: orgA!.id,
    actorType: 'user',
    actorId: u!.id,
    permission: 'organization:manage',
    allow: true,
  })
  const [vpnRow] = await db.insert(vpn).values({
    organizationId: orgA!.id,
    cidr: '203.0.113.0/24',
    displayName: 'Mesh',
  }).returning({ id: vpn.id })
  const cookie = await sessionCookie(db, secrets, u!.id)
  return {
    organizationId: orgA!.id,
    userId: u!.id,
    vpnId: vpnRow!.id,
    cookie,
    secrets,
  }
}

test('POST /vpns/:id/peers auto-allocates tunnel IP and accepts gateway role', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const app = new Hono<AppEnv>()
  const seeded = await seedVpnManageSession(db, 'auto-alloc')
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets: seeded.secrets, runtime: 'deno' })

  const [srv] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    displayName: 'AutoHost',
  }).returning({ id: server.id })

  const res = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers: {
      cookie: seeded.cookie,
      [ORG_ID_HEADER]: seeded.organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serverId: srv!.id,
      publicKey: WG_PUBKEY,
      role: 'gateway',
    }),
  })
  assertEquals(res.status, 200)
  const body = await res.json() as { ok: boolean; id: string }

  const [peerRow] = await db.select({
    tunnelIpId: peer.tunnelIpId,
    role: peer.role,
  }).from(peer).where(eq(peer.id, body.id)).limit(1)
  assertEquals(peerRow?.role, 'gateway')
  assertEquals(typeof peerRow?.tunnelIpId, 'string')

  const [ipRow] = await db.select({
    address: ip.address,
    scope: ip.scope,
    allocation: ip.allocation,
  }).from(ip).where(eq(ip.id, peerRow!.tunnelIpId!)).limit(1)
  assertEquals(ipRow?.scope, 'vpn')
  assertEquals(ipRow?.allocation, 'dedicated')
  assertEquals(String(ipRow?.address).startsWith('203.0.113.'), true)

  const hubRes = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers: {
      cookie: seeded.cookie,
      [ORG_ID_HEADER]: seeded.organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serverId: srv!.id,
      publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      role: 'hub',
    }),
  })
  assertEquals(hubRes.status, 400)

  await db.delete(peer).where(eq(peer.vpnId, seeded.vpnId))
  await db.delete(ip).where(eq(ip.vpnId, seeded.vpnId))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(vpn).where(eq(vpn.id, seeded.vpnId))
  await db.delete(grant).where(eq(grant.actorId, seeded.userId))
  await db.delete(member).where(eq(member.userId, seeded.userId))
  await db.delete(user).where(eq(user.id, seeded.userId))
  await db.delete(organization).where(eq(organization.id, seeded.organizationId))
})

test('POST /vpns/:id/peers tunnelAddress in/out of CIDR and pool exhaustion', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets, runtime: 'deno' })

  const [orgA] = await db.insert(organization).values({ displayName: 'TinyCidr Org' }).returning({
    id: organization.id,
  })
  const [u] = await db.insert(user).values({
    email: `vpn-tiny-${crypto.randomUUID()}@example.com`,
    isEmailVerified: true,
  }).returning({ id: user.id })
  await db.insert(member).values({ organizationId: orgA!.id, userId: u!.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: orgA!.id,
    actorType: 'user',
    actorId: u!.id,
    permission: 'organization:manage',
    allow: true,
  })
  const [vpnRow] = await db.insert(vpn).values({
    organizationId: orgA!.id,
    cidr: '203.0.113.0/30',
    displayName: 'Tiny',
  }).returning({ id: vpn.id })
  const [srv] = await db.insert(server).values({
    organizationId: orgA!.id,
    displayName: 'TinyHost',
  }).returning({ id: server.id })
  const cookie = await sessionCookie(db, secrets, u!.id)

  const outRes = await app.request(`/vpns/${vpnRow!.id}/peers`, {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serverId: srv!.id,
      publicKey: WG_PUBKEY,
      tunnelAddress: '198.51.100.10',
    }),
  })
  assertEquals(outRes.status, 400)

  const inRes = await app.request(`/vpns/${vpnRow!.id}/peers`, {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serverId: srv!.id,
      publicKey: WG_PUBKEY,
      tunnelAddress: '203.0.113.1',
    }),
  })
  assertEquals(inRes.status, 200)

  const [srv2] = await db.insert(server).values({
    organizationId: orgA!.id,
    displayName: 'TinyHost2',
  }).returning({ id: server.id })
  const second = await app.request(`/vpns/${vpnRow!.id}/peers`, {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serverId: srv2!.id,
      publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    }),
  })
  assertEquals(second.status, 200)

  const [srv3] = await db.insert(server).values({
    organizationId: orgA!.id,
    displayName: 'TinyHost3',
  }).returning({ id: server.id })
  const exhausted = await app.request(`/vpns/${vpnRow!.id}/peers`, {
    method: 'POST',
    headers: {
      cookie,
      [ORG_ID_HEADER]: orgA!.id,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      serverId: srv3!.id,
      publicKey: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
    }),
  })
  assertEquals(exhausted.status, 409)
  const exhaustedBody = await exhausted.json() as { error: string }
  assertEquals(exhaustedBody.error, 'vpn_address_pool_exhausted')

  await db.delete(peer).where(eq(peer.vpnId, vpnRow!.id))
  await db.delete(ip).where(eq(ip.vpnId, vpnRow!.id))
  await db.delete(server).where(eq(server.organizationId, orgA!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, u!.id))
  await db.delete(member).where(eq(member.userId, u!.id))
  await db.delete(user).where(eq(user.id, u!.id))
  await db.delete(organization).where(eq(organization.id, orgA!.id))
})

test('POST /vpns/:id/peers preserves peer unique conflicts for auto and explicit tunnelAddress', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const seeded = await seedVpnManageSession(db, 'peer-conflict')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets: seeded.secrets, runtime: 'deno' })

  const [srvA] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    displayName: 'ConflictHostA',
  }).returning({ id: server.id })
  const [srvB] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    displayName: 'ConflictHostB',
  }).returning({ id: server.id })
  const [srvC] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    displayName: 'ConflictHostC',
  }).returning({ id: server.id })
  const [srvD] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    displayName: 'ConflictHostD',
  }).returning({ id: server.id })

  const peerHeaders = {
    cookie: seeded.cookie,
    [ORG_ID_HEADER]: seeded.organizationId,
    'content-type': 'application/json',
  }

  const autoCreate = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers: peerHeaders,
    body: JSON.stringify({
      serverId: srvA!.id,
      publicKey: WG_PUBKEY,
    }),
  })
  assertEquals(autoCreate.status, 200)

  const autoServerConflict = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers: peerHeaders,
    body: JSON.stringify({
      serverId: srvA!.id,
      publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    }),
  })
  assertEquals(autoServerConflict.status, 409)
  assertEquals(
    (await autoServerConflict.json() as { error: string }).error,
    'peer_server_conflict',
  )

  const autoKeyConflict = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers: peerHeaders,
    body: JSON.stringify({
      serverId: srvB!.id,
      publicKey: WG_PUBKEY,
    }),
  })
  assertEquals(autoKeyConflict.status, 409)
  assertEquals(
    (await autoKeyConflict.json() as { error: string }).error,
    'peer_public_key_conflict',
  )

  const explicitCreate = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers: peerHeaders,
    body: JSON.stringify({
      serverId: srvC!.id,
      publicKey: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      tunnelAddress: '203.0.113.50',
    }),
  })
  assertEquals(explicitCreate.status, 200)

  const explicitServerConflict = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers: peerHeaders,
    body: JSON.stringify({
      serverId: srvC!.id,
      publicKey: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=',
      tunnelAddress: '203.0.113.51',
    }),
  })
  assertEquals(explicitServerConflict.status, 409)
  assertEquals(
    (await explicitServerConflict.json() as { error: string }).error,
    'peer_server_conflict',
  )

  const explicitKeyConflict = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers: peerHeaders,
    body: JSON.stringify({
      serverId: srvD!.id,
      publicKey: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      tunnelAddress: '203.0.113.52',
    }),
  })
  assertEquals(explicitKeyConflict.status, 409)
  assertEquals(
    (await explicitKeyConflict.json() as { error: string }).error,
    'peer_public_key_conflict',
  )

  await db.delete(peer).where(eq(peer.vpnId, seeded.vpnId))
  await db.delete(ip).where(eq(ip.vpnId, seeded.vpnId))
  await db.delete(server).where(eq(server.organizationId, seeded.organizationId))
  await db.delete(vpn).where(eq(vpn.id, seeded.vpnId))
  await db.delete(grant).where(eq(grant.actorId, seeded.userId))
  await db.delete(member).where(eq(member.userId, seeded.userId))
  await db.delete(user).where(eq(user.id, seeded.userId))
  await db.delete(organization).where(eq(organization.id, seeded.organizationId))
})

test('DELETE /vpns/:id/peers/:peerId releases overlay tunnel IP', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const seeded = await seedVpnManageSession(db, 'release')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets: seeded.secrets, runtime: 'deno' })

  const [srv] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    displayName: 'ReleaseHost',
  }).returning({ id: server.id })
  const createRes = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers: {
      cookie: seeded.cookie,
      [ORG_ID_HEADER]: seeded.organizationId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ serverId: srv!.id, publicKey: WG_PUBKEY }),
  })
  assertEquals(createRes.status, 200)
  const created = await createRes.json() as { id: string }
  const [before] = await db.select({ tunnelIpId: peer.tunnelIpId }).from(peer).where(
    eq(peer.id, created.id),
  ).limit(1)
  const tunnelIpId = before!.tunnelIpId!

  const delRes = await app.request(`/vpns/${seeded.vpnId}/peers/${created.id}`, {
    method: 'DELETE',
    headers: {
      cookie: seeded.cookie,
      [ORG_ID_HEADER]: seeded.organizationId,
    },
  })
  assertEquals(delRes.status, 200)

  const [ipRow] = await db.select({ id: ip.id }).from(ip).where(eq(ip.id, tunnelIpId)).limit(1)
  assertEquals(ipRow, undefined)

  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(vpn).where(eq(vpn.id, seeded.vpnId))
  await db.delete(grant).where(eq(grant.actorId, seeded.userId))
  await db.delete(member).where(eq(member.userId, seeded.userId))
  await db.delete(user).where(eq(user.id, seeded.userId))
  await db.delete(organization).where(eq(organization.id, seeded.organizationId))
})

test('POST /vpns/:id/apply emits site CIDR only for primary remote gateway', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const commandQueue = createRecordingCommandQueue()
  const seeded = await seedVpnManageSession(db, 'site-routes')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', createStubRegistry())
    c.set('commandQueue', commandQueue)
    return next()
  })
  registerVpnRoutes(app, { secrets: seeded.secrets, runtime: 'deno' })

  const [dcEast] = await db.insert(datacenter).values({
    organizationId: seeded.organizationId,
    displayName: 'East',
  }).returning({ id: datacenter.id })
  const [dcWest] = await db.insert(datacenter).values({
    organizationId: seeded.organizationId,
    displayName: 'West',
  }).returning({ id: datacenter.id })
  await db.insert(network).values({
    organizationId: seeded.organizationId,
    datacenterId: dcEast!.id,
    kind: 'datacenter',
    cidr: '10.10.0.0/16',
    displayName: 'East LAN',
  })
  await db.insert(network).values({
    organizationId: seeded.organizationId,
    datacenterId: dcWest!.id,
    kind: 'datacenter',
    cidr: '10.20.0.0/16',
    displayName: 'West LAN',
  })

  const [memberSrv] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    datacenterId: dcWest!.id,
    displayName: 'Member',
    connected: true,
    daemonStatus: 'online',
  }).returning({ id: server.id })
  const [gwPrimary] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    datacenterId: dcEast!.id,
    displayName: 'GwPrimary',
    connected: true,
    daemonStatus: 'online',
  }).returning({ id: server.id })
  const [gwStandby] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    datacenterId: dcEast!.id,
    displayName: 'GwStandby',
    connected: true,
    daemonStatus: 'online',
  }).returning({ id: server.id })

  const [ipMember] = await db.insert(ip).values({
    organizationId: seeded.organizationId,
    vpnId: seeded.vpnId,
    serverId: memberSrv!.id,
    address: '203.0.113.10',
    allocation: 'dedicated',
    scope: 'vpn',
  }).returning({ id: ip.id })
  const [ipGw1] = await db.insert(ip).values({
    organizationId: seeded.organizationId,
    vpnId: seeded.vpnId,
    serverId: gwPrimary!.id,
    address: '203.0.113.11',
    allocation: 'dedicated',
    scope: 'vpn',
  }).returning({ id: ip.id })
  const [ipGw2] = await db.insert(ip).values({
    organizationId: seeded.organizationId,
    vpnId: seeded.vpnId,
    serverId: gwStandby!.id,
    address: '203.0.113.12',
    allocation: 'dedicated',
    scope: 'vpn',
  }).returning({ id: ip.id })

  const earlier = new Date(Date.now() - 60_000).toISOString()
  const later = new Date().toISOString()
  await db.insert(peer).values({
    vpnId: seeded.vpnId,
    serverId: memberSrv!.id,
    publicKey: WG_PUBKEY,
    tunnelIpId: ipMember!.id,
    role: 'member',
    createdAt: earlier,
    updatedAt: earlier,
  })
  await db.insert(peer).values({
    vpnId: seeded.vpnId,
    serverId: gwPrimary!.id,
    publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    tunnelIpId: ipGw1!.id,
    role: 'gateway',
    createdAt: earlier,
    updatedAt: earlier,
  })
  await db.insert(peer).values({
    vpnId: seeded.vpnId,
    serverId: gwStandby!.id,
    publicKey: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
    tunnelIpId: ipGw2!.id,
    role: 'gateway',
    createdAt: later,
    updatedAt: later,
  })

  const res = await app.request(`/vpns/${seeded.vpnId}/apply`, {
    method: 'POST',
    headers: { cookie: seeded.cookie, [ORG_ID_HEADER]: seeded.organizationId },
  })
  assertEquals(res.status, 200)

  type ApplyPayload = {
    peerId: string
    enableIpForwarding?: boolean
    peers: Array<{ publicKey: string; allowedIps: string[] }>
  }
  const payloads = commandQueue.envelopes.map((envelope) => {
    // Payloads are stored on command records; reconstruct from DB via peer public keys.
    return envelope
  })
  assertEquals(payloads.length, 3)

  const { getCommandRecord } = await import('../../lib/db/command-records.ts')
  const memberEnvelope = commandQueue.envelopes.find((e) => e.serverId === memberSrv!.id)!
  const memberCmd = await getCommandRecord(db, memberEnvelope.commandId)
  const memberPayload = memberCmd!.payload as ApplyPayload
  const gwPeersForMember = memberPayload.peers.filter((p) =>
    p.publicKey === 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
  )
  assertEquals(gwPeersForMember[0]?.allowedIps.includes('10.10.0.0/16'), true)
  assertEquals(gwPeersForMember[0]?.allowedIps.includes('203.0.113.11/32'), true)

  const standbyForMember = memberPayload.peers.filter((p) =>
    p.publicKey === 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC='
  )
  assertEquals(standbyForMember[0]?.allowedIps.includes('10.10.0.0/16'), false)
  assertEquals(standbyForMember[0]?.allowedIps, ['203.0.113.12/32'])

  const gwEnvelope = commandQueue.envelopes.find((e) => e.serverId === gwPrimary!.id)!
  const gwCmd = await getCommandRecord(db, gwEnvelope.commandId)
  const gwPayload = gwCmd!.payload as ApplyPayload
  assertEquals(gwPayload.enableIpForwarding, true)
  // Same-datacenter standby must not advertise East LAN to the primary gateway.
  const standbyForGw = gwPayload.peers.find((p) =>
    p.publicKey === 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC='
  )
  assertEquals(standbyForGw?.allowedIps.includes('10.10.0.0/16'), false)

  await db.delete(peer).where(eq(peer.vpnId, seeded.vpnId))
  await db.delete(ip).where(eq(ip.vpnId, seeded.vpnId))
  await db.delete(server).where(eq(server.organizationId, seeded.organizationId))
  await db.delete(network).where(eq(network.organizationId, seeded.organizationId))
  await db.delete(datacenter).where(eq(datacenter.organizationId, seeded.organizationId))
  await db.delete(vpn).where(eq(vpn.id, seeded.vpnId))
  await db.delete(grant).where(eq(grant.actorId, seeded.userId))
  await db.delete(member).where(eq(member.userId, seeded.userId))
  await db.delete(user).where(eq(user.id, seeded.userId))
  await db.delete(organization).where(eq(organization.id, seeded.organizationId))
})

test('POST /vpns/:id/apply returns 422 for gateway without datacenter or CIDR', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const seeded = await seedVpnManageSession(db, 'gw422')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', createStubRegistry())
    c.set('commandQueue', createRecordingCommandQueue())
    return next()
  })
  registerVpnRoutes(app, { secrets: seeded.secrets, runtime: 'deno' })

  const [srv] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    displayName: 'NoDcGw',
    connected: true,
    daemonStatus: 'online',
  }).returning({ id: server.id })
  const [tunnel] = await db.insert(ip).values({
    organizationId: seeded.organizationId,
    vpnId: seeded.vpnId,
    serverId: srv!.id,
    address: '203.0.113.10',
    allocation: 'dedicated',
    scope: 'vpn',
  }).returning({ id: ip.id })
  await db.insert(peer).values({
    vpnId: seeded.vpnId,
    serverId: srv!.id,
    publicKey: WG_PUBKEY,
    tunnelIpId: tunnel!.id,
    role: 'gateway',
  })

  const noDc = await app.request(`/vpns/${seeded.vpnId}/apply`, {
    method: 'POST',
    headers: { cookie: seeded.cookie, [ORG_ID_HEADER]: seeded.organizationId },
  })
  assertEquals(noDc.status, 422)
  assertEquals((await noDc.json() as { error: string }).error, 'gateway_datacenter_required')

  const [dc] = await db.insert(datacenter).values({
    organizationId: seeded.organizationId,
    displayName: 'EmptyDc',
  }).returning({ id: datacenter.id })
  await db.update(server).set({ datacenterId: dc!.id }).where(eq(server.id, srv!.id))

  const noCidr = await app.request(`/vpns/${seeded.vpnId}/apply`, {
    method: 'POST',
    headers: { cookie: seeded.cookie, [ORG_ID_HEADER]: seeded.organizationId },
  })
  assertEquals(noCidr.status, 422)
  assertEquals((await noCidr.json() as { error: string }).error, 'gateway_datacenter_cidr_required')

  await db.delete(peer).where(eq(peer.vpnId, seeded.vpnId))
  await db.delete(ip).where(eq(ip.vpnId, seeded.vpnId))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(datacenter).where(eq(datacenter.id, dc!.id))
  await db.delete(vpn).where(eq(vpn.id, seeded.vpnId))
  await db.delete(grant).where(eq(grant.actorId, seeded.userId))
  await db.delete(member).where(eq(member.userId, seeded.userId))
  await db.delete(user).where(eq(user.id, seeded.userId))
  await db.delete(organization).where(eq(organization.id, seeded.organizationId))
})

test('POST/PATCH peers reject tunnelIpId null; PATCH replaces and releases old tunnel', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const seeded = await seedVpnManageSession(db, 'tunnel-null')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets: seeded.secrets, runtime: 'deno' })

  const [srv] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    displayName: 'TunnelHost',
  }).returning({ id: server.id })

  const headers = {
    cookie: seeded.cookie,
    [ORG_ID_HEADER]: seeded.organizationId,
    'content-type': 'application/json',
  }

  const createNull = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      serverId: srv!.id,
      publicKey: WG_PUBKEY,
      tunnelIpId: null,
    }),
  })
  assertEquals(createNull.status, 400)

  const createRes = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ serverId: srv!.id, publicKey: WG_PUBKEY }),
  })
  assertEquals(createRes.status, 200)
  const created = await createRes.json() as { id: string }
  const [before] = await db.select({ tunnelIpId: peer.tunnelIpId }).from(peer).where(
    eq(peer.id, created.id),
  ).limit(1)
  const oldTunnelIpId = before!.tunnelIpId!

  const patchNull = await app.request(`/vpns/${seeded.vpnId}/peers/${created.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ tunnelIpId: null }),
  })
  assertEquals(patchNull.status, 400)

  const [replacement] = await db.insert(ip).values({
    organizationId: seeded.organizationId,
    vpnId: seeded.vpnId,
    serverId: srv!.id,
    address: '203.0.113.50',
    allocation: 'dedicated',
    scope: 'vpn',
  }).returning({ id: ip.id })

  const patchRes = await app.request(`/vpns/${seeded.vpnId}/peers/${created.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ tunnelIpId: replacement!.id }),
  })
  assertEquals(patchRes.status, 200)

  const [after] = await db.select({ tunnelIpId: peer.tunnelIpId }).from(peer).where(
    eq(peer.id, created.id),
  ).limit(1)
  assertEquals(after?.tunnelIpId, replacement!.id)

  const [oldIp] = await db.select({ id: ip.id }).from(ip).where(eq(ip.id, oldTunnelIpId)).limit(1)
  assertEquals(oldIp, undefined)

  await db.delete(peer).where(eq(peer.vpnId, seeded.vpnId))
  await db.delete(ip).where(eq(ip.vpnId, seeded.vpnId))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(vpn).where(eq(vpn.id, seeded.vpnId))
  await db.delete(grant).where(eq(grant.actorId, seeded.userId))
  await db.delete(member).where(eq(member.userId, seeded.userId))
  await db.delete(user).where(eq(user.id, seeded.userId))
  await db.delete(organization).where(eq(organization.id, seeded.organizationId))
})

test('PATCH /vpns/:id cidr widening and no-op ok; excluding tunnel addresses rejected', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const seeded = await seedVpnManageSession(db, 'cidr-fit')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets: seeded.secrets, runtime: 'deno' })

  const [srv] = await db.insert(server).values({
    organizationId: seeded.organizationId,
    displayName: 'CidrHost',
  }).returning({ id: server.id })

  const headers = {
    cookie: seeded.cookie,
    [ORG_ID_HEADER]: seeded.organizationId,
    'content-type': 'application/json',
  }

  const createRes = await app.request(`/vpns/${seeded.vpnId}/peers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      serverId: srv!.id,
      publicKey: WG_PUBKEY,
      tunnelAddress: '203.0.113.200',
    }),
  })
  assertEquals(createRes.status, 200)

  const noOp = await app.request(`/vpns/${seeded.vpnId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ cidr: '203.0.113.0/24' }),
  })
  assertEquals(noOp.status, 200)

  const widen = await app.request(`/vpns/${seeded.vpnId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ cidr: '203.0.112.0/22' }),
  })
  assertEquals(widen.status, 200)

  // /25 is 203.0.113.0–127; peer tunnel .200 is outside.
  const shrink = await app.request(`/vpns/${seeded.vpnId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ cidr: '203.0.113.0/25' }),
  })
  assertEquals(shrink.status, 409)
  assertEquals(
    (await shrink.json() as { error: string }).error,
    'vpn_cidr_excludes_addresses',
  )

  await db.delete(peer).where(eq(peer.vpnId, seeded.vpnId))
  await db.delete(ip).where(eq(ip.vpnId, seeded.vpnId))
  await db.delete(server).where(eq(server.id, srv!.id))
  await db.delete(vpn).where(eq(vpn.id, seeded.vpnId))
  await db.delete(grant).where(eq(grant.actorId, seeded.userId))
  await db.delete(member).where(eq(member.userId, seeded.userId))
  await db.delete(user).where(eq(user.id, seeded.userId))
  await db.delete(organization).where(eq(organization.id, seeded.organizationId))
})

test('POST /vpns rejects a duplicate CIDR in the same org with 409 vpn_cidr_in_use', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const seeded = await seedVpnManageSession(db, 'dup-cidr')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerVpnRoutes(app, { secrets: seeded.secrets, runtime: 'deno' })

  const headers = {
    cookie: seeded.cookie,
    [ORG_ID_HEADER]: seeded.organizationId,
    'content-type': 'application/json',
  }

  // seedVpnManageSession already created a vpn with cidr 203.0.113.0/24.
  const dup = await app.request('/vpns', {
    method: 'POST',
    headers,
    body: JSON.stringify({ displayName: 'Duplicate mesh', cidr: '203.0.113.0/24' }),
  })
  assertEquals(dup.status, 409)
  assertEquals((await dup.json() as { error: string }).error, 'vpn_cidr_in_use')

  const remainingVpns = await db
    .select({ id: vpn.id })
    .from(vpn)
    .where(eq(vpn.organizationId, seeded.organizationId))
  assertEquals(remainingVpns.length, 1)

  await db.delete(vpn).where(eq(vpn.id, seeded.vpnId))
  await db.delete(grant).where(eq(grant.actorId, seeded.userId))
  await db.delete(member).where(eq(member.userId, seeded.userId))
  await db.delete(user).where(eq(user.id, seeded.userId))
  await db.delete(organization).where(eq(organization.id, seeded.organizationId))
})
