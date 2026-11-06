import { assert, assertEquals } from '@std/assert'
import { parsePlacementBody, placementWarnings, resolveCarryingServers } from './placement.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const none = new Set<string>()

test('one and chosen run on the servers with a run portal only', () => {
  for (const placement of ['one', 'chosen'] as const) {
    assertEquals(
      resolveCarryingServers({
        placement,
        portals: [{ serverId: B, wanted: 'run' }],
        datacenterServerIds: [A, B, C],
        neverServerIds: none,
      }),
      [B]
    )
  }
})

test('all covers the datacenter, leaves out skipped servers and picks up a new server by itself', () => {
  const base = {
    placement: 'all' as const,
    portals: [{ serverId: C, wanted: 'skip' as const }],
    neverServerIds: none,
  }
  assertEquals(resolveCarryingServers({ ...base, datacenterServerIds: [B, A, C] }), [A, B])
  assertEquals(
    resolveCarryingServers({
      ...base,
      datacenterServerIds: [A, B, C, '00000000-0000-4000-8000-00000000000d'],
    }),
    [A, B, '00000000-0000-4000-8000-00000000000d']
  )
})

test('chosen does not pick up a new server of the datacenter', () => {
  assertEquals(
    resolveCarryingServers({
      placement: 'chosen',
      portals: [{ serverId: A, wanted: 'run' }],
      datacenterServerIds: [A, B],
      neverServerIds: none,
    }),
    [A]
  )
})

test('a server marked never-carries is left out of every placement', () => {
  const never = new Set([A])
  assertEquals(
    resolveCarryingServers({
      placement: 'all',
      portals: [],
      datacenterServerIds: [A, B],
      neverServerIds: never,
    }),
    [B]
  )
  assertEquals(
    resolveCarryingServers({
      placement: 'chosen',
      portals: [
        { serverId: A, wanted: 'run' },
        { serverId: B, wanted: 'run' },
      ],
      datacenterServerIds: [],
      neverServerIds: never,
    }),
    [B]
  )
})

test('a single connector and no connector both warn, two do not', () => {
  assert(placementWarnings([]).length === 1)
  assert(placementWarnings([A])[0]!.includes('Only one server'))
  assertEquals(placementWarnings([A, B]), [])
})

test('the placement body is checked per placement', () => {
  assertEquals(parsePlacementBody({ placement: 'one', serverIds: [A] }).ok, true)
  assertEquals(parsePlacementBody({ placement: 'one', serverIds: [A, B] }).ok, false)
  assertEquals(parsePlacementBody({ placement: 'chosen', serverIds: [] }).ok, false)
  assertEquals(parsePlacementBody({ placement: 'chosen', serverIds: [A, A] }), {
    ok: true,
    value: { placement: 'chosen', serverIds: [A], exceptServerIds: [] },
  })
  assertEquals(parsePlacementBody({ placement: 'all', exceptServerIds: [C] }).ok, true)
  assertEquals(parsePlacementBody({ placement: 'all', serverIds: [A] }).ok, false)
  assertEquals(
    parsePlacementBody({ placement: 'chosen', serverIds: [A], exceptServerIds: [B] }).ok,
    false
  )
  assertEquals(parsePlacementBody({ placement: 'some' }).ok, false)
  assertEquals(parsePlacementBody({ placement: 'chosen', serverIds: ['x'] }).ok, false)
})
