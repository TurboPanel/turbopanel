/**
 * Forwarding tables are sent right away when something they are built from
 * changes: a deploy lands or goes, a site's names move or the site is deleted,
 * an "all" tunnel gains or loses a server, an address changes. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { deployment, doorway, hosting, ip, portal, server, tunnel } from '../../db/schema.ts'
import { parseTunnelRoutesPayload } from '../../contracts/commands/tunnel-routes.ts'
import { createCommandRecord, getCommandDispatchPayload } from '../commands/command-records.ts'
import { applySucceededSideEffects } from '../commands/consumer.ts'
import { DENY_FIREWALL_APPLY } from '../firewall/enforcement.ts'
import { replaceHostingHostnames } from '../servers/hostname-records.ts'
import { nudgeTunnelRoutes, nudgeTunnelRoutesForEnvironment } from './nudge.ts'
import {
  addAddress,
  connectorListOf,
  connectorsTo,
  NAME,
  sentTo,
  tableOf,
  withScenario,
} from './nudge-scenario.test.support.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

test('the first nudge sends the carrier a table to the site and the site server its peer; a second sends nothing', async () => {
  await withScenario({}, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const toCarrier = sentTo(s, s.carrierId)
    assertEquals(toCarrier.length, 1)
    const table = parseTunnelRoutesPayload(
      await getCommandDispatchPayload(s.db, toCarrier[0]!.commandId)
    )
    assertEquals(
      table.routes.map((r) => [r.hostname, r.local, r.upstreams[0]!.addresses]),
      [[NAME, false, ['10.95.0.11']]]
    )
    assertEquals(sentTo(s, s.siteAId).length, 1)
    const before = s.queued.length
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    assertEquals(s.queued.length, before)
  })
})

test('an organization with no tunnel, and a missing queue, send nothing and do not fail', async () => {
  await withScenario({}, async (s) => {
    await nudgeTunnelRoutes(s.db, null, s.organizationId)
    assertEquals(s.queued.length, 0)
    await s.db.delete(doorway).where(eq(doorway.tunnelId, s.tunnelId))
    await s.db.delete(portal).where(eq(portal.tunnelId, s.tunnelId))
    await s.db.delete(tunnel).where(eq(tunnel.id, s.tunnelId))
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    assertEquals(s.queued.length, 0)
  })
})

test('a deploy that lands on the server is forwarded to at once, and one that leaves is dropped', async () => {
  await withScenario({ deployedOnA: false }, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    // The site is not running anywhere yet: the carrier holds nothing to forward.
    assertEquals(sentTo(s, s.carrierId).length, 0)
    // The deploy result lands through the command consumer.
    const record = await createCommandRecord(s.db, {
      serverId: s.siteAId,
      actorType: 'system',
      actorId: s.siteAId,
      type: 'environment.deploy',
      payload: {
        environmentId: s.environmentAId,
        projectId: s.projectId,
        organizationId: s.organizationId,
        projectName: 'tp-nudge',
        composeFiles: [
          {
            filename: 'compose.yaml',
            role: 'runtime',
            source: 'inline',
            content: 'services:\n  web:\n    image: nginx\n',
          },
        ],
        hostings: [],
        generation: 1,
      },
    })
    await s.db
      .update(deployment)
      .set({ desiredGeneration: 1, lastCommandId: record.id })
      .where(eq(deployment.environmentId, s.environmentAId))
    await applySucceededSideEffects(
      s.db,
      {
        ...record,
        payload: await getCommandDispatchPayload(s.db, record.id),
      } as Parameters<typeof applySucceededSideEffects>[1],
      {
        commandId: record.id,
        serverId: s.siteAId,
        type: 'environment.deploy',
        attempt: 1,
        queuedAt: record.createdAt,
      },
      {},
      { ...s.deps, firewallApplyGate: DENY_FIREWALL_APPLY }
    )
    const toCarrier = sentTo(s, s.carrierId)
    assertEquals(toCarrier.length, 1)
    assertEquals((await tableOf(s, s.queued.indexOf(toCarrier[0]!))).routes.length, 1)
    // The site leaves the server: the carrier is told to drop the name.
    await s.db.delete(deployment).where(eq(deployment.environmentId, s.environmentAId))
    await nudgeTunnelRoutesForEnvironment(s.db, s.deps, s.environmentAId)
    const after = sentTo(s, s.carrierId)
    assertEquals(after.length, 2)
    assertEquals((await tableOf(s, s.queued.indexOf(after[1]!))).routes, [])
  })
})

test('a name that moves to another site is followed, and the table is sent again at once', async () => {
  await withScenario({}, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    // The name is edited off the first site and onto the second: delete-then-insert.
    await replaceHostingHostnames(s.db, s.hostingAId, s.organizationId, [])
    await replaceHostingHostnames(s.db, s.hostingBId, s.organizationId, [NAME])
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const [doorwayRow] = await s.db.select().from(doorway).where(eq(doorway.id, s.doorwayId))
    assertEquals(doorwayRow!.hostingId, s.hostingBId)
    const toCarrier = sentTo(s, s.carrierId)
    assertEquals(toCarrier.length, 2)
    const moved = await tableOf(s, s.queued.indexOf(toCarrier[1]!))
    assertEquals(moved.routes[0]!.upstreams[0]!.addresses, ['10.95.0.12'])
  })
})

test('a deleted site is dropped from the carrier, and a site made later with the name is picked up', async () => {
  await withScenario({}, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    await s.db.delete(hosting).where(eq(hosting.id, s.hostingAId))
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const [orphaned] = await s.db.select().from(doorway).where(eq(doorway.id, s.doorwayId))
    assertEquals(orphaned!.hostingId, null)
    const afterDelete = sentTo(s, s.carrierId)
    assertEquals(afterDelete.length, 2)
    assertEquals((await tableOf(s, s.queued.indexOf(afterDelete[1]!))).routes, [])
    // The site comes back on the other server with the same name.
    await replaceHostingHostnames(s.db, s.hostingBId, s.organizationId, [NAME])
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const afterReturn = sentTo(s, s.carrierId)
    assertEquals(afterReturn.length, 3)
    assertEquals(
      (await tableOf(s, s.queued.indexOf(afterReturn[2]!))).routes[0]!.upstreams[0]!.addresses,
      ['10.95.0.12']
    )
  })
})

test('a server that joins an "all" tunnel is sent its table at once, and one that leaves is told to drop it', async () => {
  await withScenario({ tunnelPlacement: 'all' }, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    assertEquals(sentTo(s, s.spareId).length, 0)
    await addAddress(s, s.spareId, '10.95.0.20')
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const joined = sentTo(s, s.spareId)
    assertEquals(joined.length, 1)
    assertEquals((await tableOf(s, s.queued.indexOf(joined[0]!))).routes.length, 1)
    await s.db.delete(ip).where(eq(ip.serverId, s.spareId))
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const left = sentTo(s, s.spareId)
    assertEquals(left.length, 2)
    assertEquals((await tableOf(s, s.queued.indexOf(left[1]!))).routes, [])
  })
})

test('a changed server address is sent at once, but an unchanged table inside the gap is not repeated', async () => {
  await withScenario({}, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    await s.db.update(ip).set({ address: '10.95.0.31' }).where(eq(ip.serverId, s.siteAId))
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const toCarrier = sentTo(s, s.carrierId)
    assertEquals(toCarrier.length, 2)
    assertEquals(
      (await tableOf(s, s.queued.indexOf(toCarrier[1]!))).routes[0]!.upstreams[0]!.addresses,
      ['10.95.0.31']
    )
    // The last command has not finished; the same table is held back for the gap.
    const count = s.queued.length
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    assertEquals(s.queued.length, count)
    // A different table goes out straight away even though the last one is still open.
    await s.db.update(ip).set({ address: '10.95.0.32' }).where(eq(ip.serverId, s.siteAId))
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    assert(s.queued.length > count)
  })
})

test('a server marked never to carry tunnels stops being sent forwarding for them', async () => {
  await withScenario({ tunnelPlacement: 'all' }, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const first = sentTo(s, s.carrierId)
    assertEquals(first.length, 1)
    await s.db
      .update(server)
      .set({ options: { tunnels: { carry: false } } })
      .where(eq(server.id, s.carrierId))
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const after = sentTo(s, s.carrierId)
    assertEquals(after.length, 2)
    assertEquals((await tableOf(s, s.queued.indexOf(after[1]!))).routes, [])
  })
})

test('a server that joins an "all" tunnel starts its connector at once, and one that leaves is told to remove it', async () => {
  await withScenario({ tunnelPlacement: 'all' }, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    assertEquals(connectorsTo(s, s.spareId).length, 0)
    assertEquals(connectorsTo(s, s.carrierId).length, 1)
    await addAddress(s, s.spareId, '10.95.0.20')
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const joined = connectorsTo(s, s.spareId)
    assertEquals(joined.length, 1)
    const list = await connectorListOf(s, joined[0]!)
    assertEquals(
      list.install.map((entry) => entry.tunnelId),
      [s.providerTunnelId]
    )
    assert(list.install[0]!.tokenEnvelope.startsWith('tpdaemon.'))
    await s.db.delete(ip).where(eq(ip.serverId, s.spareId))
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const left = connectorsTo(s, s.spareId)
    assertEquals(left.length, 2)
    assertEquals((await connectorListOf(s, left[1]!)).remove, [s.providerTunnelId])
  })
})
