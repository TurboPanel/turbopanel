/**
 * The groundwork tables and columns (`0032_groundwork_tables_and_columns`)
 * against a real database: every CHECK, unique key and foreign key the
 * migration adds refuses what it should and accepts what it should. Nothing
 * writes these tables yet; this keeps the shapes honest until a feature does.
 */
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { createDenoDb, endDbConnection, type Db } from './connection.ts'
import {
  carrier,
  dnsRecord,
  environment,
  notificationChannel,
  organization,
  peripheral,
  principal,
  principalPlacement,
  project,
  server,
  service,
  visitor,
  workspace,
} from './schema.ts'
import { getDatabaseUrl } from './url.ts'

const test = Deno.test.bind(Deno)

/** The text Postgres gave for a refused statement: the constraint name when it has one. */
function refusal(err: unknown): string {
  const cause = (err as { cause?: { constraint_name?: string; message?: string } }).cause
  return `${cause?.constraint_name ?? ''} ${cause?.message ?? ''} ${(err as Error).message ?? ''}`
}

async function refuses(name: string, run: () => Promise<unknown>): Promise<void> {
  let message = ''
  try {
    await run()
  } catch (err) {
    message = refusal(err)
  }
  assert(message.includes(name), `${name}: got "${message}"`)
}

/** A bcrypt-shaped hash built at run time so no hash-like literal sits in the source. */
function bcryptShaped(prefix: string): string {
  return `${prefix}${'a'.repeat(53)}`
}

