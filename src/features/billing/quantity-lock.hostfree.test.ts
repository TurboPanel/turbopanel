/**
 * The org-scoped quantity lease over an in-memory `lease` row — same shape
 * as `src/admin/reencrypt-secrets.hostfree.test.ts`.
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import { lease } from '../../db/schema.ts'
import { createMemoryDb, type MemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  BILLING_QUANTITY_LEASE_MS,
  BILLING_QUANTITY_LOCK_NAME,
  endQuantityMutation,
  resetBillingQuantityLockForTests,
  tryBeginQuantityMutation,
} from './quantity-lock.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_A = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const ORG_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const NOW = '2026-01-01T00:00:00.000Z'

type LeaseRow = { organizationId: string; owner: string; expiresAt: string }

function leaseDb(rows: LeaseRow[] = []): MemoryDb {
  return createMemoryDb([
    [lease, rows.map((row, i) => ({
      id: `lease-${i}`,
      name: BILLING_QUANTITY_LOCK_NAME,
      organizationId: row.organizationId,
      owner: row.owner,
      expiresAt: row.expiresAt,
      createdAt: NOW,
      updatedAt: NOW,
    }))],
  ])
}

function rowForOrg(db: MemoryDb, organizationId: string) {
  return db.rows(lease).find((row) => row.organizationId === organizationId)
}

test('acquire writes a lease row keyed by organization, release deletes it', async () => {
  const db = leaseDb()
  const lock = await tryBeginQuantityMutation(db, ORG_A)
  assertNotEquals(lock, null)
  assertEquals(lock?.organizationId, ORG_A)
  const row = rowForOrg(db, ORG_A)
  assertEquals(row?.owner, lock?.owner)
  assertEquals(
    Date.parse(row?.expiresAt as string) > Date.now() + BILLING_QUANTITY_LEASE_MS - 5_000,
    true,
  )
  await endQuantityMutation(db, lock!)
  assertEquals(rowForOrg(db, ORG_A), undefined)
})

test('a second caller for the same organization is refused while the lease is live', async () => {
  const db = leaseDb()
  const first = await tryBeginQuantityMutation(db, ORG_A)
  assertNotEquals(first, null)
  assertEquals(await tryBeginQuantityMutation(db, ORG_A), null)
  // A different organization is a different lease entirely.
  const other = await tryBeginQuantityMutation(db, ORG_B)
  assertNotEquals(other, null)
  assertEquals(db.rows(lease).length, 2)
})

test('an expired lease is stolen; a live one is not', async () => {
  const past = new Date(Date.now() - 1_000).toISOString()
  const db = leaseDb([{ organizationId: ORG_A, owner: 'crashed-holder', expiresAt: past }])
  const stolen = await tryBeginQuantityMutation(db, ORG_A)
  assertNotEquals(stolen, null)
  assertNotEquals(stolen?.owner, 'crashed-holder')
  assertEquals(rowForOrg(db, ORG_A)?.owner, stolen?.owner)

  // Now live again: nobody else gets it.
  assertEquals(await tryBeginQuantityMutation(db, ORG_A), null)
})

test('a malformed expiresAt counts as expired', async () => {
  const db = leaseDb([{ organizationId: ORG_A, owner: 'x', expiresAt: 'not-a-date' }])
  assertNotEquals(await tryBeginQuantityMutation(db, ORG_A), null)
})

test('release is owner-scoped: a former holder cannot release a stolen lease', async () => {
  const past = new Date(Date.now() - 1_000).toISOString()
  const db = leaseDb([{ organizationId: ORG_A, owner: 'former', expiresAt: past }])
  const thief = await tryBeginQuantityMutation(db, ORG_A)
  assertNotEquals(thief, null)

  await endQuantityMutation(db, { organizationId: ORG_A, owner: 'former' })
  // Still held by the thief.
  assertEquals(rowForOrg(db, ORG_A)?.owner, thief?.owner)

  await endQuantityMutation(db, thief!)
  assertEquals(rowForOrg(db, ORG_A), undefined)
})

test('the test reset drops one organization\'s row and tolerates no db', async () => {
  const db = leaseDb([
    { organizationId: ORG_A, owner: 'a', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    { organizationId: ORG_B, owner: 'b', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  ])
  await resetBillingQuantityLockForTests(undefined, ORG_A)
  assertEquals(db.rows(lease).length, 2)
  await resetBillingQuantityLockForTests(db, ORG_A)
  assertEquals(db.rows(lease).map((row) => row.organizationId), [ORG_B])
})
