/**
 * The managers' assignment, read and written: reading never writes
 * `server.assigned_tier_id`; a manager's assignment writes only the one
 * server it names and needs a free seat; the self-hosted grant fill only
 * fills empty rows. Hardware → required rank treats an unreported box as
 * unknown.
 */

import { assertEquals } from '@std/assert'
import {
  license,
  organization,
  payer,
  allowance,
  server,
  subscription,
  subscriptionItem,
  tier,
} from '../../db/schema.ts'
import { listSeatsForOrganization } from '../billing/billing-records.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  applyAddServerTierAtEnroll,
  assignServerTier,
  fillSelfHostedGrantTier,
  loadAssignableServers,
  peekOrganizationAssignment,
  requiredRankFromMetadata,
  requiredRankFromResources,
  tierQuantitiesFromState,
} from './assignment-records.ts'
import { loadOrganizationTierSpare, setServerPreferredTier } from './server-preferred-tier.ts'
import { CUSTOM_TIER_LABEL } from './ladder.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const OTHER_ORG = '00000000-0000-4000-8000-000000000000'
const PAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const S1 = '11111111-1111-4111-8111-111111111111'
const S3 = '33333333-3333-4333-8333-333333333333'
const S5 = '55555555-5555-4555-8555-555555555555'
const SX = '88888888-8888-4888-8888-888888888888'
const SERVER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SERVER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SERVER_C = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SERVER_UNLICENSED = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const NOW = '2026-09-07T12:00:00.000Z'
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
const hardware = (cores: number, memoryGib = 8) => ({
  resources: { cpus: [{ cores: { total: cores } }], memory: { totalBytes: memoryGib * GIB } },
})
const serverRow = (
  id: string,
  createdAt: string,
  metadata: unknown,
  assignedTierId: string | null,
  organizationId: string | null = ORG,
  preferredTierId: string | null = null
) => ({
  id,
  organizationId,
  createdAt,
  updatedAt: createdAt,
  metadata,
  assignedTierId,
  preferredTierId,
})
const licenseRow = (
  id: string,
  serverId: string | null,
  revokedAt: string | null = null,
  tierId: string | null = null
) => ({
  id,
  organizationId: ORG,
  serverId,
  name: null,
  token: 'x',
  revokedAt,
  tierId,
  createdAt: NOW,
  updatedAt: NOW,
})

