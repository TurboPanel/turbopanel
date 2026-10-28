/**
 * Sending forwarding tables against a real database: offline and old-daemon
 * servers are left alone, a server that should hold no table and never got one
 * is not bothered, a server that should now hold none is told, and a send that
 * did not finish is repeated. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, inArray, sql } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  command,
  datacenter,
  deployment,
  doorway,
  environment,
  hosting,
  ip,
  key,
  leaf,
  network,
  organization,
  portal,
  project,
  server,
  service,
  tunnel,
  workspace,
} from '../../db/schema.ts'
import { parseTunnelRoutesPayload } from '../../contracts/commands/tunnel-routes.ts'
import { applyPendingTlsLeafSideEffect } from '../commands/consumer.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { TUNNEL_FORWARDING_FEATURE } from '../../lib/version-wire.ts'
import { getCommandDispatchPayload } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { loadFirewallFacts } from '../firewall/facts.ts'
import {
  loadTunnelPeerExposures,
  TUNNEL_PEER_COMMENT,
  tunnelPeerExposures,
} from './peer-exposure.ts'
import { runTunnelRoutesSweepTick, syncServerTunnelRoutes } from './sync.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

/** Make the last send look old enough to be repeated. */
async function ageLastSend(db: ReturnType<typeof createDenoDb>, serverId: string): Promise<void> {
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(${server.metadata}, '{tunnelRoutes,sentAt}', to_jsonb(${new Date(Date.now() - 3_600_000).toISOString()}::text))`,
    })
    .where(eq(server.id, serverId))
}

async function withServer(
  options: { connected: boolean; features: string[] },
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    serverId: string
    queued: CommandEnvelope[]
    deps: Parameters<typeof syncServerTunnelRoutes>[1]
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel sync tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const queued: CommandEnvelope[] = []
  const [org] = await db.insert(organization).values({ name: 'Tunnel Sync Org' }).returning()
  const [row] = await db
    .insert(server)
    .values({
      organizationId: org!.id,
      name: 'Sync Server',
      isConnected: options.connected,
      daemon: { projection: { features: options.features } },
    })
    .returning({ id: server.id })
  await db.insert(key).values({
    serverId: row!.id,
    algorithm: 'Ed25519',
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
    fingerprint: `fp-${crypto.randomUUID()}`,
  })
  try {
    await fn({
      db,
      organizationId: org!.id,
      serverId: row!.id,
      queued,
      deps: {
        commandQueue: {
          enqueue: (envelope) => {
            queued.push(envelope)
            return Promise.resolve()
          },
        },
        secretsConfig,
        dataEncryptionSecrets,
      },
    })
  } finally {
    await db.delete(command).where(eq(command.serverId, row!.id))
    await db.delete(key).where(eq(key.serverId, row!.id))
    await db.delete(server).where(eq(server.id, row!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
}

test('an offline server and an old daemon are skipped', async () => {
  await withServer({ connected: false, features: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    const outcome = await syncServerTunnelRoutes(c.db, c.deps, c)
    assertEquals(outcome, { status: 'skipped', reason: 'server offline' })
  })
  await withServer({ connected: true, features: [] }, async (c) => {
    const outcome = await syncServerTunnelRoutes(c.db, c.deps, c)
    assertEquals(outcome, { status: 'skipped', reason: 'daemon too old' })
    assertEquals(c.queued.length, 0)
  })
})

test('a server that should hold no table and never got one is left alone', async () => {
  await withServer({ connected: true, features: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    assertEquals(await syncServerTunnelRoutes(c.db, c.deps, c), { status: 'unchanged' })
    assertEquals(c.queued.length, 0)
  })
})

test('a server that once held a table is told to drop it, and a send that failed is repeated', async () => {
  await withServer({ connected: true, features: [TUNNEL_FORWARDING_FEATURE] }, async (c) => {
    await c.db
      .update(server)
      .set({
        metadata: sql`jsonb_build_object('tunnelRoutes', jsonb_build_object('stateHash', ${'b'.repeat(64)}::text, 'commandId', ${crypto.randomUUID()}::text, 'sentAt', ${new Date().toISOString()}::text, 'forwarded', 1))`,
      })
      .where(eq(server.id, c.serverId))
    const first = await syncServerTunnelRoutes(c.db, c.deps, c)
    assertEquals(first.status, 'sent')
    assertEquals(c.queued.length, 1)
    assertEquals(c.queued[0]!.type, 'server.tunnel.routes')
    const payload = JSON.stringify(await getCommandDispatchPayload(c.db, c.queued[0]!.commandId))
    assert(payload.includes('"routes":[]') && payload.includes('"peerAddresses":[]'))
    // Still moving: nothing more is sent.
    assertEquals(await syncServerTunnelRoutes(c.db, c.deps, c), { status: 'unchanged' })
    // The command failed (the server was offline). A failed table is not sent again at once:
    // it waits out the gap, so a refused table does not mint a certificate every tick.
    await c.db.update(command).set({ status: 'failed' }).where(eq(command.serverId, c.serverId))
    assertEquals(await syncServerTunnelRoutes(c.db, c.deps, c), { status: 'unchanged' })
    await ageLastSend(c.db, c.serverId)
    assertEquals((await syncServerTunnelRoutes(c.db, c.deps, c)).status, 'sent')
    assertEquals(c.queued.length, 2)
    // The sweep reaches the same server through its remembered table.
    await c.db.update(command).set({ status: 'failed' }).where(eq(command.serverId, c.serverId))
    await ageLastSend(c.db, c.serverId)
    const swept = await runTunnelRoutesSweepTick(c.db, c.deps)
    assert(swept.sent >= 1)
  })
})

test('a carrying server and a site server are sent real tables with a peer certificate, and the leaf is tracked after the daemon confirms', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel sync tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const queued: CommandEnvelope[] = []
  const deps = {
    commandQueue: {
      enqueue: (envelope: CommandEnvelope) => {
        queued.push(envelope)
        return Promise.resolve()
      },
    },
    secretsConfig,
    dataEncryptionSecrets,
  }
  const [org] = await db.insert(organization).values({ name: 'Tunnel Sync Real Org' }).returning()
  const organizationId = org!.id
  try {
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'Sync DC' })
      .returning({ id: datacenter.id })
    const [net] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId: dc!.id,
        kind: 'datacenter',
        cidr: '10.94.0.0/24',
        name: 'LAN',
      })
      .returning({ id: network.id })
    const servers = await db
      .insert(server)
      .values(
        ['Carrier', 'Site Host'].map((name) => ({
          organizationId,
          name,
          isConnected: true,
          daemon: { projection: { features: [TUNNEL_FORWARDING_FEATURE] } },
        }))
      )
      .returning({ id: server.id })
    const [carrierId, siteId] = [servers[0]!.id, servers[1]!.id]
    for (const [index, serverId] of [carrierId, siteId].entries()) {
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
        address: `10.94.0.${10 + index}`,
        allocation: 'dedicated',
        scope: 'datacenter',
      })
    }
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Sync WS', organizationId })
      .returning({ id: workspace.id })
    const [proj] = await db
      .insert(project)
      .values({ name: 'Sync Project', workspaceId: ws!.id, organizationId })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ name: 'production', projectId: proj!.id, serverId: siteId })
      .returning({ id: environment.id })
    const [svc] = await db
      .insert(service)
      .values({ environmentId: env!.id, composeServiceName: 'web' })
      .returning({ id: service.id })
    const [site] = await db
      .insert(hosting)
      .values({ serviceId: svc!.id, options: { hostnames: [] } })
      .returning({ id: hosting.id })
    await db
      .insert(deployment)
      .values({ environmentId: env!.id, serverId: siteId, status: 'applied' })
    const [t] = await db
      .insert(tunnel)
      .values({
        organizationId,
        routingOrganizationId: organizationId,
        provider: 'cloudflare',
        name: 'Real',
        placement: 'chosen',
      })
      .returning({ id: tunnel.id })
    await db.insert(portal).values({ tunnelId: t!.id, serverId: carrierId, wanted: 'run' })
    await db.insert(doorway).values({
      routingOrganizationId: organizationId,
      tunnelId: t!.id,
      hostname: 'shop.example.com',
      hostingId: site!.id,
      status: 'live',
    })

    const sentCarrier = await syncServerTunnelRoutes(db, deps, {
      organizationId,
      serverId: carrierId,
    })
    assertEquals(sentCarrier.status, 'sent')
    const carrierPayload = parseTunnelRoutesPayload(
      await getCommandDispatchPayload(db, queued[0]!.commandId)
    )
    assertEquals(
      carrierPayload.routes.map((r) => [r.hostname, r.local]),
      [['shop.example.com', false]]
    )
    assertEquals(carrierPayload.routes[0]!.upstreams[0]!.addresses, ['10.94.0.11'])
    // A server that only carries tunnels has no inbound peers.
    assertEquals(carrierPayload.peerAddresses, [])
    assert(carrierPayload.peerMaterial !== undefined)

    const sentSite = await syncServerTunnelRoutes(db, deps, { organizationId, serverId: siteId })
    assertEquals(sentSite.status, 'sent')
    const sitePayload = parseTunnelRoutesPayload(
      await getCommandDispatchPayload(db, queued[1]!.commandId)
    )
    assertEquals(sitePayload.routes, [])
    assertEquals(sitePayload.peerAddresses, ['10.94.0.10'])
    assertEquals(sitePayload.listenAddresses, ['10.94.0.11'])

    // The firewall opens the hosting HTTPS port to exactly the peers the table names,
    // and a server that only carries tunnels gets no such rule.
    const sitePeers = await loadTunnelPeerExposures(db, organizationId, siteId)
    assertEquals(sitePeers, tunnelPeerExposures(sitePayload.peerAddresses))
    assertEquals(sitePeers[0]?.sources, ['10.94.0.10'])
    assertEquals(await loadTunnelPeerExposures(db, organizationId, carrierId), [])
    const facts = await loadFirewallFacts(db, siteId)
    assert(facts?.input.exposures.some((e) => e.comment === TUNNEL_PEER_COMMENT))
    const carrierFacts = await loadFirewallFacts(db, carrierId)
    assert(!carrierFacts?.input.exposures.some((e) => e.comment === TUNNEL_PEER_COMMENT))

    // Nothing is tracked until the daemon confirmed.
    assertEquals(
      (await db.select().from(leaf).where(eq(leaf.organizationId, organizationId))).length,
      0
    )
    await applyPendingTlsLeafSideEffect(db, {
      id: queued[0]!.commandId,
      type: 'server.tunnel.routes',
    } as Parameters<typeof applyPendingTlsLeafSideEffect>[1])
    const tracked = await db.select().from(leaf).where(eq(leaf.organizationId, organizationId))
    assertEquals(
      tracked.map((r) => [r.kind, r.serverId]),
      [['peer', carrierId]]
    )
  } finally {
    await db.delete(command).where(
      inArray(
        command.serverId,
        (
          await db
            .select({ id: server.id })
            .from(server)
            .where(eq(server.organizationId, organizationId))
        ).map((r) => r.id)
      )
    )
    await db.delete(leaf).where(eq(leaf.organizationId, organizationId))
    await db.delete(tunnel).where(eq(tunnel.organizationId, organizationId))
    await db.delete(deployment).where(
      inArray(
        deployment.serverId,
        (
          await db
            .select({ id: server.id })
            .from(server)
            .where(eq(server.organizationId, organizationId))
        ).map((r) => r.id)
      )
    )
    await db.delete(hosting).where(
      inArray(
        hosting.serviceId,
        (
          await db
            .select({ id: service.id })
            .from(service)
            .innerJoin(environment, eq(environment.id, service.environmentId))
            .innerJoin(project, eq(project.id, environment.projectId))
            .where(eq(project.organizationId, organizationId))
        ).map((r) => r.id)
      )
    )
    await db.delete(service).where(
      inArray(
        service.environmentId,
        (
          await db
            .select({ id: environment.id })
            .from(environment)
            .innerJoin(project, eq(project.id, environment.projectId))
            .where(eq(project.organizationId, organizationId))
        ).map((r) => r.id)
      )
    )
    await db.delete(environment).where(
      inArray(
        environment.projectId,
        (
          await db
            .select({ id: project.id })
            .from(project)
            .where(eq(project.organizationId, organizationId))
        ).map((r) => r.id)
      )
    )
    await db.delete(project).where(eq(project.organizationId, organizationId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(key).where(
      inArray(
        key.serverId,
        (
          await db
            .select({ id: server.id })
            .from(server)
            .where(eq(server.organizationId, organizationId))
        ).map((r) => r.id)
      )
    )
    await db.delete(ip).where(eq(ip.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(network).where(eq(network.organizationId, organizationId))
    await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})
