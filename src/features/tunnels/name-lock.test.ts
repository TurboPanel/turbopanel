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
  tls,
  tunnel,
  workspace,
} from '../../db/schema.ts'
import { TUNNEL_FORWARDING_FEATURE } from '../../lib/version-wire.ts'
import { settleTunnelOnlyHosting } from './tunnel-only-certificate.ts'
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

test('a locked name pinned to a library certificate stays locked and is not refused, whatever names that certificate covers', async () => {
  // A DNS-validated certificate is a library pin (`tlsId`, no `tlsMode`): the server presents
  // it, nothing is asked of the authority from the server, and which addresses may connect
  // is the lock's business alone. Only the Caddy-issued kind (`tlsMode: 'acme'`) is refused.
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await addDoorway(c)
    for (const www of [undefined, 'off', 'both', 'www-to-root'] as const) {
      const result = await resolveDeployNameLock(c.db, { ...params(c), tlsMode: undefined, www })
      assertEquals('refusal' in result, false)
      assertEquals(result, {
        tunnel: { hostnames: [NAME], peers: ['10.95.0.11'], extraBind: ['10.95.0.10'] },
      })
    }
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

test('a name that is also public stays open, and a public certificate pin on a locked name is set aside when every name is tunnel-only', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await addDoorway(c)
    // Every name the hosting serves is a locked tunnel name: it deploys on the internal certificate.
    assertEquals(await resolveDeployNameLock(c.db, { ...params(c), tlsMode: 'acme' }), {
      tunnel: { hostnames: [NAME], peers: ['10.95.0.11'], extraBind: ['10.95.0.10'] },
      dropPublicCertificate: true,
    })
    // The hosting also serves an ordinary public name: the pin cannot be set aside, so it is refused.
    assertEquals(
      await resolveDeployNameLock(c.db, {
        ...params(c),
        siteHostnames: [NAME, 'www.other.example.org'],
        tlsMode: 'acme',
      }),
      { refusal: { code: 'tunnel_name_public_certificate', hostnames: [NAME] } }
    )
    await c.db.update(doorway).set({ isLocalOnly: false }).where(eq(doorway.hostname, NAME))
    const open = await resolveDeployNameLock(c.db, { ...params(c), tlsMode: 'acme' })
    assertEquals('tunnel' in open ? open.tunnel?.openHostnames : undefined, [NAME])
    assertEquals('tunnel' in open ? open.dropPublicCertificate : 'refused', undefined)
  })
})

test('a name put on the tunnel before the site had it is locked on the very first deploy', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    // The doorway has no site yet (the site gets the name later); the sweep has not run.
    await addDoorway(c, { hostingId: null })
    const result = await resolveDeployNameLock(c.db, params(c))
    assertEquals(result, {
      tunnel: { hostnames: [NAME], peers: ['10.95.0.11'], extraBind: ['10.95.0.10'] },
    })
    // Read only: the link to the site is filled in later by the sweep and the resend.
    const [row] = await c.db.select().from(doorway).where(eq(doorway.tunnelId, c.tunnelId))
    assertEquals(row?.hostingId, null)
  })
})

test('a name already linked to another site of the organization is not taken by a second site that lists it', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await addDoorway(c)
    const [first] = await c.db
      .select({ serviceId: hosting.serviceId })
      .from(hosting)
      .where(eq(hosting.id, c.hostingId))
    const [svc] = await c.db
      .select({ environmentId: service.environmentId })
      .from(service)
      .where(eq(service.id, first!.serviceId))
    const [second] = await c.db
      .insert(service)
      .values({ environmentId: svc!.environmentId, composeServiceName: 'web2' })
      .returning({ id: service.id })
    const [other] = await c.db
      .insert(hosting)
      .values({ serviceId: second!.id, options: { hostnames: [NAME] } })
      .returning({ id: hosting.id })
    assertEquals(await resolveDeployNameLock(c.db, { ...params(c), hostingId: other!.id }), {
      tunnel: undefined,
    })
    // The site that holds the link still gets its lock.
    assertEquals('tunnel' in (await resolveDeployNameLock(c.db, params(c))), true)
  })
})

test('a www mode makes the other spelling a public name, so a public certificate pin is refused unless the mode is off', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await addDoorway(c)
    const pinned = { ...params(c), tlsMode: 'acme' as const }
    for (const www of ['both', 'www-to-root', 'root-to-www'] as const) {
      assertEquals(await resolveDeployNameLock(c.db, { ...pinned, www }), {
        refusal: { code: 'tunnel_name_public_certificate', hostnames: [NAME] },
      })
    }
    const off = await resolveDeployNameLock(c.db, { ...pinned, www: 'off' })
    assertEquals('tunnel' in off ? off.dropPublicCertificate : undefined, true)
    const none = await resolveDeployNameLock(c.db, pinned)
    assertEquals('tunnel' in none ? none.dropPublicCertificate : undefined, true)
    // The sibling spelling typed too and on the tunnel: every name is a locked tunnel name.
    await addDoorway(c, { hostname: `www.${NAME}` })
    const both = await resolveDeployNameLock(c.db, {
      ...pinned,
      siteHostnames: [NAME, `www.${NAME}`],
      www: 'both',
    })
    assertEquals('tunnel' in both ? both.dropPublicCertificate : undefined, true)
  })
})