function seed(opts: {
  seats?: { tierId: string; quantity: number }[]
  status?: string
  payer?: boolean
  grantQuantity?: number
  servers?: ReturnType<typeof serverRow>[]
  licenses?: ReturnType<typeof licenseRow>[]
}) {
  const sxRow = {
    ...tierRow(SX, CUSTOM_TIER_LABEL, 8),
    providerProductId: null,
    priceCents: null,
    currency: null,
    isCustom: true,
  }
  const grantRows = opts.grantQuantity
    ? [
        {
          organizationId: ORG,
          tierId: SX,
          quantity: opts.grantQuantity,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]
    : []
  return createMemoryDb(
    [
      [
        organization,
        [
          {
            id: ORG,
            createdAt: NOW,
            updatedAt: NOW,
            metadata: null,
            options: null,
            name: 'Test org',
          },
        ],
      ],
      [tier, [tierRow(S1, 'S1', 1), tierRow(S3, 'S3', 3), tierRow(S5, 'S5', 5), sxRow]],
      [allowance, grantRows],
      [
        payer,
        opts.payer === false
          ? []
          : [
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
            currentPeriodEnd: null,
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
        (opts.seats ?? []).map((seat, index) => ({
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
      [server, opts.servers ?? []],
      [license, opts.licenses ?? []],
    ],
    { fallback: { execute: () => Promise.resolve([]) } as never }
  )
}

test('requiredRankFromResources / Metadata: reported hardware places, unreported hardware is unknown', () => {
  assertEquals(requiredRankFromResources(undefined), null)
  assertEquals(requiredRankFromResources({}), null)
  assertEquals(requiredRankFromResources({ cpus: [{ cores: { total: 0 } }] }), null)
  assertEquals(
    requiredRankFromResources({
      cpus: [{ cores: { total: 4 } }],
      memory: { totalBytes: 16 * GIB },
    }),
    1
  )
  assertEquals(requiredRankFromResources({ cpus: [{ cores: { total: 12 } }] }), 3)
  // RAM alone is enough to know the box; the harder of the two wins.
  assertEquals(requiredRankFromResources({ memory: { totalBytes: 100 * GIB } }), 4)
  assertEquals(requiredRankFromMetadata(hardware(12, 200)), 5)
  assertEquals(requiredRankFromMetadata(null), null)
  assertEquals(requiredRankFromMetadata({ resources: 'nope' }), null)
  assertEquals(requiredRankFromMetadata({ cell: { generation: 1 } }), null)
})

test('tierQuantitiesFromState sums per tier with its rank and reads zero once the subscription ended', async () => {
  const live = seed({
    seats: [
      { tierId: S3, quantity: 2 },
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
  })
  assertEquals(tierQuantitiesFromState(await listSeatsForOrganization(live, ORG)), [
    { tierId: S1, rank: 1, quantity: 1 },
    { tierId: S3, rank: 3, quantity: 3 },
  ])
  const ended = seed({ status: 'canceled', seats: [{ tierId: S3, quantity: 2 }] })
  assertEquals(tierQuantitiesFromState(await listSeatsForOrganization(ended, ORG)), [
    { tierId: S3, rank: 3, quantity: 0 },
  ])
  assertEquals(
    tierQuantitiesFromState({ payer: null, subscription: null, seats: [], grant: null }),
    []
  )
})

test('loadAssignableServers is every licensed server of the organization with its requirement and the tier it holds', async () => {
  const db = seed({
    servers: [
      serverRow(SERVER_B, '2026-09-02T00:00:00.000Z', hardware(12), S3),
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', null, null),
      serverRow(SERVER_UNLICENSED, '2026-09-01T00:00:00.000Z', hardware(2), null),
      serverRow(SERVER_C, '2026-09-03T00:00:00.000Z', hardware(2), null),
      serverRow('other-org', '2026-09-01T00:00:00.000Z', hardware(2), null, OTHER_ORG),
    ],
    licenses: [
      licenseRow('l-a', SERVER_A),
      licenseRow('l-b', SERVER_B),
      // Revoked: the server no longer holds a license.
      licenseRow('l-c', SERVER_C, NOW),
      licenseRow('l-free', null),
    ],
  })
  const rows = await loadAssignableServers(db, ORG)
  assertEquals(
    rows.map((row) => [row.serverId, row.requiredRank, row.boundAt, row.assignedTierId]),
    [
      [SERVER_B, 3, '2026-09-02T00:00:00.000Z', S3],
      [SERVER_A, null, '2026-09-01T00:00:00.000Z', null],
    ]
  )
})

const tierOf = (db: ReturnType<typeof seed>, id: string) =>
  db.rows(server).find((row) => row.id === id)?.assignedTierId ?? null

test("peekOrganizationAssignment reads the managers' assignment and never writes a server", async () => {
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
    servers: [
      // Kept on S1 while it measures S3: stays on S1.
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(12), S1),
      // Enrolled, no tier given yet: stays empty though an S3 seat is free.
      serverRow(SERVER_B, '2026-09-02T00:00:00.000Z', hardware(2), null),
      serverRow(SERVER_UNLICENSED, '2026-09-01T00:00:00.000Z', hardware(2), S5),
    ],
    licenses: [licenseRow('l-a', SERVER_A), licenseRow('l-b', SERVER_B)],
  })
  const assignment = await peekOrganizationAssignment(db, ORG)
  assertEquals(
    [...assignment.byServer],
    [
      [SERVER_A, S1],
      [SERVER_B, null],
    ]
  )
  assertEquals(assignment.uncovered, [SERVER_B])
  assertEquals(assignment.spare.get(S3), 1)
  assertEquals(
    db.ops.filter((op) => !op.startsWith('select:')),
    []
  )
  assertEquals(tierOf(db, SERVER_A), S1)
  assertEquals(tierOf(db, SERVER_B), null)
})

test('an ended subscription reports the server uncovered and leaves its tier alone', async () => {
  const db = seed({
    status: 'canceled',
    seats: [{ tierId: S3, quantity: 2 }],
    servers: [serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(2), S3)],
    licenses: [licenseRow('l-a', SERVER_A)],
  })
  const state = await listSeatsForOrganization(db, ORG)
  const opsBefore = db.ops.length
  const assignment = await peekOrganizationAssignment(db, ORG, { state })
  assertEquals(
    db.ops.slice(opsBefore).filter((op) => op.startsWith('select:')),
    ['select:server']
  )
  assertEquals(assignment.uncovered, [SERVER_A])
  assertEquals(tierOf(db, SERVER_A), S3)
})

test('assignServerTier gives one server a free seat and writes only that server', async () => {
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
    servers: [
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(2), S1),
      serverRow(SERVER_B, '2026-09-02T00:00:00.000Z', hardware(12), null),
    ],
    licenses: [licenseRow('l-a', SERVER_A), licenseRow('l-b', SERVER_B)],
  })
  const result = await assignServerTier(db, ORG, SERVER_B, S3, NOW)
  assertEquals(result.ok, true)
  if (!result.ok) throw new TypeError('expected ok')
  assertEquals(result.assignedTierId, S3)
  assertEquals(result.assignment.uncovered, [])
  assertEquals(db.ops.includes('begin'), true)
  assertEquals(db.ops.includes('commit'), true)
  assertEquals(db.ops.filter((op) => op === 'update:server').length, 1)
  assertEquals(tierOf(db, SERVER_B), S3)
  assertEquals(db.rows(server).find((row) => row.id === SERVER_B)?.preferredTierId, S3)
  // The other server did not move.
  assertEquals(tierOf(db, SERVER_A), S1)
})

