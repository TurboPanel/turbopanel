/**
 * Deleting an organization removes everything it owns, in one transaction and
 * in an order the database accepts (`deleteOrganization`). Plain NO ACTION and
 * RESTRICT keys sit inside the cascade (`badge.secret_id`, `tunnel.carrier_id`,
 * `record.carrier_id`, `copy.secret_id`, `network.datacenter_id`,
 * `project.workspace_id`), and none of them is deferrable, so the proof runs
 * against a real database after any change to the baseline. The same keys must
 * keep refusing the delete of one secret or carrier that something still names.
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { deleteOrganization } from '../features/organizations/delete-organization.ts'
import { createDenoDb, endDbConnection, type Db } from './connection.ts'
import {
  badge,
  carrier,
  datacenter,
  dnsRecord,
  network,
  organization,
  project,
  secret,
  storage,
  storageCopy,
  tunnel,
  workspace,
} from './schema.ts'
import { getDatabaseUrl } from './url.ts'

const test = Deno.test.bind(Deno)

test('an organization delete removes rows on both sides of every plain key', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('organization delete cascade tests')
    return
  }
  const db: Db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Cascade Check Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const [dc] = await db
      .insert(datacenter)
      .values({ organizationId, name: 'dc' })
      .returning({ id: datacenter.id })
    await db.insert(network).values({
      organizationId,
      kind: 'datacenter',
      name: 'net',
      datacenterId: dc!.id,
      cidr: '10.9.0.0/24',
    })
    const [ws] = await db
      .insert(workspace)
      .values({ organizationId, name: 'ws' })
      .returning({ id: workspace.id })
    await db.insert(project).values({ organizationId, workspaceId: ws!.id, name: 'p' })
    const [badgeSecret] = await db
      .insert(secret)
      .values({
        organizationId,
        name: 'badge',
        provider: 'carrier_badge',
        secretEnvelope: 'x',
      })
      .returning({ id: secret.id })
    const [car] = await db
      .insert(carrier)
      .values({ organizationId, name: 'c', provider: 'cloudflare' })
      .returning({ id: carrier.id })
    await db.insert(badge).values({
      carrierId: car!.id,
      secretId: badgeSecret!.id,
      label: 'l',
      lastFour: 'abcd',
    })
    await db.insert(tunnel).values({
      organizationId,
      routingOrganizationId: organizationId,
      name: 't',
      provider: 'cloudflare',
      carrierId: car!.id,
    })
    await db.insert(dnsRecord).values({
      organizationId,
      carrierId: car!.id,
      name: 'r.example.test',
      kind: 'A',
      provider: 'cloudflare',
      zoneId: 'z',
      content: '192.0.2.1',
    })

    const [copySecret] = await db
      .insert(secret)
      .values({ organizationId, name: 'copy', provider: 's3', secretEnvelope: 'x' })
      .returning({ id: secret.id })
    const [vol] = await db
      .insert(storage)
      .values({ organizationId, name: 'vol', kind: 'volume' })
      .returning({ id: storage.id })
    await db.insert(storageCopy).values({
      storageId: vol!.id,
      provider: 's3',
      secretId: copySecret!.id,
    })

    // The same keys refuse a delete of one row that something still names.
    await assertRejects(() => db.delete(secret).where(eq(secret.id, copySecret!.id)))
    await assertRejects(() => db.delete(secret).where(eq(secret.id, badgeSecret!.id)))
    await assertRejects(() => db.delete(carrier).where(eq(carrier.id, car!.id)))
    assertEquals(
      (await db.select().from(storageCopy).where(eq(storageCopy.storageId, vol!.id))).length,
      1
    )

    await deleteOrganization(db, organizationId)

    for (const [name, rows] of [
      [
        'network',
        await db.select().from(network).where(eq(network.organizationId, organizationId)),
      ],
      [
        'project',
        await db.select().from(project).where(eq(project.organizationId, organizationId)),
      ],
      ['copy', await db.select().from(storageCopy).where(eq(storageCopy.storageId, vol!.id))],
      ['secret', await db.select().from(secret).where(eq(secret.organizationId, organizationId))],
      [
        'carrier',
        await db.select().from(carrier).where(eq(carrier.organizationId, organizationId)),
      ],
      ['tunnel', await db.select().from(tunnel).where(eq(tunnel.organizationId, organizationId))],
      [
        'record',
        await db.select().from(dnsRecord).where(eq(dnsRecord.organizationId, organizationId)),
      ],
    ] as const) {
      assertEquals(rows.length, 0, `${name} rows survived the organization delete`)
    }
  } finally {
    await deleteOrganization(db, organizationId)
    await endDbConnection(db)
  }
})
