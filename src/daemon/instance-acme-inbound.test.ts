import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../db/connection.ts'
import { instanceHostname, organization, server } from '../db/schema.ts'
import { getDatabaseUrl } from '../db/url.ts'
import { skipWithoutDatabase } from '../test-fixtures/require-service.test.support.ts'
import {
  type InstanceAcmeIssuanceMessage,
  recordInstanceAcmeIssuanceFromServer,
} from './instance-acme-inbound.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Fixture = {
  db: ReturnType<typeof createDenoDb>
  host: string
  hostedServerId: string
  strayServerId: string
}

/**
 * One Let's Encrypt hostname, the server that runs the control plane (its
 * daemon attached over the local socket) and an ordinary fleet server.
 */
async function withInstanceAcmeFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('instance ACME inbound tests')
    return
  }
  const db = createDenoDb()
  const host = `acme-${crypto.randomUUID()}.example.test`
  const [org] = await db
    .insert(organization)
    .values({ name: 'Instance ACME Inbound Test Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [hosted] = await db
    .insert(server)
    .values({ organizationId, daemon: { projection: { remoteAddress: '__direct__' } } })
    .returning({ id: server.id })
  const [stray] = await db.insert(server).values({ organizationId }).returning({ id: server.id })
  await db.insert(instanceHostname).values({ host, source: 'lets-encrypt' })
  try {
    await fn({ db, host, hostedServerId: hosted!.id, strayServerId: stray!.id })
  } finally {
    await db.delete(instanceHostname).where(eq(instanceHostname.host, host))
    await db.delete(server).where(inArray(server.id, [hosted!.id, stray!.id]))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

function issuanceFailure(hostname: string): InstanceAcmeIssuanceMessage {
  return {
    type: 'instance-acme-issuance-event',
    hostname,
    ok: false,
    errorMessage: 'rate limited',
    at: new Date().toISOString(),
  }
}

async function readAcmeError(fixture: Fixture): Promise<string | null | undefined> {
  const [row] = await fixture.db
    .select({ acmeLastError: instanceHostname.acmeLastError })
    .from(instanceHostname)
    .where(eq(instanceHostname.host, fixture.host))
  return row?.acmeLastError
}

test('instance ACME result from a server that does not run the control plane is dropped', async () => {
  await withInstanceAcmeFixture(async (fixture) => {
    const recorded = await recordInstanceAcmeIssuanceFromServer(
      fixture.db,
      fixture.strayServerId,
      issuanceFailure(fixture.host)
    )
    assertEquals(recorded, false)
    assertEquals(await readAcmeError(fixture), null)
  })
})

test('instance ACME result from the server that runs the control plane is recorded', async () => {
  await withInstanceAcmeFixture(async (fixture) => {
    const recorded = await recordInstanceAcmeIssuanceFromServer(
      fixture.db,
      fixture.hostedServerId,
      issuanceFailure(fixture.host)
    )
    assertEquals(recorded, true)
    assertEquals(await readAcmeError(fixture), 'rate limited')
  })
})

test('both daemon inbound paths record instance ACME results only through the server check', async () => {
  for (const path of ['./deno-ws.ts', './cell/do.ts']) {
    const source = await Deno.readTextFile(new URL(path, import.meta.url))
    assertEquals(source.includes('recordInstanceAcmeIssuanceFromServer('), true, path)
    assertEquals(/\brecordInstanceAcmeIssuance\(/.test(source), false, path)
  }
})
