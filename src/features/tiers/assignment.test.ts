/**
 * The derived assignment, pure: servers in bind order each take the
 * smallest purchased tier that fits, unknown hardware needs the entry rank,
 * and the coverage gate names the first server a reduction would strand.
 */

import { assertEquals, assertThrows } from '@std/assert'
import {
  applyTierDeltas,
  type AssignableServer,
  computeAssignment,
  coverageLoss,
  effectiveRequiredRank,
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
const S3 = 'tier-s3'
const S5 = 'tier-s5'
const RANK = new Map([
  [S1, 1],
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
  requiredRank: number | null,
  boundAt: string,
  pick?: { tierId: string; rank: number; label: string }
): AssignableServer => ({
  serverId,
  requiredRank,
  boundAt,
  preferredTierId: pick?.tierId,
  preferredRank: pick?.rank,
  preferredLabel: pick?.label,
})

const S2 = 'tier-s2'

test('each server takes the smallest purchased tier whose rank covers its requirement; the rest is spare', () => {
  const result = computeAssignment(purchased(1, 1, 1), [
    server('a', 3, '2026-09-01T00:00:00.000Z'),
    server('b', 1, '2026-09-02T00:00:00.000Z'),
  ])
  assertEquals(
    [...result.byServer],
    [
      ['a', S3],
      ['b', S1],
    ]
  )
  assertEquals(
    [...result.spare],
    [
      [S1, 0],
      [S3, 0],
      [S5, 1],
    ]
  )
  assertEquals(result.uncovered, [])
})

test('a server is parked on a bigger tier only when the smaller ones are used up or too small', () => {
  // Two rank-1 servers, one S1 and one S5: the second takes the S5 rather than nothing.
  const result = computeAssignment(purchased(1, 0, 1), [
    server('a', 1, '2026-09-01T00:00:00.000Z'),
    server('b', 1, '2026-09-02T00:00:00.000Z'),
  ])
  assertEquals(
    [...result.byServer],
    [
      ['a', S1],
      ['b', S5],
    ]
  )
  // A rank-4 need skips S3 and S1 no matter how many are spare.
  const skipped = computeAssignment(purchased(3, 3, 0), [
    server('big', 4, '2026-09-01T00:00:00.000Z'),
  ])
  assertEquals(skipped.byServer.get('big'), null)
  assertEquals(skipped.uncovered, ['big'])
  assertEquals(
    [...skipped.spare],
    [
      [S1, 3],
      [S3, 3],
    ]
  )
})

test('bind order places incumbents first, so a newcomer never displaces a server that was covered', () => {
  const incumbent = server('old', 3, '2026-09-01T00:00:00.000Z')
  const newcomer = server('new', 3, '2026-09-05T00:00:00.000Z')
  // Order of the input array is irrelevant; boundAt decides.
  const result = computeAssignment(purchased(0, 1, 0), [newcomer, incumbent])
  assertEquals(result.byServer.get('old'), S3)
  assertEquals(result.byServer.get('new'), null)
  assertEquals(result.uncovered, ['new'])
  // Even when the newcomer would fit a smaller tier the incumbent cannot use.
  const spareBelow = computeAssignment(purchased(1, 1, 0), [
    server('old', 3, '2026-09-01T00:00:00.000Z'),
    server('new', 1, '2026-09-05T00:00:00.000Z'),
  ])
  assertEquals(
    [...spareBelow.byServer],
    [
      ['old', S3],
      ['new', S1],
    ]
  )
})

test('sortByBindOrder is oldest first with ties broken on id, so a recompute is stable', () => {
  const sorted = sortByBindOrder([
    server('b', 1, '2026-09-02T00:00:00.000Z'),
    server('z', 1, '2026-09-01T00:00:00.000Z'),
    server('a', 1, '2026-09-01T00:00:00.000Z'),
  ])
  assertEquals(
    sorted.map((entry) => entry.serverId),
    ['a', 'z', 'b']
  )
})

test('unknown hardware requires the entry rank: it needs a tier, and the smallest will do', () => {
  assertEquals(effectiveRequiredRank({ requiredRank: null }), ENTRY_TIER_RANK)
  assertEquals(effectiveRequiredRank({ requiredRank: 4 }), 4)
  const result = computeAssignment(purchased(1, 1, 0), [
    server('known', 3, '2026-09-01T00:00:00.000Z'),
    server('unknown', null, '2026-09-02T00:00:00.000Z'),
  ])
  assertEquals(
    [...result.byServer],
    [
      ['known', S3],
      ['unknown', S1],
    ]
  )
  // With no purchase at all, every server is uncovered in bind order.
  const none = computeAssignment(
    [],
    [server('b', null, '2026-09-02T00:00:00.000Z'), server('a', null, '2026-09-01T00:00:00.000Z')]
  )
  assertEquals(none.uncovered, ['a', 'b'])
  assertEquals([...none.byServer.values()], [null, null])
  assertEquals(none.spare.size, 0)
})

test('zero-quantity tiers are left out of the pool and the spare map', () => {
  const result = computeAssignment(purchased(0, 2, 0), [server('a', 1, '2026-09-01T00:00:00.000Z')])
  assertEquals([...result.spare], [[S3, 1]])
  assertEquals(result.byServer.get('a'), S3)
})

test('coverageLoss names the first server, in bind order, that the proposed mix would newly strand', () => {
  const servers = [
    server('a', 1, '2026-09-01T00:00:00.000Z'),
    server('b', 3, '2026-09-02T00:00:00.000Z'),
    server('c', 3, '2026-09-03T00:00:00.000Z'),
  ]
  // Dropping one S3 strands the younger S3 server, not the older one.
  assertEquals(coverageLoss(purchased(1, 2, 0), purchased(1, 1, 0), servers), {
    serverId: 'c',
    requiredRank: 3,
  })
  // Dropping both S3 strands b first.
  assertEquals(coverageLoss(purchased(1, 2, 0), purchased(1, 0, 0), servers), {
    serverId: 'b',
    requiredRank: 3,
  })
  // An upgrade of one S3 to S5 is safe: the S5 still covers a rank-3 need.
  assertEquals(coverageLoss(purchased(1, 2, 0), purchased(1, 1, 1), servers), null)
  // Unknown hardware reports the entry rank as its requirement.
  assertEquals(
    coverageLoss(purchased(1, 0, 0), purchased(0, 0, 0), [
      server('u', null, '2026-09-01T00:00:00.000Z'),
    ]),
    { serverId: 'u', requiredRank: ENTRY_TIER_RANK }
  )
})

test('coverageLoss is null when nothing changes and ignores servers that were already uncovered', () => {
  const servers = [
    server('a', 1, '2026-09-01T00:00:00.000Z'),
    server('big', 5, '2026-09-02T00:00:00.000Z'),
  ]
  assertEquals(coverageLoss(purchased(1, 0, 0), purchased(1, 0, 0), servers), null)
  // `big` is stranded today and stays stranded: not a loss the proposal causes.
  assertEquals(coverageLoss(purchased(1, 0, 0), purchased(2, 0, 0), servers), null)
  assertEquals(coverageLoss([], [], servers), null)
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

// --- swap pass: spare bigger seats follow the recommended tier ---------------

const R1 = 1
const R2 = 2
const R3 = 3

function swapFleet(rows: ReadonlyArray<readonly [string, number, number]>): AssignableServer[] {
  return rows.map(([serverId, requiredRank, recommendedRank], i) => ({
    serverId,
    requiredRank,
    recommendedRank,
    boundAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
  }))
}

const swapTiers = (s1: number, s2: number, s3 = 0): TierQuantity[] => [
  { tierId: 'S1', rank: R1, quantity: s1 },
  { tierId: 'S2', rank: R2, quantity: s2 },
  { tierId: 'S3', rank: R3, quantity: s3 },
]

const swapRealFleet = () =>
  swapFleet([
    ['adrastea', R1, R2],
    ['kore', R1, R2],
    ['dia', R1, R1],
    ['europa', R1, R1],
    ['workbench', R1, R1],
    ['megaclite', R1, R1],
    ['themisto', R1, R1],
    ['studio', R1, R2],
    ['io', R1, R1],
  ])

test('swap pass: S2 seats go to the servers that recommend S2, not the oldest', () => {
  const servers = swapRealFleet()
  const result = computeAssignment(swapTiers(6, 6), servers)
  assertEquals(result.uncovered, [])
  // Greedy alone would put S1 on the first six and leave S2 on the newest.
  for (const name of ['adrastea', 'kore', 'studio']) {
    assertEquals(result.byServer.get(name), 'S2', name)
  }
  const seats = [...result.byServer.values()]
  assertEquals(seats.filter((t) => t === 'S1').length, 6)
  assertEquals(seats.filter((t) => t === 'S2').length, 3 + 0)
  assertEquals(result.spare.get('S2'), 3)
  // Idempotent and order-independent.
  assertEquals(computeAssignment(swapTiers(6, 6), [...servers].reverse()), result)
})

test('swap pass: surplus S2 seats beyond the recommenders land on the oldest of the rest', () => {
  const result = computeAssignment(swapTiers(0, 9), swapRealFleet())
  assertEquals(
    [...result.byServer.values()].every((t) => t === 'S2'),
    true
  )
  const s1only = computeAssignment(swapTiers(7, 2), swapRealFleet())
  // Two S2 seats, three recommenders. Greedy puts the S2 seats on the two
  // newest (studio, io); adrastea trades with io, and kore finds no donor
  // because the only other bigger seat sits on studio, which recommends it.
  assertEquals(s1only.byServer.get('adrastea'), 'S2')
  assertEquals(s1only.byServer.get('studio'), 'S2')
  assertEquals(s1only.byServer.get('kore'), 'S1')
  assertEquals(s1only.byServer.get('io'), 'S1')
})

test('swap pass: no donor, no swap (every holder of a bigger seat needs it)', () => {
  const servers = swapFleet([
    ['a', R1, R2],
    ['b', R2, R2],
  ])
  const result = computeAssignment(swapTiers(1, 1), servers)
  assertEquals(result.byServer.get('a'), 'S1')
  assertEquals(result.byServer.get('b'), 'S2')
  // A donor whose own recommendation exceeds the lower seat does not give it up.
  const pinned = swapFleet([
    ['a', R1, R2],
    ['b', R1, R2],
  ])
  const same = computeAssignment(swapTiers(1, 1), pinned)
  assertEquals(same.byServer.get('a'), 'S1')
  assertEquals(same.byServer.get('b'), 'S2')
})

test('swap pass never lowers coverage or places a server under its required tier', () => {
  const servers = swapFleet([
    ['a', R1, R3],
    ['b', R2, R2],
    ['c', R1, R1],
    ['d', R3, R3],
  ])
  const plain = computeAssignment(
    swapTiers(1, 1, 2),
    servers.map((s) => ({ ...s, recommendedRank: null }))
  )
  const swapped = computeAssignment(swapTiers(1, 1, 2), servers)
  assertEquals(swapped.uncovered, plain.uncovered)
  const rankOf = new Map([
    ['S1', R1],
    ['S2', R2],
    ['S3', R3],
  ])
  for (const s of servers) {
    const tier = swapped.byServer.get(s.serverId)
    if (tier) {
      assertEquals(rankOf.get(tier)! >= s.requiredRank!, true, s.serverId)
    }
  }
  // a (recommends S3) swaps with c (needs and recommends S1).
  assertEquals(swapped.byServer.get('a'), 'S3')
  assertEquals(swapped.byServer.get('c'), 'S1')
  assertEquals(swapped.byServer.get('d'), 'S3')
})

test('preferred tier takes a spare S2 seat before the derived S1 when both fit', () => {
  const result = computeAssignment(
    [
      { tierId: S1, rank: 1, quantity: 2 },
      { tierId: S2, rank: 2, quantity: 1 },
    ],
    [server('a', 1, '2026-09-01T00:00:00.000Z', { tierId: S2, rank: 2, label: 'S2' })]
  )
  assertEquals(result.byServer.get('a'), S2)
  assertEquals(result.pickUnfulfilled.size, 0)
})

test('preferred tier falls back to derived when no S2+ seat is free and records the notice', () => {
  const result = computeAssignment(
    [{ tierId: S1, rank: 1, quantity: 2 }],
    [
      server('older', 1, '2026-09-01T00:00:00.000Z'),
      server('picker', 1, '2026-09-02T00:00:00.000Z', { tierId: S2, rank: 2, label: 'S2' }),
    ]
  )
  assertEquals(result.byServer.get('picker'), S1)
  assertEquals(result.pickUnfulfilled.get('picker'), 'S2')
})

test('clearing a pick is the default smallest-that-fits path', () => {
  const withPick = computeAssignment(purchased(1, 1, 0), [
    server('a', 1, '2026-09-01T00:00:00.000Z', { tierId: S3, rank: 3, label: 'S3' }),
  ])
  const derived = computeAssignment(purchased(1, 1, 0), [
    server('a', 1, '2026-09-01T00:00:00.000Z'),
  ])
  assertEquals(withPick.byServer.get('a'), S3)
  assertEquals(derived.byServer.get('a'), S1)
})

test('pickUnfulfilled matches final placement after greedy placement and swap', () => {
  const rankByTier = new Map([
    [S1, 1],
    [S2, 2],
    [S3, 3],
  ])
  const fleets: AssignableServer[][] = [
    [
      server('first', 1, '2026-09-01T00:00:00.000Z', { tierId: S2, rank: 2, label: 'S2' }),
      server('second', 1, '2026-09-02T00:00:00.000Z', { tierId: S2, rank: 2, label: 'S2' }),
    ],
    [
      server('holder', 1, '2026-09-01T00:00:00.000Z', { tierId: S2, rank: 2, label: 'S2' }),
      { ...server('swapper', 1, '2026-09-02T00:00:00.000Z'), recommendedRank: 2 },
    ],
    swapRealFleet(),
  ]
  const quantities: TierQuantity[][] = [
    [
      { tierId: S1, rank: 1, quantity: 2 },
      { tierId: S2, rank: 2, quantity: 1 },
    ],
    [
      { tierId: S1, rank: 1, quantity: 1 },
      { tierId: S2, rank: 2, quantity: 1 },
    ],
    swapTiers(6, 6),
  ]
  for (let i = 0; i < fleets.length; i++) {
    const result = computeAssignment(quantities[i], fleets[i])
    for (const row of fleets[i]) {
      if (row.preferredRank == null) continue
      const tierId = result.byServer.get(row.serverId) ?? null
      const rank = tierId ? (rankByTier.get(tierId) ?? null) : null
      const notice = result.pickUnfulfilled.get(row.serverId)
      const want = row.preferredRank
      if (rank == null || rank < want) {
        assertEquals(notice, row.preferredLabel ?? 'that tier', row.serverId)
      } else {
        assertEquals(notice, undefined, row.serverId)
      }
    }
  }
})

test('swap pass does not downgrade a server sitting on its honored preferred tier', () => {
  const result = computeAssignment(
    [
      { tierId: S1, rank: 1, quantity: 1 },
      { tierId: S2, rank: 2, quantity: 1 },
    ],
    [
      server('holder', 1, '2026-09-01T00:00:00.000Z', { tierId: S2, rank: 2, label: 'S2' }),
      {
        ...server('swapper', 1, '2026-09-02T00:00:00.000Z'),
        recommendedRank: 2,
      },
    ]
  )
  assertEquals(result.byServer.get('holder'), S2)
  assertEquals(result.byServer.get('swapper'), S1)
  assertEquals(result.pickUnfulfilled.has('holder'), false)
})

test('two servers competing for one S2 spare: bind order wins', () => {
  const result = computeAssignment(
    [
      { tierId: S1, rank: 1, quantity: 2 },
      { tierId: S2, rank: 2, quantity: 1 },
    ],
    [
      server('first', 1, '2026-09-01T00:00:00.000Z', { tierId: S2, rank: 2, label: 'S2' }),
      server('second', 1, '2026-09-02T00:00:00.000Z', { tierId: S2, rank: 2, label: 'S2' }),
    ]
  )
  assertEquals(result.byServer.get('first'), S2)
  assertEquals(result.byServer.get('second'), S1)
  assertEquals(result.pickUnfulfilled.get('second'), 'S2')
})

test('swap pass: downgrade reshuffle when seats drop', () => {
  const servers = swapRealFleet()
  const before = computeAssignment(swapTiers(6, 6), servers)
  assertEquals(before.byServer.get('studio'), 'S2')
  // Seats drop to 7 S1 + 2 S2: only two S2 seats remain; they stay with
  // adrastea and studio (recommenders), kore steps down, all stay covered.
  const after = computeAssignment(swapTiers(7, 2), servers)
  assertEquals(after.uncovered, [])
  assertEquals(after.byServer.get('adrastea'), 'S2')
  assertEquals(after.byServer.get('studio'), 'S2')
  assertEquals(after.byServer.get('kore'), 'S1')
  assertEquals(coverageLoss(swapTiers(6, 6), swapTiers(7, 2), servers), null)
})
