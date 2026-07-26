import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { ip, organization, server, vpn } from '../db/schema.ts'
import {
  allocateVpnTunnelIp,
  createVpnTunnelIpAt,
  releaseVpnTunnelIpIfOrphaned,
} from './vpn-address-allocator.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

test('allocateVpnTunnelIp picks lowest free host and reuses after release', async () => {
  if (!dbUrl) {
    console.warn('Skipping allocator tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ displayName: 'Alloc Org' })
    .returning({ id: organization.id })
  const [vpnRow] = await db
    .insert(vpn)
    .values({ organizationId: org!.id, cidr: '203.0.113.0/30', displayName: 'Mesh' })
    .returning({ id: vpn.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId: org!.id, displayName: 'Host-A' })
    .returning({ id: server.id })

  try {
    const first = await allocateVpnTunnelIp(db, {
      vpnId: vpnRow!.id,
      serverId: srv!.id,
    })
    assertEquals('kind' in first, false)
    if ('kind' in first) return
    assertEquals(first.address, '203.0.113.1')

    const second = await allocateVpnTunnelIp(db, {
      vpnId: vpnRow!.id,
      serverId: srv!.id,
    })
    assertEquals('kind' in second, false)
    if ('kind' in second) return
    assertEquals(second.address, '203.0.113.2')

    await releaseVpnTunnelIpIfOrphaned(db, {
      vpnId: vpnRow!.id,
      tunnelIpId: first.ipId,
    })

    const reused = await allocateVpnTunnelIp(db, {
      vpnId: vpnRow!.id,
      serverId: srv!.id,
    })
    assertEquals('kind' in reused, false)
    if ('kind' in reused) return
    assertEquals(reused.address, '203.0.113.1')

    const exhausted = await allocateVpnTunnelIp(db, {
      vpnId: vpnRow!.id,
      serverId: srv!.id,
    })
    assertEquals(exhausted, { kind: 'vpn_address_pool_exhausted' })
  } finally {
    await db.delete(ip).where(eq(ip.vpnId, vpnRow!.id))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
  }
})

test('allocateVpnTunnelIp treats ::/128 as pool exhausted', async () => {
  if (!dbUrl) return

  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ displayName: 'Alloc IPv6 Unspec Org' })
    .returning({ id: organization.id })
  const [vpnRow] = await db
    .insert(vpn)
    .values({ organizationId: org!.id, cidr: '::/128', displayName: 'Unspec' })
    .returning({ id: vpn.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId: org!.id, displayName: 'Host-V6' })
    .returning({ id: server.id })

  try {
    const exhausted = await allocateVpnTunnelIp(db, {
      vpnId: vpnRow!.id,
      serverId: srv!.id,
    })
    assertEquals(exhausted, { kind: 'vpn_address_pool_exhausted' })
  } finally {
    await db.delete(ip).where(eq(ip.vpnId, vpnRow!.id))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
  }
})

test('createVpnTunnelIpAt rejects out-of-cidr and maps unique conflicts', async () => {
  if (!dbUrl) return

  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ displayName: 'Alloc Explicit Org' })
    .returning({ id: organization.id })
  const [vpnRow] = await db
    .insert(vpn)
    .values({ organizationId: org!.id, cidr: '203.0.113.0/24', displayName: 'Mesh' })
    .returning({ id: vpn.id })
  const [srv] = await db
    .insert(server)
    .values({ organizationId: org!.id, displayName: 'Host-B' })
    .returning({ id: server.id })

  try {
    const outside = await createVpnTunnelIpAt(db, {
      vpnId: vpnRow!.id,
      serverId: srv!.id,
      address: '198.51.100.10',
    })
    assertEquals(outside, { kind: 'vpn_address_out_of_cidr' })

    const created = await createVpnTunnelIpAt(db, {
      vpnId: vpnRow!.id,
      serverId: srv!.id,
      address: '203.0.113.50',
    })
    assertEquals('kind' in created, false)

    const conflict = await createVpnTunnelIpAt(db, {
      vpnId: vpnRow!.id,
      serverId: srv!.id,
      address: '203.0.113.50',
    })
    assertEquals(conflict, { kind: 'vpn_address_conflict' })
  } finally {
    await db.delete(ip).where(eq(ip.vpnId, vpnRow!.id))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
  }
})
