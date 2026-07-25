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
  grant,
  member,
  organization,
  network,
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

test('POST /vpns with meshCidr auto-creates VPN network and links mesh', async () => {
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
  const meshCidr = '203.0.113.0/24'

  const res = await app.request('/vpns', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ displayName: 'East mesh', meshCidr }),
  })

  assertEquals(res.status, 200)
  const body = await res.json() as { ok: boolean; id: string; networkId?: string }
  assertEquals(body.ok, true)
  assertEquals(typeof body.id, 'string')
  assertEquals(typeof body.networkId, 'string')

  const [vpnRow] = await db
    .select({ networkId: vpn.networkId })
    .from(vpn)
    .where(eq(vpn.id, body.id))
    .limit(1)
  assertEquals(vpnRow?.networkId, body.networkId)

  const [netRow] = await db
    .select({ kind: network.kind, cidr: network.cidr, displayName: network.displayName })
    .from(network)
    .where(eq(network.id, body.networkId!))
    .limit(1)
  assertEquals(netRow?.kind, 'vpn')
  assertEquals(netRow?.cidr, meshCidr)
  assertEquals(netRow?.displayName, 'East mesh mesh')

  await db.delete(vpn).where(eq(vpn.id, body.id))
  await db.delete(network).where(eq(network.id, body.networkId!))
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
    .values({ organizationId, displayName: 'Mesh', createdAt: now, updatedAt: now })
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
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, displayName: 'Mesh' }).returning({ id: vpn.id })

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
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, displayName: 'Mesh' }).returning({ id: vpn.id })
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
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, displayName: 'Mesh' }).returning({ id: vpn.id })
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
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, displayName: 'Mesh' }).returning({ id: vpn.id })
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
  const [vpnRow] = await db.insert(vpn).values({ organizationId: orgA!.id, displayName: 'Mesh' }).returning({ id: vpn.id })
  const [srvA] = await db.insert(server).values({ organizationId: orgA!.id, displayName: 'A' }).returning({ id: server.id })
  const [srvB] = await db.insert(server).values({ organizationId: orgA!.id, displayName: 'B' }).returning({ id: server.id })
  await db.insert(peer).values({
    vpnId: vpnRow!.id,
    serverId: srvA!.id,
    publicKey: WG_PUBKEY,
    tunnelAddress: '203.0.113.10',
    presharedKey: 'secret-should-not-leak',
  })
  await db.insert(peer).values({
    vpnId: vpnRow!.id,
    serverId: srvB!.id,
    publicKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    tunnelAddress: '203.0.113.11',
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
  await db.delete(server).where(eq(server.id, srvA!.id))
  await db.delete(server).where(eq(server.id, srvB!.id))
  await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  await db.delete(grant).where(eq(grant.actorId, u!.id))
  await db.delete(member).where(eq(member.userId, u!.id))
  await db.delete(user).where(eq(user.id, u!.id))
  await db.delete(organization).where(eq(organization.id, orgA!.id))
})
