/**
 * Tunnel tables against a real database: deleting an organization removes
 * everything including every sealed token, a tunnel takes its run token with
 * it, a rotated token leaves no predecessor, and the new constraints hold.
 * Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  badge,
  carrier,
  datacenter,
  doorway,
  organization,
  portal,
  secret,
  server,
  tunnel,
} from '../../db/schema.ts'
import { deleteTunnelRecord, replaceTunnelRunSecret } from './records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>

async function seal(db: Db, organizationId: string, provider: string): Promise<string> {
  const [row] = await db
    .insert(secret)
    .values({ organizationId, provider, name: 'sealed', secretEnvelope: 'tpsecret:test' })
    .returning({ id: secret.id })
  return row!.id
}

/** One organization with a carrier, a badge, a tunnel with its run token, a portal and a doorway. */
async function seed(db: Db) {
  const [org] = await db
    .insert(organization)
    .values({ name: `Tunnel Org ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Tunnel Server' })
    .returning({ id: server.id })
  const [c] = await db
    .insert(carrier)
    .values({ organizationId, provider: 'cloudflare', name: 'Main', externalAccountId: 'acct' })
    .returning({ id: carrier.id })
  const badgeSecret = await seal(db, organizationId, 'carrier_badge')
  await db.insert(badge).values({
    carrierId: c!.id,
    secretId: badgeSecret,
    label: 'Main',
    lastFour: 'abcd',
  })
  const runSecret = await seal(db, organizationId, 'tunnel_run')
  const [t] = await db
    .insert(tunnel)
    .values({
      organizationId,
      routingOrganizationId: organizationId,
      carrierId: c!.id,
      provider: 'cloudflare',
      name: 'web',
      externalId: 'ext-1',
      placement: 'chosen',
      secretId: runSecret,
    })
    .returning({ id: tunnel.id })
  await db.insert(portal).values({ tunnelId: t!.id, serverId: srv!.id })
  await db
    .insert(doorway)
    .values({ routingOrganizationId: organizationId, tunnelId: t!.id, hostname: 'a.example.com' })
  return { organizationId, carrierId: c!.id, tunnelId: t!.id, runSecret, badgeSecret }
}

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel record tests')
    return
  }
  const db = createDenoDb()
  try {
    await fn(db)
  } finally {
    await endDbConnection(db)
  }
}

test('deleting an organization removes its carriers, badges, tunnels, portals, doorways and every sealed token', async () => {
  await withDb(async (db) => {
    const s = await seed(db)
    await db.delete(organization).where(eq(organization.id, s.organizationId))
    assertEquals(
      (await db.select().from(secret).where(eq(secret.organizationId, s.organizationId))).length,
      0
    )
    assertEquals((await db.select().from(carrier).where(eq(carrier.id, s.carrierId))).length, 0)
    assertEquals((await db.select().from(tunnel).where(eq(tunnel.id, s.tunnelId))).length, 0)
    assertEquals((await db.select().from(portal).where(eq(portal.tunnelId, s.tunnelId))).length, 0)
    assertEquals(
      (await db.select().from(doorway).where(eq(doorway.tunnelId, s.tunnelId))).length,
      0
    )
  })
})

test('deleting a tunnel deletes its run token, and replacing the token deletes the old one', async () => {
  await withDb(async (db) => {
    const s = await seed(db)
    try {
      await replaceTunnelRunSecret(db, {
        tunnelId: s.tunnelId,
        organizationId: s.organizationId,
        name: 'web',
        sealed: 'tpsecret:rotated',
      })
      assertEquals((await db.select().from(secret).where(eq(secret.id, s.runSecret))).length, 0)
      const [row] = await db.select().from(tunnel).where(eq(tunnel.id, s.tunnelId))
      const newSecret = row!.secretId!
      assert(newSecret !== s.runSecret)
      await deleteTunnelRecord(db, row!)
      assertEquals((await db.select().from(secret).where(eq(secret.id, newSecret))).length, 0)
      assertEquals((await db.select().from(tunnel).where(eq(tunnel.id, s.tunnelId))).length, 0)
      assertEquals(
        (await db.select().from(doorway).where(eq(doorway.tunnelId, s.tunnelId))).length,
        0
      )
    } finally {
      await db.delete(organization).where(eq(organization.id, s.organizationId))
    }
  })
})

test('the new constraints refuse duplicates and incomplete rows', async () => {
  await withDb(async (db) => {
    const s = await seed(db)
    try {
      // A carrier with a tunnel cannot be deleted directly (NO ACTION).
      await assertRejects(() => db.delete(carrier).where(eq(carrier.id, s.carrierId)))
      // Two rows cannot stand for one provider tunnel.
      await assertRejects(() =>
        db.insert(tunnel).values({
          organizationId: s.organizationId,
          routingOrganizationId: s.organizationId,
          carrierId: s.carrierId,
          provider: 'cloudflare',
          name: 'other',
          externalId: 'ext-1',
        })
      )
      // An `all` tunnel needs a datacenter.
      await assertRejects(() =>
        db.insert(tunnel).values({
          organizationId: s.organizationId,
          routingOrganizationId: s.organizationId,
          provider: 'cloudflare',
          name: 'everywhere',
          placement: 'all',
        })
      )
      const [dc] = await db
        .insert(datacenter)
        .values({ organizationId: s.organizationId, name: 'Tunnel DC' })
        .returning({ id: datacenter.id })
      await db.insert(tunnel).values({
        organizationId: s.organizationId,
        routingOrganizationId: s.organizationId,
        provider: 'cloudflare',
        name: 'everywhere',
        placement: 'all',
        datacenterId: dc!.id,
      })
      // One name sits on one doorway per routing organization, in lower case only.
      await assertRejects(() =>
        db.insert(doorway).values({
          routingOrganizationId: s.organizationId,
          tunnelId: s.tunnelId,
          hostname: 'a.example.com',
        })
      )
      await assertRejects(() =>
        db.insert(doorway).values({
          routingOrganizationId: s.organizationId,
          tunnelId: s.tunnelId,
          hostname: 'B.Example.com',
        })
      )
      // Empty names are refused.
      await assertRejects(() =>
        db
          .insert(carrier)
          .values({ organizationId: s.organizationId, provider: 'cloudflare', name: '' })
      )
    } finally {
      await db.delete(organization).where(eq(organization.id, s.organizationId))
    }
  })
})
