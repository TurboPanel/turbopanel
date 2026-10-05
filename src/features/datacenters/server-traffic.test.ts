import { assertEquals } from '@std/assert'
import {
  equalPriorityWarnings,
  planServerTrafficChoice,
  serverTrafficStatus,
  type TrafficDatacenter,
} from './server-traffic.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dc = (id: string, priority = 100, trusted = true): TrafficDatacenter => ({
  id,
  priority,
  trusted,
})

test('choosing the second network gives it 10 and leaves the LAN at 100 (S02)', () => {
  const plan = planServerTrafficChoice([dc('lan'), dc('backhaul')], 'backhaul')
  assertEquals(plan, { ok: true, changes: [{ datacenterId: 'backhaul', before: 100, after: 10 }] })
})

test('a network that already wins changes nothing', () => {
  assertEquals(planServerTrafficChoice([dc('lan'), dc('backhaul', 5)], 'backhaul'), {
    ok: true,
    changes: [],
  })
})

test('a tie is broken by lowering the chosen network, not by id', () => {
  const plan = planServerTrafficChoice([dc('a', 100), dc('b', 100)], 'b')
  assertEquals(plan, { ok: true, changes: [{ datacenterId: 'b', before: 100, after: 10 }] })
})

test('a rival at 10 or lower sends the chosen network to 0', () => {
  const plan = planServerTrafficChoice([dc('lan', 7), dc('backhaul', 50)], 'backhaul')
  assertEquals(plan, { ok: true, changes: [{ datacenterId: 'backhaul', before: 50, after: 0 }] })
})

test('a rival at 0 moves up by 10, keeping its order among rivals (cap 1000)', () => {
  const plan = planServerTrafficChoice(
    [dc('x', 0), dc('y', 995), dc('z', 1000), dc('chosen', 300)],
    'chosen'
  )
  assertEquals(plan, {
    ok: true,
    changes: [
      { datacenterId: 'chosen', before: 300, after: 0 },
      { datacenterId: 'x', before: 0, after: 10 },
      { datacenterId: 'y', before: 995, after: 1000 },
    ],
  })
})

test('an untrusted rival never competes and keeps its number', () => {
  const plan = planServerTrafficChoice([dc('lan'), dc('wan', 1, false), dc('backhaul')], 'backhaul')
  assertEquals(plan, { ok: true, changes: [{ datacenterId: 'backhaul', before: 100, after: 10 }] })
})

test('an untrusted datacenter cannot be chosen, and an unknown one is not found (S16)', () => {
  assertEquals(planServerTrafficChoice([dc('lan'), dc('wan', 100, false)], 'wan'), {
    ok: false,
    error: 'datacenter_not_trusted',
  })
  assertEquals(planServerTrafficChoice([dc('lan')], 'nope'), {
    ok: false,
    error: 'datacenter_not_found',
  })
})

test('the only trusted datacenter needs no change', () => {
  assertEquals(planServerTrafficChoice([dc('lan'), dc('wan', 1, false)], 'lan'), {
    ok: true,
    changes: [],
  })
})

test('status: the lower number wins, equal numbers are tied, untrusted never wins', () => {
  const status = serverTrafficStatus([
    dc('lan'),
    dc('backhaul', 10),
    dc('twin', 100),
    dc('wan', 1, false),
  ])
  assertEquals(status.get('backhaul'), { wins: true, tied: false })
  assertEquals(status.get('lan'), { wins: false, tied: true })
  assertEquals(status.get('twin'), { wins: false, tied: true })
  assertEquals(status.get('wan'), { wins: false, tied: false })
})

test('status: two datacenters at the same lowest number both win but are tied (S17)', () => {
  const status = serverTrafficStatus([dc('a', 10), dc('b', 10)])
  assertEquals(status.get('a'), { wins: true, tied: true })
})

test('equal-priority warnings list each shared number once, trusted only', () => {
  assertEquals(
    equalPriorityWarnings([dc('b'), dc('a'), dc('c', 5), dc('u1', 5, false), dc('u2', 5, false)]),
    [{ code: 'equal_priority', priority: 100, datacenterIds: ['a', 'b'] }]
  )
  assertEquals(equalPriorityWarnings([dc('a'), dc('b', 10)]), [])
})
