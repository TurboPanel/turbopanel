/**
 * The tier a manager chose in Add Server reaches the server, against a real
 * Postgres: the registration key holds a seat at that tier, the server that
 * first enrolls with it takes exactly that seat, a key with no tier assigns
 * nothing, a reconnect never re-applies it, a seat gone in between leaves the
 * server uncovered with the choice kept, and deleting the server gives the
 * seat back for the next key.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertExists } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import {
  container,
  license,
  organization,
  payer,
  server,
  subscription,
  subscriptionItem,
  tier,
} from '../../db/schema.ts'
import { createLicense, revokeLicense } from '../licenses/license.ts'
import { assignServerTier } from '../tiers/assignment-records.ts'
import { countReservedLicenseTiers, getTierByLabel, insertTier } from '../tiers/tier-records.ts'
import { loadTierPlacementsForServers } from '../tiers/tier-enforcement.ts'
import {
  deleteSystemEnvironmentSubtree,
  listSystemEnvironmentIdsForServer,
} from '../system/hierarchy.ts'
import { resolveServerId } from './server-registry.ts'

type TestDb = ReturnType<typeof createDenoDb>

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

function machineKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

type Org = Readonly<{
  db: TestDb
  organizationId: string
  s1: string
  /** Mint a key, optionally carrying the Add Server tier. */
  mint: (tierId?: string) => Promise<{ licenseId: string; licenseToken: string }>
  /** Enroll a new host with a key; returns the server id and the hello it sent. */
  enroll: (key: { licenseId: string; licenseToken: string }) => Promise<{
    serverId: string
    hello: Parameters<typeof resolveServerId>[1]
  }>
  tierOf: (serverId: string) => Promise<{ assigned: string | null; preferred: string | null }>
}>

/** Enroll builds the system hierarchy, which pins the server row: drop it first, as the delete route does. */
async function deleteServers(db: TestDb, serverIds: readonly string[]): Promise<void> {
  for (const serverId of serverIds) {
    for (const environmentId of await listSystemEnvironmentIdsForServer(db, serverId)) {
      await deleteSystemEnvironmentSubtree(db, environmentId)
    }
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
  }
}

