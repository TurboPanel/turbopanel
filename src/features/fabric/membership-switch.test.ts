/**
 * Switching a server out of TurboFabric against a real Postgres: the server
 * keeps its relay row (address, prefix, endpoint pin, preshared key, LAN
 * sharing) but is in no peer list, snapshot, ladder or firewall exposure, and
 * gets every setting back when switched on again. A paused fabric drops out
 * the same way. Skipped without TURBOPANEL_DATABASE_URL, the way every
 * Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { datacenter, fabric, ip, network, organization, relay, server } from '../../db/schema.ts'
import { loadFabricExposures } from '../firewall/facts.ts'
import { loadServerFabricAddress } from '../net/private-endpoint.ts'
import {
  getFabricById,
  listFabricRelays,
  loadFabricReconcileSnapshot,
  setFabricEnabled,
} from './fabric-records.ts'
import { findFabricDependents, updateServerFabricMembership } from './membership.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const ALLOCATION = 'dedicated'

type Rig = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  fabricId: string
  onId: string
  offId: string
}

async function insertServer(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  name: string
): Promise<string> {
  const [row] = await db
    .insert(server)
    .values({ organizationId, name, isConnected: false, statusChangedAt: new Date().toISOString() })
    .returning({ id: server.id })
  return row!.id
}

async function withSwitchRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('TurboFabric server switch tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Fabric Switch Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const onId = await insertServer(db, organizationId, 'fabric-on')
    const offId = await insertServer(db, organizationId, 'fabric-off')
    const [fab] = await db
      .insert(fabric)
      .values({ organizationId, cidr: '10.250.0.0/16', options: null })
      .returning({ id: fabric.id })
    const fabricId = fab!.id
    await db.insert(relay).values([
      { fabricId, serverId: onId, address: '10.250.0.1', prefix: '10.192.0.0/16' },
      {
        fabricId,
        serverId: offId,
        address: '10.250.0.2',
        prefix: '10.193.0.0/16',
        endpointAddress: '192.0.2.10',
        presharedKey: 'tpsecret.sealed-sample',
        keepalive: 30,
      },
    ])
    await fn({ db, organizationId, fabricId, onId, offId })
  } finally {
    const rows = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.organizationId, organizationId))
    for (const row of rows) await db.delete(relay).where(eq(relay.serverId, row.id))
    await db.delete(ip).where(eq(ip.organizationId, organizationId))
    await db.delete(network).where(eq(network.organizationId, organizationId))
    await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
    await db.delete(fabric).where(eq(fabric.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

function serverIds(rows: ReadonlyArray<{ serverId: string }>): string[] {
  return rows.map((row) => row.serverId).sort((a, b) => a.localeCompare(b))
}

test('a switched-off server is in no peer list, snapshot, ladder or exposure and keeps its settings', async () => {
  await withSwitchRig(async ({ db, fabricId, onId, offId }) => {
    await updateServerFabricMembership(db, { serverId: offId, enabled: false })
    const record = (await getFabricById(db, fabricId))!

    assertEquals(serverIds(await listFabricRelays(db, fabricId)), [onId])
    assertEquals(serverIds((await loadFabricReconcileSnapshot(db, record)).relays), [onId])
    assertEquals(await loadServerFabricAddress(db, offId), null)
    assertEquals(await loadFabricExposures(db, offId), [])
    assertEquals((await loadFabricExposures(db, onId)).length, 1)

    // The row and its settings stay reserved for the server.
    const kept = (await listFabricRelays(db, fabricId, { includeSwitchedOff: true })).find(
      (row) => row.serverId === offId
    )
    assertEquals(kept?.address, '10.250.0.2')
    assertEquals(kept?.endpointAddress, '192.0.2.10')
    assertEquals(kept?.keepalive, 30)

    await updateServerFabricMembership(db, { serverId: offId, enabled: true })
    assertEquals(
      serverIds(await listFabricRelays(db, fabricId)),
      [offId, onId].sort((a, b) => a.localeCompare(b))
    )
    assertEquals(await loadServerFabricAddress(db, offId), '10.250.0.2')
    const [psk] = await db
      .select({ presharedKey: relay.presharedKey })
      .from(relay)
      .where(eq(relay.serverId, offId))
    assertEquals(psk?.presharedKey, 'tpsecret.sealed-sample')
  })
})

test('a paused fabric gives no ladder address and closes the WireGuard exposure', async () => {
  await withSwitchRig(async ({ db, fabricId, onId }) => {
    const record = (await getFabricById(db, fabricId))!
    await setFabricEnabled(db, record, false)
    assertEquals(await loadServerFabricAddress(db, onId), null)
    assertEquals(await loadFabricExposures(db, onId), [])
    await setFabricEnabled(db, record, true)
    assertEquals(await loadServerFabricAddress(db, onId), '10.250.0.1')
  })
})

test('the only server sharing a datacenter LAN cannot be switched out; a second one lifts that', async () => {
  await withSwitchRig(async ({ db, organizationId, onId, offId }) => {
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'rack-a' })
      .returning({ id: datacenter.id })
    const datacenterId = dc!.id
    const [lan] = await db
      .insert(network)
      .values({
        organizationId,
        datacenterId,
        kind: 'datacenter',
        cidr: '10.0.0.0/24',
        name: 'lan',
      })
      .returning({ id: network.id })
    const networkId = lan!.id
    await db.insert(ip).values([
      {
        organizationId,
        serverId: offId,
        datacenterId,
        networkId,
        address: '10.0.0.2',
        allocation: ALLOCATION,
        scope: 'datacenter',
      },
      {
        organizationId,
        serverId: onId,
        datacenterId,
        networkId,
        address: '10.0.0.3',
        allocation: ALLOCATION,
        scope: 'datacenter',
      },
    ])
    await db.update(relay).set({ role: 'gateway' }).where(eq(relay.serverId, offId))

    const blocked = await findFabricDependents(db, { serverId: offId, organizationId })
    assertEquals(
      blocked.map((row) => [row.kind, row.label]),
      [['lan_gateway', 'the LAN of datacenter "rack-a" (it is the only server sharing it)']]
    )

    await db.update(relay).set({ role: 'gateway' }).where(eq(relay.serverId, onId))
    assertEquals(await findFabricDependents(db, { serverId: offId, organizationId }), [])
  })
})
