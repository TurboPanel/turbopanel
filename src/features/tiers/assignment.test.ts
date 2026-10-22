/**
 * The assignment, read: each server holds exactly the tier a manager gave it.
 * Hardware never changes that; the read only reports spare seats and the
 * servers no purchase covers, and the coverage gate names the first server
 * a reduction would leave holding a tier nobody pays for.
 */

import { assertEquals, assertThrows } from '@std/assert'
import {
  applyTierDeltas,
  type AssignableServer,
  coverageLoss,
  effectiveRequiredRank,
  freeAtTier,
  readAssignment,
  sortByBindOrder,
  type TierQuantity,
} from './assignment.ts'
import { ENTRY_TIER_RANK } from './ladder.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const S1 = 'tier-s1'
const S2 = 'tier-s2'
const S3 = 'tier-s3'
const S5 = 'tier-s5'
const RANK = new Map([
  [S1, 1],
  [S2, 2],
  [S3, 3],
  [S5, 5],
])
const rankOf = (tierId: string) => RANK.get(tierId)

const purchased = (s1: number, s3: number, s5: number): TierQuantity[] => [
  { tierId: S5, rank: 5, quantity: s5 },
  { tierId: S1, rank: 1, quantity: s1 },
  { tierId: S3, rank: 3, quantity: s3 },
]

const server = (
  serverId: string,
  assignedTierId: string | null,
  boundAt: string,
  requiredRank: number | null = null
): AssignableServer => ({ serverId, assignedTierId, requiredRank, boundAt })

test('each server holds exactly the tier a manager assigned; unassigned servers hold none', () => {
  const result = readAssignment(purchased(1, 1, 1), [
    server('small', S3, '2026-09-01T00:00:00.000Z', 1),
    server('fresh', null, '2026-09-02T00:00:00.000Z'),
  ])
  assertEquals(
    [...result.byServer],
    [
      ['small', S3],
      ['fresh', null],
    ]
  )
  // A server on a bigger tier than it needs is not moved down; the unused
  // seats stay spare for a manager to give out.
  assertEquals(
    [...result.spare].sort(),
    [
      [S1, 1],
      [S3, 0],
      [S5, 1],
    ].sort()
  )
  assertEquals(result.uncovered, ['fresh'])
})

test('a server kept on S1 while it measures S2 stays on S1; hardware never moves it', () => {
  const quantities: TierQuantity[] = [
    { tierId: S1, rank: 1, quantity: 1 },
    { tierId: S2, rank: 2, quantity: 1 },
  ]
  const kept = readAssignment(quantities, [server('kept', S1, '2026-09-01T00:00:00.000Z', 2)])
  assertEquals(kept.byServer.get('kept'), S1)
  assertEquals(kept.uncovered, [])
  // The free S2 seat is not taken on its behalf.
  assertEquals(kept.spare.get(S2), 1)
  // Smaller hardware does not move it down either.
  const shrunk = readAssignment(quantities, [server('kept', S2, '2026-09-01T00:00:00.000Z', 1)])
  assertEquals(shrunk.byServer.get('kept'), S2)
  assertEquals(shrunk.spare.get(S1), 1)
})

test('more holders than seats: the newest holders are uncovered and keep their tier', () => {
  const result = readAssignment(purchased(1, 0, 0), [
    server('young', S1, '2026-09-02T00:00:00.000Z'),
    server('old', S1, '2026-09-01T00:00:00.000Z'),
    server('gone', S3, '2026-09-03T00:00:00.000Z'),
  ])
  assertEquals(result.uncovered, ['young', 'gone'])
  assertEquals(result.byServer.get('young'), S1)
  assertEquals(result.byServer.get('gone'), S3)
  assertEquals(result.spare.get(S1), 0)
  // Nothing bought: every server uncovered in bind order, each keeping its tier.
  const none = readAssignment(
    [],
    [server('b', S1, '2026-09-02T00:00:00.000Z'), server('a', null, '2026-09-01T00:00:00.000Z')]
  )
  assertEquals(none.uncovered, ['a', 'b'])
  assertEquals(none.byServer.get('b'), S1)
  assertEquals(none.spare.size, 0)
})

test('zero-quantity tiers are left out of the spare map', () => {
  const result = readAssignment(purchased(0, 2, 0), [server('a', S3, '2026-09-01T00:00:00.000Z')])
  assertEquals([...result.spare], [[S3, 1]])
})