test('the first deploy finds the doorway by the site’s own spelling of the name, and ignores another organization’s doorway', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await addDoorway(c, { hostingId: null })
    const result = await resolveDeployNameLock(c.db, {
      ...params(c),
      siteHostnames: ['Shop.Example.COM'],
    })
    assertEquals('tunnel' in result ? result.tunnel?.hostnames : undefined, ['Shop.Example.COM'])
    await c.db.delete(doorway).where(eq(doorway.tunnelId, c.tunnelId))

    const [other] = await c.db.insert(organization).values({ name: 'Other Claim Org' }).returning()
    try {
      await addDoorway(c, { routingOrganizationId: other!.id, hostingId: null })
      assertEquals(await resolveDeployNameLock(c.db, params(c)), { tunnel: undefined })
      const [row] = await c.db.select().from(doorway).where(eq(doorway.tunnelId, c.tunnelId))
      assertEquals(row?.hostingId, null)
    } finally {
      await c.db.delete(doorway).where(eq(doorway.tunnelId, c.tunnelId))
      await c.db.delete(organization).where(eq(organization.id, other!.id))
    }
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

async function pinSiteLetsEncrypt(
  c: { db: Db; organizationId: string; hostingId: string },
  names: string[]
): Promise<string> {
  const [row] = await c.db
    .insert(tls)
    .values({
      organizationId: c.organizationId,
      source: 'lets_encrypt',
      status: 'automatic',
      notAfter: new Date(0).toISOString(),
      metadata: {
        dnsNames: names,
        hasWildcard: false,
        notBefore: new Date(0).toISOString(),
        subject: '',
        issuer: '',
        acme: { challengeType: 'http-01', managedBy: 'caddy', createdFor: 'hosting' },
      },
      options: { autoRenew: true, requestedHostnames: names },
    })
    .returning({ id: tls.id })
  await c.db
    .update(hosting)
    .set({
      tlsId: row!.id,
      pendingAt: new Date().toISOString(),
    })
    .where(eq(hosting.id, c.hostingId))
  return row!.id
}

async function libraryRows(db: Db, organizationId: string) {
  return await db.select({ id: tls.id }).from(tls).where(eq(tls.organizationId, organizationId))
}

test('a site that only serves tunnel names loses its Let’s Encrypt row, pin and waiting request', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await addDoorway(c)
    await pinSiteLetsEncrypt(c, [NAME])
    assertEquals((await libraryRows(c.db, c.organizationId)).length, 1)
    assertEquals(await settleTunnelOnlyHosting(c.db, c), true)
    assertEquals((await libraryRows(c.db, c.organizationId)).length, 0)
    const [site] = await c.db.select().from(hosting).where(eq(hosting.id, c.hostingId))
    assertEquals(site!.tlsId, null)
    assertEquals(site!.pendingAt, null)
    // Settling again changes nothing.
    assertEquals(await settleTunnelOnlyHosting(c.db, c), true)
  })
})

test('a name that is also public, an ordinary name or no doorway keeps the Let’s Encrypt row', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await pinSiteLetsEncrypt(c, [NAME])
    // No doorway at all.
    assertEquals(await settleTunnelOnlyHosting(c.db, c), false)
    await addDoorway(c, { isLocalOnly: false })
    // The name is also public.
    assertEquals(await settleTunnelOnlyHosting(c.db, c), false)
    await c.db.update(doorway).set({ isLocalOnly: true }).where(eq(doorway.hostname, NAME))
    // The site also serves an ordinary public name.
    await c.db
      .update(hosting)
      .set({ options: { hostnames: [NAME, 'www.other.example.org'] } })
      .where(eq(hosting.id, c.hostingId))
    assertEquals(await settleTunnelOnlyHosting(c.db, c), false)
    const [site] = await c.db.select().from(hosting).where(eq(hosting.id, c.hostingId))
    assertEquals(site!.tlsId === null, false)
    assertEquals((await libraryRows(c.db, c.organizationId)).length, 1)
  })
})

test('a library row another site still pins stays, and only this site lets go of it', async () => {
  await withSite({ hereFeatures: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await addDoorway(c)
    const tlsId = await pinSiteLetsEncrypt(c, [NAME])
    const [other] = await c.db
      .insert(hosting)
      .values({
        serviceId: (await c.db.select().from(hosting).where(eq(hosting.id, c.hostingId)))[0]!
          .serviceId,
        options: { hostnames: ['public.example.org'] },
        tlsId,
      })
      .returning({ id: hosting.id })
    assertEquals(await settleTunnelOnlyHosting(c.db, c), true)
    assertEquals((await libraryRows(c.db, c.organizationId)).length, 1)
    const [kept] = await c.db.select().from(hosting).where(eq(hosting.id, other!.id))
    assertEquals(kept!.tlsId, tlsId)
  })
})