test('assignServerTier refuses a tier with no free seat and never takes one from another server', async () => {
  const db = seed({
    seats: [{ tierId: S3, quantity: 1 }],
    servers: [
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(2), S3),
      serverRow(SERVER_B, '2026-09-02T00:00:00.000Z', hardware(12), null),
    ],
    licenses: [licenseRow('l-a', SERVER_A), licenseRow('l-b', SERVER_B)],
  })
  assertEquals(await assignServerTier(db, ORG, SERVER_B, S3, NOW), {
    ok: false,
    code: 'no_free_seat',
  })
  assertEquals(await assignServerTier(db, ORG, SERVER_B, S5, NOW), {
    ok: false,
    code: 'no_free_seat',
  })
  assertEquals(db.ops.filter((op) => op === 'update:server').length, 0)
  assertEquals(tierOf(db, SERVER_A), S3)
  assertEquals(tierOf(db, SERVER_B), null)
  // Re-assigning the tier a server already holds is a no-op success.
  const same = await assignServerTier(db, ORG, SERVER_A, S3, NOW)
  assertEquals(same.ok, true)
})

test('assignServerTier releases a license with null and refuses a server with no active license', async () => {
  const db = seed({
    seats: [{ tierId: S3, quantity: 1 }],
    servers: [
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(2), S3, ORG, S3),
      serverRow(SERVER_C, '2026-09-02T00:00:00.000Z', hardware(2), null),
    ],
    licenses: [licenseRow('l-a', SERVER_A), licenseRow('l-c', SERVER_C, NOW)],
  })
  const released = await assignServerTier(db, ORG, SERVER_A, null, NOW)
  assertEquals(released.ok, true)
  if (!released.ok) throw new TypeError('expected ok')
  assertEquals(released.assignment.spare.get(S3), 1)
  assertEquals(tierOf(db, SERVER_A), null)
  assertEquals(db.rows(server).find((row) => row.id === SERVER_A)?.preferredTierId, null)
  assertEquals(await assignServerTier(db, ORG, SERVER_C, S3, NOW), {
    ok: false,
    code: 'server_not_licensed',
  })
})