test('freeAtTier counts seats at one tier that no other server holds', () => {
  const servers = [
    server('a', S3, '2026-09-01T00:00:00.000Z'),
    server('b', S3, '2026-09-02T00:00:00.000Z'),
  ]
  assertEquals(freeAtTier(purchased(0, 2, 0), servers, S3), 0)
  // The server asking is not counted against itself.
  assertEquals(freeAtTier(purchased(0, 2, 0), servers, S3, 'a'), 1)
  assertEquals(freeAtTier(purchased(0, 2, 1), servers, S5), 1)
  assertEquals(freeAtTier(purchased(0, 1, 0), servers, S3), -1)
})

test('coverageLoss names the first server, in bind order, that the proposed mix would newly leave uncovered', () => {
  const servers = [
    server('a', S1, '2026-09-01T00:00:00.000Z'),
    server('b', S3, '2026-09-02T00:00:00.000Z'),
    server('c', S3, '2026-09-03T00:00:00.000Z'),
  ]
  // Dropping one S3 leaves the younger S3 holder over, not the older one.
  assertEquals(coverageLoss(purchased(1, 2, 0), purchased(1, 1, 0), servers), {
    serverId: 'c',
    requiredRank: 3,
  })
  // Dropping both S3 names b first.
  assertEquals(coverageLoss(purchased(1, 2, 0), purchased(1, 0, 0), servers), {
    serverId: 'b',
    requiredRank: 3,
  })
  // Swapping a held S3 for an S5 is refused too: nothing moves the server
  // onto the new seat; a manager reassigns it first.
  assertEquals(coverageLoss(purchased(1, 2, 0), purchased(1, 1, 1), servers), {
    serverId: 'c',
    requiredRank: 3,
  })
  // A free seat can go.
  assertEquals(coverageLoss(purchased(2, 2, 0), purchased(1, 2, 0), servers), null)
})

test('coverageLoss is null when nothing changes and ignores servers already uncovered', () => {
  const servers = [
    server('a', S1, '2026-09-01T00:00:00.000Z'),
    server('fresh', null, '2026-09-02T00:00:00.000Z'),
  ]
  assertEquals(coverageLoss(purchased(1, 0, 0), purchased(1, 0, 0), servers), null)
  // `fresh` holds nothing today and still holds nothing: not a loss.
  assertEquals(coverageLoss(purchased(1, 0, 0), purchased(2, 0, 0), servers), null)
  assertEquals(coverageLoss([], [], servers), null)
})

test('sortByBindOrder is oldest first with ties broken on id, so a read is stable', () => {
  const sorted = sortByBindOrder([
    server('b', null, '2026-09-02T00:00:00.000Z'),
    server('z', null, '2026-09-01T00:00:00.000Z'),
    server('a', null, '2026-09-01T00:00:00.000Z'),
  ])
  assertEquals(
    sorted.map((entry) => entry.serverId),
    ['a', 'z', 'b']
  )
})

test('unknown hardware requires the entry rank', () => {
  assertEquals(effectiveRequiredRank({ requiredRank: null }), ENTRY_TIER_RANK)
  assertEquals(effectiveRequiredRank({ requiredRank: 4 }), 4)
})

test('applyTierDeltas adds to existing rows, creates missing ones at rankOf, and refuses a negative result', () => {
  const current = purchased(1, 2, 0)
  const next = applyTierDeltas(
    current,
    new Map([
      [S3, -1],
      [S5, 1],
    ]),
    rankOf
  )
  assertEquals(next, [
    { tierId: S5, rank: 5, quantity: 1 },
    { tierId: S1, rank: 1, quantity: 1 },
    { tierId: S3, rank: 3, quantity: 1 },
  ])
  // The input is not mutated.
  assertEquals(current, purchased(1, 2, 0))
  // A tier not yet held is created from rankOf, even to zero.
  assertEquals(applyTierDeltas([], new Map([[S3, 2]]), rankOf), [
    {
      tierId: S3,
      rank: 3,
      quantity: 2,
    },
  ])
  assertEquals(applyTierDeltas([], new Map([[S3, 0]]), rankOf), [
    {
      tierId: S3,
      rank: 3,
      quantity: 0,
    },
  ])
  assertThrows(() => applyTierDeltas(current, new Map([[S3, -3]]), rankOf), RangeError)
  assertThrows(() => applyTierDeltas([], new Map([['tier-unknown', 1]]), rankOf), TypeError)
  assertThrows(() => applyTierDeltas([], new Map([[S1, -1]]), rankOf), RangeError)
})
