/**
 * The deploy-time lock against a real database: peers come from the other
 * servers that carry the tunnel, a name that is also public stays open, an
 * older daemon and a public certificate refuse a locked name, and a doorway
 * of another organization or one being removed locks nothing. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  datacenter,
  doorway,
  environment,
  hosting,
  ip,
  key,
  network,
  organization,
  portal,
  project,
  server,
  service,
  tunnel,
  workspace,
} from '../../db/schema.ts'
import { TUNNEL_FORWARDING_FEATURE } from '../../lib/version-wire.ts'
import { LOOPBACK_PEER, loadNameLock, resolveDeployNameLock } from './name-lock.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const NAME = 'shop.example.com'

type Db = ReturnType<typeof createDenoDb>

async function withSite(
  options: { hereFeatures: string[]; carrierOnly?: boolean },
  fn: (ctx: {
    db: Db
    organizationId: string
    hereId: string
    carrierId: string
    hostingId: string
    tunnelId: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel name lock tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db.insert(organization).values({ name: 'Name Lock Org' }).returning()
  const organizationId = org!.id
  try {
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Lock DC' })
      .returning({ id: datacenter.id })
    const [net] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.95.0.0/24',
        name: 'LAN',
      })
      .returning({ id: network.id })
    const servers = await db
      .insert(server)
      .values([
        {
          organizationId,
          name: 'Site Host',
          isConnected: true,
          daemon: { projection: { features: options.hereFeatures } },
        },
        {
          organizationId,
          name: 'Carrier',
          isConnected: true,
          daemon: { projection: { features: [TUNNEL_FORWARDING_FEATURE] } },
        },
      ])
      .returning({ id: server.id })
    const [hereId, carrierId] = [servers[0]!.id, servers[1]!.id]
    for (const [index, serverId] of [hereId, carrierId].entries()) {
      await db.insert(key).values({
        serverId,
        algorithm: 'Ed25519',
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
        fingerprint: `fp-${crypto.randomUUID()}`,
      })
      await db.insert(ip).values({
        organizationId,
        datacenterId: dc!.id,
        networkId: net!.id,
        serverId,
        address: `10.95.0.${10 + index}`,
        allocation: 'dedicated',
        scope: 'datacenter',
      })
    }
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Lock WS', organizationId })
      .returning({ id: workspace.id })
    const [proj] = await db
      .insert(project)
      .values({ name: 'Lock Project', workspaceId: ws!.id, organizationId })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ name: 'production', projectId: proj!.id, serverId: hereId })
      .returning({ id: environment.id })
    const [svc] = await db
      .insert(service)
      .values({ environmentId: env!.id, composeServiceName: 'web' })
      .returning({ id: service.id })
    const [site] = await db
      .insert(hosting)
      .values({ serviceId: svc!.id, options: { hostnames: [NAME] } })
      .returning({ id: hosting.id })
    const [t] = await db
      .insert(tunnel)
      .values({
        organizationId,
        routingOrganizationId: organizationId,
        provider: 'cloudflare',
        name: 'Lock',
        placement: 'chosen',
      })
      .returning({ id: tunnel.id })
    await db.insert(portal).values({
      tunnelId: t!.id,
      serverId: options.carrierOnly === false ? hereId : carrierId,
      wanted: 'run',
    })
    await fn({ db, organizationId, hereId, carrierId, hostingId: site!.id, tunnelId: t!.id })
  } finally {
    const serverIds = (
      await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.organizationId, organizationId))
    ).map((r) => r.id)
    const tunnelIds = (
      await db
        .select({ id: tunnel.id })
        .from(tunnel)
        .where(eq(tunnel.organizationId, organizationId))
    ).map((r) => r.id)
    if (tunnelIds.length > 0) {
      await db.delete(doorway).where(inArray(doorway.tunnelId, tunnelIds))
      await db.delete(portal).where(inArray(portal.tunnelId, tunnelIds))
    }
    await db.delete(tunnel).where(eq(tunnel.organizationId, organizationId))
    const projectIds = (
      await db
        .select({ id: project.id })
        .from(project)
        .where(eq(project.organizationId, organizationId))
    ).map((r) => r.id)
    if (projectIds.length > 0) {
      const envIds = (
        await db
          .select({ id: environment.id })
          .from(environment)
          .where(inArray(environment.projectId, projectIds))
      ).map((r) => r.id)
      if (envIds.length > 0) {
        const svcIds = (
          await db
            .select({ id: service.id })
            .from(service)
            .where(inArray(service.environmentId, envIds))
        ).map((r) => r.id)
        if (svcIds.length > 0) await db.delete(hosting).where(inArray(hosting.serviceId, svcIds))
        await db.delete(service).where(inArray(service.environmentId, envIds))
      }
      await db.delete(environment).where(inArray(environment.projectId, projectIds))
    }
    await db.delete(project).where(eq(project.organizationId, organizationId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(ip).where(eq(ip.organizationId, organizationId))
    if (serverIds.length > 0) {
      await db.delete(key).where(inArray(key.serverId, serverIds))
      await db.delete(server).where(inArray(server.id, serverIds))
    }
    await db.delete(network).where(eq(network.organizationId, organizationId))
    await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

async function addDoorway(
  c: { db: Db; organizationId: string; hostingId: string; tunnelId: string },
  values: Partial<typeof doorway.$inferInsert> = {}
): Promise<void> {
  await c.db.insert(doorway).values({
    routingOrganizationId: c.organizationId,
    tunnelId: c.tunnelId,
    hostname: NAME,
    hostingId: c.hostingId,
    status: 'live',
    ...values,
  })
}

function params(c: { organizationId: string; hereId: string; hostingId: string }) {
  return {
    organizationId: c.organizationId,
    serverId: c.hereId,
    hostingId: c.hostingId,
    siteHostnames: [NAME],
    tlsMode: undefined,
  }
}

test('a locked name gets the other carriers as peers and this server’s address to listen on', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await addDoorway(c)
    const result = await resolveDeployNameLock(c.db, params(c))
    assertEquals(result, {
      tunnel: { hostnames: [NAME], peers: ['10.95.0.11'], extraBind: ['10.95.0.10'] },
    })
  })
})

test('a server that carries the tunnel itself and has no other carrier trusts only loopback', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE], carrierOnly: false }, async (c) => {
    await addDoorway(c)
    const result = await resolveDeployNameLock(c.db, params(c))
    assertEquals(result, { tunnel: { hostnames: [NAME], peers: [LOOPBACK_PEER] } })
  })
})

test('an older daemon refuses a locked name and ignores an all-public hosting', async () => {
  await withSite({ hereFeatures: [] }, async (c) => {
    await addDoorway(c)
    assertEquals(await resolveDeployNameLock(c.db, params(c)), {
      refusal: { code: 'tunnel_daemon_too_old', hostnames: [NAME] },
    })
    await c.db.update(doorway).set({ isLocalOnly: false }).where(eq(doorway.hostname, NAME))
    assertEquals(await resolveDeployNameLock(c.db, params(c)), { tunnel: undefined })
  })
})

test('a name that is also public stays open, and a public certificate on a locked name is refused', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await addDoorway(c)
    assertEquals(await resolveDeployNameLock(c.db, { ...params(c), tlsMode: 'acme' }), {
      refusal: { code: 'tunnel_name_public_certificate', hostnames: [NAME] },
    })
    await c.db.update(doorway).set({ isLocalOnly: false }).where(eq(doorway.hostname, NAME))
    const open = await resolveDeployNameLock(c.db, { ...params(c), tlsMode: 'acme' })
    assertEquals('tunnel' in open ? open.tunnel?.openHostnames : undefined, [NAME])
  })
})

test('no doorway, a name being removed and a doorway of another organization lock nothing', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    assertEquals(
      (await loadNameLock(c.db, { ...params(c), siteHostnames: [NAME] })).tunnel,
      undefined
    )
    await addDoorway(c, { status: 'removing' })
    assertEquals(
      (await loadNameLock(c.db, { ...params(c), siteHostnames: [NAME] })).tunnel,
      undefined
    )
    await c.db.delete(doorway).where(eq(doorway.tunnelId, c.tunnelId))
    const [other] = await c.db.insert(organization).values({ name: 'Other Lock Org' }).returning()
    try {
      await addDoorway(c, { routingOrganizationId: other!.id })
      assertEquals(
        (await loadNameLock(c.db, { ...params(c), siteHostnames: [NAME] })).tunnel,
        undefined
      )
    } finally {
      await c.db.delete(doorway).where(eq(doorway.tunnelId, c.tunnelId))
      await c.db.delete(organization).where(eq(organization.id, other!.id))
    }
  })
})
