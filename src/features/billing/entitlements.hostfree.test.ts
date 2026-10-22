/**
 * Entitlement sync: landed intents are dropped, the managers' assignment is
 * read against the committed seats but never changed (no server's license
 * tier is assigned, moved or released by a seat change), an ended
 * subscription revokes every license and leaves each server's tier as its
 * managers set it, and a held lease makes the sync yield to the holder.
 */

import { assertEquals } from '@std/assert'
import { isNull } from 'drizzle-orm'
import {
  allowance,
  key,
  lease,
  license,
  payer,
  server,
  setting,
  subscription,
  subscriptionItem,
  tier,
} from '../../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { syncEntitlementsForOrganization } from './entitlements.ts'
import {
  billingPendingChangesKey,
  newDeferredIntent,
  PENDING_CHANGES_LEDGER_VERSION,
  readPendingChanges,
} from './pending-changes.ts'
import { BILLING_QUANTITY_LEASE_MS, tryBeginQuantityMutation } from './quantity-lock.ts'

const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const PAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const S1 = '11111111-1111-4111-8111-111111111111'
const S3 = '33333333-3333-4333-8333-333333333333'
const SERVER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SERVER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const NOW = '2026-09-07T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const GIB = 1024 ** 3

const tierRow = (id: string, label: string, rank: number) => ({
  id,
  createdAt: NOW,
  updatedAt: NOW,
  label,
  rank,
  provider: 'stripe',
  providerProductId: `prod_${label}`,
  priceCents: 1000 * rank,
  currency: 'usd',
  isCustom: false,
  isActive: true,
})
const hardware = (cores: number) => ({
  resources: { cpus: [{ cores: { total: cores } }], memory: { totalBytes: 8 * GIB } },
})

