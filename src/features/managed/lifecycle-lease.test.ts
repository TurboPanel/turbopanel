/**
 * The managed lifecycle lease against a real Postgres: one holder at a time,
 * an expired lease can be taken over, and a former holder's release never
 * removes the new holder's row. Skipped without TURBOPANEL_DATABASE_URL, the
 * way every Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { lease, organization } from '../../db/schema.ts'
import {
  MANAGED_LIFECYCLE_LEASE_MS,
  releaseManagedLifecycleLease,
  tryTakeManagedLifecycleLease,
} from './lifecycle-lease.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Rig = {
  db: ReturnType<typeof createDenoDb>
  params: { organizationId: string; managedId: string }
  owners: () => Promise<string[]>
}

async function withLeaseRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('managed lifecycle lease tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Lifecycle Lease Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    await fn({
      db,
      params: { organizationId, managedId: crypto.randomUUID() },
      owners: async () => {
        const rows = await db
          .select({ owner: lease.owner })
          .from(lease)
          .where(eq(lease.organizationId, organizationId))
        return rows.map((row) => row.owner)
      },
    })
  } finally {
    // The lease rows go with the organization (cascade).
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

test('a second take while the lease is held is refused, and a release frees it', async () => {
  await withLeaseRig(async ({ db, params, owners }) => {
    const first = await tryTakeManagedLifecycleLease(db, params)
    assert(first)
    assertEquals(await tryTakeManagedLifecycleLease(db, params), null)
    assertEquals(await owners(), [first.owner])

    // Another database's lease is its own.
    const other = await tryTakeManagedLifecycleLease(db, {
      ...params,
      managedId: crypto.randomUUID(),
    })
    assert(other)
    await releaseManagedLifecycleLease(db, other)

    await releaseManagedLifecycleLease(db, first)
    assertEquals(await owners(), [])
    const next = await tryTakeManagedLifecycleLease(db, params)
    assert(next)
    assertNotEquals(next.owner, first.owner)
  })
})

test('an expired lease is taken over, and its former holder cannot release the new one', async () => {
  await withLeaseRig(async ({ db, params, owners }) => {
    // Taken long enough ago that its time has run out.
    const stale = await tryTakeManagedLifecycleLease(
      db,
      params,
      Date.now() - 2 * MANAGED_LIFECYCLE_LEASE_MS
    )
    assert(stale)
    const fresh = await tryTakeManagedLifecycleLease(db, params)
    assert(fresh)
    assertNotEquals(fresh.owner, stale.owner)
    assertEquals(await owners(), [fresh.owner])

    // The crashed holder finally gets to its release: the new row stays.
    await releaseManagedLifecycleLease(db, stale)
    assertEquals(await owners(), [fresh.owner])
    assertEquals(await tryTakeManagedLifecycleLease(db, params), null)
  })
})
