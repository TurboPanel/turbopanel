import { eq } from 'drizzle-orm'
import { assertEquals } from 'jsr:@std/assert'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  membership,
  network,
  organization,
  server,
  user,
} from '../../lib/db/schema.ts'
import { resolveEntityById } from './entity-resolver.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveEntityById resolves network entities', async () => {
  const dbUrl = getDatabaseUrl()
  if (!dbUrl) {
    console.warn('Skipping entity-resolver tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const email = `entity-resolver-${crypto.randomUUID()}@example.com`

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Entity Resolver Org' })
    .returning({ id: organization.id })

  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })

  const userId = insertedUser!.id
  await db.insert(membership).values({ organizationId, userId })

  const [insertedServer] = await db
    .insert(server)
    .values({ organizationId, name: 'Net Host' })
    .returning({ id: server.id })

  const serverId = insertedServer!.id

  const [insertedNetwork] = await db
    .insert(network)
    .values({
      organizationId,
      serverId,
      kind: 'docker',
      name: 'Server net',
      options: { dockerNetworkName: 'tp-server-net' },
    })
    .returning({ id: network.id })

  const networkId = insertedNetwork!.id

  try {
    const resolved = await resolveEntityById(db, networkId)
    assertEquals(resolved, {
      entityType: 'network',
      entityId: networkId,
      organizationId,
    })
  } finally {
    await db.delete(network).where(eq(network.id, networkId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(membership).where(eq(membership.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})