function seed(opts: {
  seats: { tierId: string; quantity: number }[]
  status?: string
  currentPeriodEnd?: string | null
  ledger?: unknown
  /** The tier a manager gave each server; defaults to both on S1. */
  assigned?: { a: string | null; b: string | null }
}) {
  const assigned = opts.assigned ?? { a: S1, b: S1 }
  return createMemoryDb(
    [
      [tier, [tierRow(S1, 'S1', 1), tierRow(S3, 'S3', 3)]],
      [
        payer,
        [
          {
            id: PAYER,
            organizationId: ORG,
            userId: null,
            provider: 'stripe',
            providerCustomerId: 'cus_1',
            taxId: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      ],
      [
        subscription,
        [
          {
            id: SUB,
            payerId: PAYER,
            providerSubscriptionId: 'sub_1',
            status: opts.status ?? 'active',
            currentPeriodEnd: opts.currentPeriodEnd ?? '2026-10-01T00:00:00.000Z',
            scheduleId: null,
            graceExpiresAt: null,
            pastDueSince: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      ],
      [
        subscriptionItem,
        opts.seats.map((seat, index) => ({
          id: `seat-${index}`,
          subscriptionId: SUB,
          tierId: seat.tierId,
          providerItemId: `si_${index}`,
          providerPriceId: `price_${index}`,
          quantity: seat.quantity,
          createdAt: NOW,
          updatedAt: NOW,
        })),
      ],
      [
        server,
        [
          {
            id: SERVER_A,
            organizationId: ORG,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: NOW,
            metadata: hardware(2),
            assignedTierId: assigned.a,
          },
          {
            id: SERVER_B,
            organizationId: ORG,
            createdAt: '2026-09-02T00:00:00.000Z',
            updatedAt: NOW,
            metadata: hardware(12),
            assignedTierId: assigned.b,
          },
        ],
      ],
      [
        license,
        [
          {
            id: 'l-a',
            organizationId: ORG,
            serverId: SERVER_A,
            name: null,
            token: 'x',
            revokedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: 'l-b',
            organizationId: ORG,
            serverId: SERVER_B,
            name: null,
            token: 'x',
            revokedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: 'l-free',
            organizationId: ORG,
            serverId: null,
            name: null,
            token: 'x',
            revokedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      ],
      [
        setting,
        opts.ledger
          ? [
              {
                id: 'set-1',
                key: billingPendingChangesKey(ORG),
                value: opts.ledger,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ]
          : [],
      ],
      [allowance, []],
      [key, []],
      [lease, []],
    ],
    { fallback: { execute: () => Promise.resolve([]) } as never }
  )
}

async function assignments(db: ReturnType<typeof seed>) {
  const rows = await db
    .select({ id: server.id, assignedTierId: server.assignedTierId })
    .from(server)
  return Object.fromEntries(rows.map((row) => [row.id, row.assignedTierId]))
}

test('a live subscription: the sync reads the assignment and moves no server, even onto a free bigger seat', async () => {
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
  })
  const outcome = await syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false }
  )
  assertEquals(outcome.action, 'synced')
  if (outcome.action !== 'synced') return
  // B (12 cores) measures S3 but a manager kept it on S1; the free S3 seat
  // is not handed to it. Both stay where their managers put them.
  assertEquals(await assignments(db), { [SERVER_A]: S1, [SERVER_B]: S1 })
  // Two servers on one S1 seat: the newer one is reported, not moved.
  assertEquals(outcome.result.assignment.uncovered, [SERVER_B])
  assertEquals(outcome.result.assignment.spare.get(S3), 1)
  assertEquals(
    db.ops.some((op) => op.startsWith('update:server')),
    false
  )
  assertEquals(outcome.result.revokedLicenseIds, [])
  assertEquals(outcome.scheduleRebuilt, false)
})

test('a seat count change — buying a bigger tier, then reducing a tier — never moves a license between servers', async () => {
  const db = seed({ seats: [{ tierId: S1, quantity: 2 }], assigned: { a: S1, b: null } })
  const sync = async () => {
    const outcome = await syncEntitlementsForOrganization(
      { db, client: null, nowMs: NOW_MS },
      { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false }
    )
    assertEquals(outcome.action, 'synced')
    if (outcome.action !== 'synced') throw new Error('not synced')
    return outcome.result.assignment
  }
  let assignment = await sync()
  assertEquals(await assignments(db), { [SERVER_A]: S1, [SERVER_B]: null })
  assertEquals(assignment.uncovered, [SERVER_B])

  // Buy an S3: B (no tier yet) is not given it, A is not lifted onto it.
  db.rows(subscriptionItem).push({
    id: 'seat-s3',
    subscriptionId: SUB,
    tierId: S3,
    providerItemId: 'si_s3',
    providerPriceId: 'price_s3',
    quantity: 1,
    createdAt: NOW,
    updatedAt: NOW,
  })
  assignment = await sync()
  assertEquals(await assignments(db), { [SERVER_A]: S1, [SERVER_B]: null })
  assertEquals(assignment.spare.get(S3), 1)
  assertEquals(assignment.uncovered, [SERVER_B])

  // Reduce S1 to zero: A keeps S1 (reported uncovered), it is not moved to the free S3.
  db.rows(subscriptionItem).find((row) => row.tierId === S1)!.quantity = 0
  assignment = await sync()
  assertEquals(await assignments(db), { [SERVER_A]: S1, [SERVER_B]: null })
  assertEquals(assignment.uncovered, [SERVER_A, SERVER_B])
  assertEquals(
    db.ops.some((op) => op.startsWith('update:server')),
    false
  )
})

test('a landed intent is dropped from the ledger; an outstanding one survives', async () => {
  const landed = newDeferredIntent('release-seat', {
    fromTierId: S3,
    toTierId: null,
    landsAt: '2026-09-01T00:00:00.000Z',
    fromQuantity: 2,
    nowMs: NOW_MS,
  })
  const parked = newDeferredIntent('release-seat', {
    fromTierId: S1,
    toTierId: null,
    landsAt: '2026-10-01T00:00:00.000Z',
    fromQuantity: 1,
    nowMs: NOW_MS,
  })
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
    ledger: {
      version: PENDING_CHANGES_LEDGER_VERSION,
      providerSubscriptionId: 'sub_1',
      intents: [landed, parked],
    },
  })
  const outcome = await syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false }
  )
  assertEquals(outcome.action, 'synced')
  if (outcome.action !== 'synced') return
  assertEquals(outcome.result.landedIntentIds, [landed.id])
  const { ledger } = await readPendingChanges(db, ORG, 'sub_1')
  assertEquals(
    ledger.intents.map((intent) => intent.id),
    [parked.id]
  )
})

function landedDowngrade(serverId: string) {
  return newDeferredIntent('downgrade', {
    fromTierId: S3,
    toTierId: S1,
    landsAt: '2026-09-01T00:00:00.000Z',
    fromQuantity: 2,
    serverId,
    nowMs: NOW_MS,
  })
}

function ledgerOf(...intents: unknown[]) {
  return { version: PENDING_CHANGES_LEDGER_VERSION, providerSubscriptionId: 'sub_1', intents }
}

const syncNow = (db: ReturnType<typeof seed>) =>
  syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false }
  )