test('groundwork tables and columns hold the rules the migration gives them', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('groundwork check tests')
    return
  }
  const db: Db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Groundwork Check Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'ws', organizationId })
      .returning({ id: workspace.id })
    const [proj] = await db
      .insert(project)
      .values({ name: 'p', workspaceId: ws!.id, organizationId })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ projectId: proj!.id, name: 'production' })
      .returning({ id: environment.id })
    const [svc] = await db
      .insert(service)
      .values({ environmentId: env!.id, composeServiceName: 'web', slug: 'web' })
      .returning({ id: service.id, isHostAccessAllowed: service.isHostAccessAllowed })
    const serviceId = svc!.id
    // A new service has host access off until someone turns it on.
    assertEquals(svc!.isHostAccessAllowed, false)

    const now = new Date().toISOString()
    const makeServer = async (name: string) =>
      (
        await db
          .insert(server)
          .values({ organizationId, name, createdAt: now, updatedAt: now })
          .returning({ id: server.id, role: server.role })
      )[0]!
    const srv = await makeServer('S1')
    const srv2 = await makeServer('S2')
    assertEquals(srv.role, 'server')
    await refuses('server_role_check', () =>
      db.update(server).set({ role: 'other' }).where(eq(server.id, srv.id))
    )
    await db.update(server).set({ role: 'witness' }).where(eq(server.id, srv.id))

    // Host devices.
    const device = { serverId: srv.id, kind: 'serial', path: '/dev/serial/by-id/usb-x' }
    const [dev] = await db
      .insert(peripheral)
      .values({ ...device, serviceId })
      .returning({ id: peripheral.id })
    await refuses('peripheral_path_check', () =>
      db.insert(peripheral).values({ ...device, path: '/etc/passwd' })
    )
    await refuses('peripheral_path_check', () =>
      db.insert(peripheral).values({ ...device, path: '/dev/../etc' })
    )
    await refuses('peripheral_vendor_id_check', () =>
      db.insert(peripheral).values({ ...device, path: '/dev/a', vendorId: 'ABCD' })
    )
    await refuses('peripheral_kind_check', () =>
      db.insert(peripheral).values({ ...device, path: '/dev/b', kind: 'toaster' })
    )
    await refuses('uniq_peripheral_server_path', () => db.insert(peripheral).values(device))
    await db.delete(service).where(eq(service.id, serviceId))
    const [kept] = await db.select().from(peripheral).where(eq(peripheral.id, dev!.id))
    assertEquals(kept?.serviceId, null)

    // Site sign-ins (need a service, so make a second one).
    const [svc2] = await db
      .insert(service)
      .values({ environmentId: env!.id, composeServiceName: 'site', slug: 'site' })
      .returning({ id: service.id })
    const goodHash = bcryptShaped('$2y$10$')
    await db.insert(visitor).values({ serviceId: svc2!.id, name: 'anna', passwordHash: goodHash })
    await refuses('visitor_password_hash_check', () =>
      db
        .insert(visitor)
        .values({ serviceId: svc2!.id, name: 'bob', passwordHash: bcryptShaped('$2b$10$') })
    )
    await refuses('visitor_name_check', () =>
      db.insert(visitor).values({ serviceId: svc2!.id, name: 'a:b', passwordHash: goodHash })
    )
    await refuses('uniq_visitor_service_name', () =>
      db.insert(visitor).values({ serviceId: svc2!.id, name: 'anna', passwordHash: goodHash })
    )

    // File sync on a placement.
    const username = `gw_${crypto.randomUUID().slice(0, 8).replaceAll('-', '')}`
    const [owner] = await db
      .insert(principal)
      .values({ organizationId, username, appliedUsername: username })
      .returning({ id: principal.id })
    const placement = {
      principalId: owner!.id,
      serverId: srv.id,
      state: 'present',
      home: '/srv/gw',
      source: 'compose',
    }
    const deviceId = `${'ABCDEFG-'.repeat(7)}ABCDEFG`
    await refuses('placement_sync_port_check', () =>
      db.insert(principalPlacement).values({ ...placement, syncPort: 1023 })
    )
    await refuses('placement_sync_device_id_check', () =>
      db.insert(principalPlacement).values({ ...placement, syncDeviceId: deviceId.toLowerCase() })
    )
    await db
      .insert(principalPlacement)
      .values({ ...placement, syncPort: 22000, syncDeviceId: deviceId })
    const username2 = `${username}b`
    const [owner2] = await db
      .insert(principal)
      .values({ organizationId, username: username2, appliedUsername: username2 })
      .returning({ id: principal.id })
    await refuses('uniq_placement_server_sync_port', () =>
      db
        .insert(principalPlacement)
        .values({ ...placement, principalId: owner2!.id, syncPort: 22000 })
    )
    // The same port on another server is fine.
    await db
      .insert(principalPlacement)
      .values({ ...placement, principalId: owner2!.id, serverId: srv2.id, syncPort: 22000 })

    // Control plane channels and the all-organizations switch.
    const channel = { kind: 'webhook', label: 'gw', address: 'x' }
    await refuses('channel_all_organizations_check', () =>
      db.insert(notificationChannel).values({
        ...channel,
        scope: 'organization',
        organizationId,
        isAllOrganizationsNotified: true,
      })
    )
    const [ch] = await db
      .insert(notificationChannel)
      .values({ ...channel, scope: 'instance', isAllOrganizationsNotified: true })
      .returning({ id: notificationChannel.id })
    await db.delete(notificationChannel).where(eq(notificationChannel.id, ch!.id))

    // DNS records and the deferrable carrier key.
    const [car] = await db
      .insert(carrier)
      .values({ organizationId, provider: 'cloudflare', name: 'Main', externalAccountId: 'acct' })
      .returning({ id: carrier.id })
    const rec = {
      organizationId,
      carrierId: car!.id,
      name: 'a.example.com',
      kind: 'A',
      provider: 'cloudflare',
      zoneId: 'z1',
      content: '192.0.2.1',
    }
    await refuses('record_account_check', () =>
      db.insert(dnsRecord).values({ ...rec, carrierId: null })
    )
    await refuses('record_scope_check', () =>
      db.insert(dnsRecord).values({ ...rec, organizationId: null })
    )
    await refuses('record_name_check', () =>
      db.insert(dnsRecord).values({ ...rec, name: 'A.Example.com' })
    )
    await refuses('record_ttl_check', () => db.insert(dnsRecord).values({ ...rec, ttl: 0 }))
    await db.insert(dnsRecord).values(rec)
    await refuses('uniq_record_scope_name_kind_content', () => db.insert(dnsRecord).values(rec))
    // A carrier that still has a record cannot go; the key is checked at commit.
    await refuses('record_carrier_id_carrier_id_fk', () =>
      db.delete(carrier).where(eq(carrier.id, car!.id))
    )
    // The default of a new row: origin columns are covered by their column defaults.
    const defaults = await db.execute(
      sql`select table_name, column_default from information_schema.columns
          where column_name = 'origin' and table_name in ('backup', 'archive')
          order by table_name`
    )
    const rows = (
      Array.isArray(defaults) ? defaults : ((defaults as { rows?: unknown[] }).rows ?? [])
    ) as { table_name: string; column_default: string }[]
    assertEquals(
      rows.map((r) => [r.table_name, r.column_default]),
      [
        ['archive', "'backup'::text"],
        ['backup', "'backup'::text"],
      ]
    )
  } finally {
    // An organization delete removes the carrier and its records in one commit.
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})