test('setServerPreferredTier refuses a tier whose CPU or RAM limit is below the server', async () => {
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
    servers: [
      // 12 cores needs S3 by CPU.
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(12), null),
      // 2 cores but 100 GiB RAM needs S4 by memory.
      serverRow(SERVER_B, '2026-09-02T00:00:00.000Z', hardware(2, 100), null),
    ],
    licenses: [licenseRow('l-a', SERVER_A), licenseRow('l-b', SERVER_B)],
  })
  assertEquals(await setServerPreferredTier(db, ORG, SERVER_A, S1), {
    ok: false,
    code: 'tier_below_required',
  })
  assertEquals(await setServerPreferredTier(db, ORG, SERVER_B, S3), {
    ok: false,
    code: 'tier_below_required',
  })
  assertEquals(db.ops.filter((op) => op === 'update:server').length, 0)
  const ok = await setServerPreferredTier(db, ORG, SERVER_A, S3)
  assertEquals(ok.ok, true)
  assertEquals(tierOf(db, SERVER_A), S3)
  assertEquals((await setServerPreferredTier(db, ORG, SERVER_A, 'no-such-tier')).ok, false)
})

test('setServerPreferredTier lets a manager pick a tier below what monitoring recommends', async () => {
  // Fits S1 by CPU and RAM; GPUs or extra drives would only recommend more.
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 1 },
    ],
    servers: [
      serverRow(
        SERVER_A,
        '2026-09-01T00:00:00.000Z',
        {
          resources: {
            cpus: [{ cores: { total: 2 } }],
            memory: { totalBytes: 8 * GIB },
            gpus: [{ name: 'gpu0' }, { name: 'gpu1' }],
          },
        },
        null
      ),
    ],
    licenses: [licenseRow('l-a', SERVER_A)],
  })
  const result = await setServerPreferredTier(db, ORG, SERVER_A, S1)
  assertEquals(result.ok, true)
  if (!result.ok) throw new TypeError('expected ok')
  assertEquals(result.assignedTierLabel, 'S1')
  assertEquals(
    result.tiersFree.map((row) => [row.label, row.free]),
    [['S3', 1]]
  )
  assertEquals(tierOf(db, SERVER_A), S1)
})

test('setServerPreferredTier allows any tier while the hardware is not reported yet', async () => {
  const db = seed({
    seats: [{ tierId: S1, quantity: 1 }],
    servers: [serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', null, null)],
    licenses: [licenseRow('l-a', SERVER_A)],
  })
  assertEquals((await setServerPreferredTier(db, ORG, SERVER_A, S1)).ok, true)
})

test('fillSelfHostedGrantTier fills only licensed servers with no tier and never changes a held tier', async () => {
  const db = seed({
    payer: false,
    grantQuantity: 3,
    servers: [
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(2), null),
      serverRow(SERVER_B, '2026-09-02T00:00:00.000Z', hardware(2), S1),
      serverRow(SERVER_C, '2026-09-03T00:00:00.000Z', hardware(2), null),
      serverRow(SERVER_UNLICENSED, '2026-09-01T00:00:00.000Z', hardware(2), null),
    ],
    licenses: [
      licenseRow('l-a', SERVER_A),
      licenseRow('l-b', SERVER_B),
      licenseRow('l-c', SERVER_C, NOW),
    ],
  })
  await fillSelfHostedGrantTier(db, ORG)
  assertEquals(tierOf(db, SERVER_A), SX)
  assertEquals(tierOf(db, SERVER_B), S1)
  assertEquals(tierOf(db, SERVER_C), null)
  assertEquals(tierOf(db, SERVER_UNLICENSED), null)
})