test('a landed downgrade that names a server moves only that server to the lower tier', async () => {
  const intent = landedDowngrade(SERVER_B)
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
    assigned: { a: S3, b: S3 },
    ledger: ledgerOf(intent),
  })
  const outcome = await syncNow(db)
  assertEquals(outcome.action, 'synced')
  if (outcome.action !== 'synced') return
  assertEquals(outcome.result.landedIntentIds, [intent.id])
  assertEquals(await assignments(db), { [SERVER_A]: S3, [SERVER_B]: S1 })
  assertEquals(db.ops.filter((op) => op === 'update:server').length, 1)
})

test('a landed named downgrade leaves the server alone when a manager already moved it off the old tier', async () => {
  const db = seed({
    seats: [{ tierId: S1, quantity: 2 }],
    // B was put on S1 by hand before the boundary; A still holds S3.
    assigned: { a: S3, b: S1 },
    ledger: ledgerOf(landedDowngrade(SERVER_B)),
  })
  const outcome = await syncNow(db)
  assertEquals(outcome.action, 'synced')
  assertEquals(await assignments(db), { [SERVER_A]: S3, [SERVER_B]: S1 })
  // The guarded write matched no row: neither server was touched.
  assertEquals(
    db.rows(server).map((row) => row.updatedAt),
    [NOW, NOW]
  )
})

test('a named downgrade does not move its server once the subscription has ended', async () => {
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
    status: 'canceled',
    assigned: { a: S3, b: S3 },
    ledger: ledgerOf(landedDowngrade(SERVER_B)),
  })
  const outcome = await syncNow(db)
  assertEquals(outcome.action, 'synced')
  assertEquals(await assignments(db), { [SERVER_A]: S3, [SERVER_B]: S3 })
})

test('an ended subscription revokes every license, bound ones included, and leaves every server on the tier its managers set', async () => {
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
    status: 'canceled',
  })
  const disconnected: string[] = []
  const outcome = await syncEntitlementsForOrganization(
    {
      db,
      client: null,
      nowMs: NOW_MS,
      onRevokeBound: (serverId) => {
        disconnected.push(serverId)
        return Promise.resolve()
      },
    },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false }
  )
  assertEquals(outcome.action, 'synced')
  if (outcome.action !== 'synced') return
  assertEquals(outcome.result.revokedLicenseIds.sort(), ['l-a', 'l-b', 'l-free'])
  assertEquals(outcome.result.disconnectedServerIds.sort(), [SERVER_A, SERVER_B])
  assertEquals(disconnected.sort(), [SERVER_A, SERVER_B])
  assertEquals(await assignments(db), { [SERVER_A]: S1, [SERVER_B]: S1 })
  const active = await db.select({ id: license.id }).from(license).where(isNull(license.revokedAt))
  assertEquals(active.length, 0)
})

test('a held lease makes the sync yield to the holder without writing', async () => {
  const db = seed({ seats: [{ tierId: S3, quantity: 1 }] })
  const lock = await tryBeginQuantityMutation(db, ORG, NOW_MS)
  assertEquals(lock !== null, true)
  const outcome = await syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS, leaseRetry: { attempts: 1, delayMs: 0 } },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false }
  )
  assertEquals(outcome, { action: 'skipped', reason: 'lease_held' })
  assertEquals(await assignments(db), { [SERVER_A]: S1, [SERVER_B]: S1 })
})

test('a lease that lapses between attempts is taken on the retry', async () => {
  const db = seed({ seats: [{ tierId: S3, quantity: 1 }] })
  // Held until NOW_MS + 1: the first attempt (at NOW_MS) sees it held, the
  // second (at NOW_MS + 2) sees it expired, after one delay in between.
  const lock = await tryBeginQuantityMutation(db, ORG, NOW_MS - BILLING_QUANTITY_LEASE_MS + 1)
  assertEquals(lock !== null, true)
  const outcome = await syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS, leaseRetry: { attempts: 3, delayMs: 2 } },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false }
  )
  assertEquals(outcome.action, 'synced')
})

test('a lease that stays held is given up on after the configured attempts', async () => {
  const db = seed({ seats: [{ tierId: S3, quantity: 1 }] })
  const lock = await tryBeginQuantityMutation(db, ORG, NOW_MS)
  assertEquals(lock !== null, true)
  const started = performance.now()
  const outcome = await syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS, leaseRetry: { attempts: 3, delayMs: 15 } },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false }
  )
  assertEquals(outcome, { action: 'skipped', reason: 'lease_held' })
  // Two waits between three attempts, none after the last.
  // Timers may fire a little early, so only a loose lower bound is asserted.
  assertEquals(performance.now() - started >= 20, true)
  assertEquals(await assignments(db), { [SERVER_A]: S1, [SERVER_B]: S1 })
})
