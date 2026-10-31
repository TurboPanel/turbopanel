/**
 * What a daemon reports about its connectors is written onto the portal rows of
 * that server and no other. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { carrier, organization, portal, secret, server, tunnel } from '../../db/schema.ts'
import { connectorUpdateNotice, recordTunnelStatus } from './status.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel status tests')
    return
  }
  const db = createDenoDb()
  try {
    await fn(db)
  } finally {
    await endDbConnection(db)
  }
}

/** One tunnel carried by two servers; the provider id is what the daemon reports. */
async function seed(db: Db) {
  const [org] = await db
    .insert(organization)
    .values({ name: `Status Org ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [a] = await db.insert(server).values({ name: 'Status A' }).returning({ id: server.id })
  const [b] = await db.insert(server).values({ name: 'Status B' }).returning({ id: server.id })
  const [c] = await db
    .insert(carrier)
    .values({ organizationId, provider: 'cloudflare', name: 'Main', externalAccountId: 'acct' })
    .returning({ id: carrier.id })
  const [run] = await db
    .insert(secret)
    .values({
      organizationId,
      provider: 'tunnel_run',
      name: 'sealed',
      secretEnvelope: 'tpsecret:test',
    })
    .returning({ id: secret.id })
  const externalId = crypto.randomUUID()
  const [t] = await db
    .insert(tunnel)
    .values({
      organizationId,
      routingOrganizationId: organizationId,
      carrierId: c!.id,
      provider: 'cloudflare',
      name: 'web',
      externalId,
      placement: 'chosen',
      secretId: run!.id,
    })
    .returning({ id: tunnel.id })
  await db.insert(portal).values([
    { tunnelId: t!.id, serverId: a!.id },
    { tunnelId: t!.id, serverId: b!.id },
  ])
  return { organizationId, serverA: a!.id, serverB: b!.id, tunnelId: t!.id, externalId }
}

async function portalOf(db: Db, tunnelId: string, serverId: string) {
  const [row] = await db.select().from(portal).where(eq(portal.tunnelId, tunnelId))
  const rows = await db.select().from(portal).where(eq(portal.tunnelId, tunnelId))
  return rows.find((r) => r.serverId === serverId) ?? row!
}

test('a status answer updates only the reporting server and keeps why an update stopped', async () => {
  await withDb(async (db) => {
    const s = await seed(db)
    try {
      const updated = await recordTunnelStatus(
        db,
        s.serverA,
        {
          pinnedVersion: '2026.6.0',
          connectors: [
            {
              tunnelId: s.externalId,
              status: 'connected',
              version: '2026.5.2',
              slot: 'a',
              lastUpdate: {
                outcome: 'rolled-back',
                at: '2026-10-28T12:00:00.000Z',
                reason: 'it did not connect',
              },
            },
            { tunnelId: 'instance', status: 'connected', version: '2026.5.2', slot: 'a' },
            { tunnelId: crypto.randomUUID(), status: 'connected', version: '2026.5.2', slot: 'a' },
          ],
        },
        new Date('2026-10-28T12:30:00.000Z')
      )
      assertEquals(updated, 1)

      const a = await portalOf(db, s.tunnelId, s.serverA)
      assertEquals(a.reported, 'connected')
      assertEquals(a.connectorVersion, '2026.5.2')
      assertEquals(new Date(a.lastSeenAt!).toISOString(), '2026-10-28T12:30:00.000Z')
      assertEquals(a.lastError, 'The last connector update did not finish: it did not connect')
      const notice = connectorUpdateNotice(a.connectorVersion, a.metadata)
      assertEquals(notice.pending, true)
      assertEquals(notice.pinnedVersion, '2026.6.0')

      const b = await portalOf(db, s.tunnelId, s.serverB)
      assertEquals(b.reported, 'unknown')
      assertEquals(b.connectorVersion, null)
      assertEquals(b.lastSeenAt, null)
    } finally {
      await db.delete(organization).where(eq(organization.id, s.organizationId))
      await db.delete(server).where(eq(server.id, s.serverA))
      await db.delete(server).where(eq(server.id, s.serverB))
    }
  })
})

test('a later answer replaces the earlier one and a stopped connector reads as down', async () => {
  await withDb(async (db) => {
    const s = await seed(db)
    try {
      const answer = (status: 'connected' | 'stopped', version: string) => ({
        pinnedVersion: '2026.6.0',
        connectors: [{ tunnelId: s.externalId, status, version, slot: 'a' as const }],
      })
      await recordTunnelStatus(db, s.serverA, answer('connected', '2026.5.2'))
      await recordTunnelStatus(db, s.serverA, answer('stopped', '2026.6.0'))
      const a = await portalOf(db, s.tunnelId, s.serverA)
      assertEquals(a.reported, 'down')
      assertEquals(a.connectorVersion, '2026.6.0')
      assertEquals(a.lastError, null)
      assertEquals(connectorUpdateNotice(a.connectorVersion, a.metadata).pending, false)
    } finally {
      await db.delete(organization).where(eq(organization.id, s.organizationId))
      await db.delete(server).where(eq(server.id, s.serverA))
      await db.delete(server).where(eq(server.id, s.serverB))
    }
  })
})
