/**
 * Deleting an organization removes everything it owns in one statement. Two
 * `RESTRICT` keys (`network.datacenter_id`, `project.workspace_id`) and the three
 * deferred keys (`badge.secret_id`, `tunnel.carrier_id`, `record.carrier_id`)
 * sit inside that cascade, and the order Postgres runs the cascades in follows
 * the order the keys were created, so the delete is proved against a real
 * database after any change to the baseline. `copy.secret_id` is `RESTRICT` too
 * and is not covered: a copy that names a secret blocks the delete, as it did
 * before the reset.
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
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
  tunnel,
  workspace,
} from './schema.ts'
import { getDatabaseUrl } from './url.ts'

const test = Deno.test.bind(Deno)

test('an organization delete cascades through restrict and deferred keys', async () => {
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

    await db.delete(organization).where(eq(organization.id, organizationId))

    for (const [name, rows] of [
      [
        'network',
        await db.select().from(network).where(eq(network.organizationId, organizationId)),
      ],
      [
        'project',
        await db.select().from(project).where(eq(project.organizationId, organizationId)),
      ],
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
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})