/** One organization with `s1Seats` S1 licenses bought, torn down afterwards. */
async function withOrg(s1Seats: number, fn: (org: Org) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('add server tier tests')
    return
  }
  const db = createDenoDb()
  const now = new Date().toISOString()
  const createdTiers: string[] = []
  let s1 = (await getTierByLabel(db, 'S1'))?.id
  if (!s1) {
    const row = await insertTier(db, {
      label: 'S1',
      providerProductId: 'prod_add_server_s1',
      priceCents: null,
      currency: null,
    })
    createdTiers.push(row.id)
    s1 = row.id
  }
  const [org] = await db
    .insert(organization)
    .values({ name: 'Add Server Tier Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [payerRow] = await db
    .insert(payer)
    .values({ organizationId, provider: 'stripe', providerCustomerId: `cus_${now}` })
    .returning({ id: payer.id })
  const [subRow] = await db
    .insert(subscription)
    .values({
      payerId: payerRow!.id,
      providerSubscriptionId: `sub_add_server_${crypto.randomUUID()}`,
      status: 'active',
      providerStatus: 'active',
    })
    .returning({ id: subscription.id })
  await db.insert(subscriptionItem).values({
    subscriptionId: subRow!.id,
    tierId: s1,
    providerItemId: `si_${crypto.randomUUID()}`,
    providerPriceId: `price_${crypto.randomUUID()}`,
    quantity: s1Seats,
  })
  const tierId = s1
  try {
    await fn({
      db,
      organizationId,
      s1: tierId,
      mint: (chosen) => createLicense(db, { organizationId, name: 'Add Server', tierId: chosen }),
      enroll: async (key) => {
        const hello = { hostname: `add-server-${crypto.randomUUID()}`, machineKey: machineKey() }
        const serverId = await resolveServerId(db, { ...hello, ...key })
        assertExists(serverId)
        return { serverId, hello: { ...hello, ...key, serverId } }
      },
      tierOf: async (serverId) => {
        const [row] = await db
          .select({ assigned: server.assignedTierId, preferred: server.preferredTierId })
          .from(server)
          .where(eq(server.id, serverId))
          .limit(1)
        return { assigned: row?.assigned ?? null, preferred: row?.preferred ?? null }
      },
    })
  } finally {
    const servers = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.organizationId, organizationId))
    await deleteServers(
      db,
      servers.map((row) => row.id)
    )
    await db.delete(license).where(eq(license.organizationId, organizationId))
    await db.delete(subscriptionItem).where(eq(subscriptionItem.subscriptionId, subRow!.id))
    await db.delete(subscription).where(eq(subscription.id, subRow!.id))
    await db.delete(payer).where(eq(payer.id, payerRow!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
    for (const id of createdTiers) await db.delete(tier).where(eq(tier.id, id))
  }
}

test('a key minted with a chosen tier holds the seat until its server enrolls and takes it', async () => {
  await withOrg(2, async ({ db, organizationId, s1, mint, enroll, tierOf }) => {
    const key = await mint(s1)
    assertEquals((await countReservedLicenseTiers(db, organizationId)).get(s1), 1)

    const { serverId, hello } = await enroll(key)
    assertEquals(await tierOf(serverId), { assigned: s1, preferred: s1 })
    // The held seat became the server's: nothing is held for a key any more.
    assertEquals((await countReservedLicenseTiers(db, organizationId)).size, 0)

    // A reconnect with the same key lands on the same row and changes nothing ...
    assertEquals(await resolveServerId(db, hello), serverId)
    assertEquals(await tierOf(serverId), { assigned: s1, preferred: s1 })
    // ... and never re-applies the Add Server tier over a manager's release.
    assertEquals((await assignServerTier(db, organizationId, serverId, null)).ok, true)
    assertEquals(await resolveServerId(db, hello), serverId)
    assertEquals(await tierOf(serverId), { assigned: null, preferred: null })
  })
})

test('a key with no tier chosen enrolls a server with no tier', async () => {
  await withOrg(2, async ({ mint, enroll, tierOf }) => {
    const { serverId } = await enroll(await mint())
    assertEquals(await tierOf(serverId), { assigned: null, preferred: null })
  })
})

test('a chosen tier whose seat is gone at enroll leaves the server uncovered and says why', async () => {
  await withOrg(1, async ({ db, organizationId, s1, mint, enroll, tierOf }) => {
    const key = await mint(s1)
    // The seat is cut after the key was minted (an owner lowered the quantity to zero).
    await db.update(subscriptionItem).set({ quantity: 0 }).where(eq(subscriptionItem.tierId, s1))
    const { serverId } = await enroll(key)
    assertEquals(await tierOf(serverId), { assigned: null, preferred: s1 })
    const placement = (
      await loadTierPlacementsForServers(db, [serverId], {
        deployment: 'hosted',
        unwatched: 'counts',
      })
    ).get(serverId)
    assertEquals(placement?.licenseTier, null)
    assertEquals(
      placement?.tierPickNotice?.startsWith('S1 was chosen when this server was added'),
      true
    )
    assertEquals((await countReservedLicenseTiers(db, organizationId)).size, 0)
  })
})

test('deleting a server gives its seat back, and re-adding it with the same tier covers it again', async () => {
  await withOrg(1, async ({ db, organizationId, s1, mint, enroll, tierOf }) => {
    const first = await mint(s1)
    const { serverId } = await enroll(first)
    assertEquals((await tierOf(serverId)).assigned, s1)

    // What the server delete route does: revoke the bound key, drop the row.
    assertEquals(await revokeLicense(db, first.licenseId, organizationId), true)
    await deleteServers(db, [serverId])

    const again = await enroll(await mint(s1))
    assertEquals(await tierOf(again.serverId), { assigned: s1, preferred: s1 })
  })
})

test('an unused key past its expiry cannot enroll and no longer holds its tier', async () => {
  await withOrg(1, async ({ db, organizationId, s1, mint, enroll, tierOf }) => {
    const key = await mint(s1)
    assertEquals((await countReservedLicenseTiers(db, organizationId)).get(s1), 1)
    await db
      .update(license)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(license.id, key.licenseId))
    assertEquals((await countReservedLicenseTiers(db, organizationId)).size, 0)
    const resolved = await resolveServerId(db, {
      hostname: `add-server-expired-${crypto.randomUUID()}`,
      machineKey: machineKey(),
      ...key,
    })
    assertEquals(resolved, null)
    // A bound key never expires: its server keeps the tier and keeps enrolling.
    const fresh = await mint(s1)
    const { serverId, hello } = await enroll(fresh)
    await db
      .update(license)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(license.id, fresh.licenseId))
    assertEquals(await resolveServerId(db, hello), serverId)
    assertEquals((await tierOf(serverId)).assigned, s1)
  })
})