test('fillSelfHostedGrantTier with no grant writes nothing', async () => {
  const db = seed({
    payer: false,
    servers: [serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(2), null)],
    licenses: [licenseRow('l-a', SERVER_A)],
  })
  await fillSelfHostedGrantTier(db, ORG)
  assertEquals(tierOf(db, SERVER_A), null)
  assertEquals(db.ops.filter((op) => op === 'update:server').length, 0)
})

const KEY_FREE = '99999999-9999-4999-8999-999999999991'
const KEY_A = '99999999-9999-4999-8999-999999999992'
const KEY_B = '99999999-9999-4999-8999-999999999993'

test('a seat an unused Add Server key holds at its tier is not free for another server', async () => {
  const db = seed({
    seats: [{ tierId: S1, quantity: 1 }],
    servers: [serverRow(SERVER_A, NOW, null, null)],
    licenses: [licenseRow(KEY_A, SERVER_A), licenseRow(KEY_FREE, null, null, S1)],
  })
  assertEquals(await assignServerTier(db, ORG, SERVER_A, S1), {
    ok: false,
    code: 'no_free_seat',
  })
  assertEquals(db.rows(server).find((row) => row.id === SERVER_A)?.assignedTierId, null)
  assertEquals(await loadOrganizationTierSpare(db, ORG), [])
})

test('a revoked or consumed Add Server key holds no seat', async () => {
  const db = seed({
    seats: [{ tierId: S1, quantity: 1 }],
    servers: [serverRow(SERVER_A, NOW, null, null)],
    licenses: [licenseRow(KEY_A, SERVER_A, null, S1), licenseRow(KEY_FREE, null, NOW, S1)],
  })
  assertEquals(await loadOrganizationTierSpare(db, ORG), [{ tierId: S1, label: 'S1', free: 1 }])
  const result = await assignServerTier(db, ORG, SERVER_A, S1)
  assertEquals(result.ok, true)
})

test('at enroll the server takes the seat its key held at the chosen tier, once', async () => {
  // SERVER_A just enrolled with KEY_A (now consumed); KEY_B still holds one S1.
  const db = seed({
    seats: [{ tierId: S1, quantity: 2 }],
    servers: [serverRow(SERVER_A, NOW, hardware(64, 256), null)],
    licenses: [licenseRow(KEY_A, SERVER_A, null, S1), licenseRow(KEY_B, null, null, S1)],
  })
  // The chosen tier is honoured even though the box measures past S1: kept and flagged, never moved.
  assertEquals(await applyAddServerTierAtEnroll(db, ORG, SERVER_A, S1, NOW), 'assigned')
  const row = () => db.rows(server).find((entry) => entry.id === SERVER_A)
  assertEquals([row()?.assignedTierId, row()?.preferredTierId], [S1, S1])
  // A repeat changes nothing, and KEY_B's seat is still held for its own server.
  assertEquals(await applyAddServerTierAtEnroll(db, ORG, SERVER_A, S1, NOW), 'already_set')
  assertEquals(await loadOrganizationTierSpare(db, ORG), [])
})

test('at enroll a chosen tier whose seat is gone leaves the server uncovered with the choice kept', async () => {
  // Seats at S1 were cut to one after the key was minted, and SERVER_B holds it.
  const db = seed({
    seats: [
      { tierId: S1, quantity: 1 },
      { tierId: S3, quantity: 2 },
    ],
    servers: [serverRow(SERVER_A, NOW, null, null), serverRow(SERVER_B, NOW, null, S1)],
    licenses: [licenseRow(KEY_A, SERVER_A, null, S1), licenseRow(KEY_B, SERVER_B)],
  })
  assertEquals(await applyAddServerTierAtEnroll(db, ORG, SERVER_A, S1, NOW), 'no_free_seat')
  const mine = db.rows(server).find((entry) => entry.id === SERVER_A)
  // Never a different tier (S3 is free), never SERVER_B's seat.
  assertEquals([mine?.assignedTierId, mine?.preferredTierId], [null, S1])
  assertEquals(db.rows(server).find((entry) => entry.id === SERVER_B)?.assignedTierId, S1)
})
