import { assertEquals } from '@std/assert'
import type { DesiredTaskInput } from '../db/task-records.ts'
import { assignTaskAddresses, buildCompileAddressMaps } from './task-addresses.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVICE_A = '00000000-0000-4000-8000-0000000000aa'
const SERVICE_B = '00000000-0000-4000-8000-0000000000bb'
const SERVER_A = '00000000-0000-4000-8000-00000000000a'
const SERVER_B = '00000000-0000-4000-8000-00000000000b'
const FRONTEND = 'frontend'
const SEGMENT_A = '203.0.113.0/24'
const SEGMENT_B = '198.51.100.0/24'

function task(
  serviceId: string,
  serverId: string,
  slot: number,
): DesiredTaskInput {
  return { serviceId, serverId, slot, desiredState: 'running' }
}

function segmentsFor(
  composeKey: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Map<string, Map<string, string>> {
  return new Map([[composeKey, new Map(entries)]])
}

test('assignTaskAddresses first-fits the lowest free host in the segment', () => {
  const assigned = assignTaskAddresses({
    tasks: [
      task(SERVICE_A, SERVER_A, 0),
      task(SERVICE_A, SERVER_A, 1),
    ],
    existing: [],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, SEGMENT_A]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(
    assigned.map((row) => row.address),
    ['203.0.113.1', '203.0.113.2'],
  )
})

test('assignTaskAddresses keeps a sticky address across re-plan on the same server and slot', () => {
  const assigned = assignTaskAddresses({
    tasks: [
      task(SERVICE_A, SERVER_A, 0),
      task(SERVICE_A, SERVER_A, 1),
    ],
    existing: [
      {
        serviceId: SERVICE_A,
        slot: 0,
        serverId: SERVER_A,
        address: '203.0.113.7',
      },
    ],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, SEGMENT_A]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.address, '203.0.113.7')
  assertEquals(assigned[1]?.address, '203.0.113.1')
})

test('assignTaskAddresses reuses an address after its slot leaves the desired set', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_A, SERVER_A, 1)],
    existing: [
      {
        serviceId: SERVICE_A,
        slot: 0,
        serverId: SERVER_A,
        address: '203.0.113.1',
      },
    ],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, SEGMENT_A]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.slot, 1)
  assertEquals(assigned[0]?.address, '203.0.113.1')
})

test('assignTaskAddresses does not collide across independent server segments', () => {
  const assigned = assignTaskAddresses({
    tasks: [
      task(SERVICE_A, SERVER_A, 0),
      task(SERVICE_B, SERVER_B, 0),
    ],
    existing: [],
    networkSegments: segmentsFor(FRONTEND, [
      [SERVER_A, SEGMENT_A],
      [SERVER_B, SEGMENT_B],
    ]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A, SERVICE_B])]]),
  })
  assertEquals(assigned[0]?.address, '203.0.113.1')
  assertEquals(assigned[1]?.address, '198.51.100.1')
})

test('assignTaskAddresses reallocates when a slot is re-homed to another server', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_A, SERVER_B, 0)],
    existing: [
      {
        serviceId: SERVICE_A,
        slot: 0,
        serverId: SERVER_A,
        address: '203.0.113.5',
      },
    ],
    networkSegments: segmentsFor(FRONTEND, [
      [SERVER_A, SEGMENT_A],
      [SERVER_B, SEGMENT_B],
    ]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.address, '198.51.100.1')
})

test('assignTaskAddresses writes null when a task is not on a spanning network', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_B, SERVER_A, 0)],
    existing: [
      {
        serviceId: SERVICE_B,
        slot: 0,
        serverId: SERVER_A,
        address: '203.0.113.9',
      },
    ],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, SEGMENT_A]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.address, null)
})

test('buildCompileAddressMaps keeps spanning-network membership on host entries', () => {
  const maps = buildCompileAddressMaps({
    tasks: [
      { ...task(SERVICE_A, SERVER_A, 0), address: '203.0.113.10' },
      { ...task(SERVICE_B, SERVER_B, 0), address: '198.51.100.10' },
    ],
    serviceIdToName: new Map([[SERVICE_A, 'web'], [SERVICE_B, 'cache']]),
    serverId: SERVER_A,
    networkServiceIds: new Map([
      ['frontend', new Set([SERVICE_A])],
      ['backend', new Set([SERVICE_B])],
    ]),
  })
  assertEquals(maps.taskAddressesByService.get('web')?.get(0), '203.0.113.10')
  assertEquals(maps.taskAddressesByService.has('cache'), false)
  assertEquals(
    [...(maps.spanningHostsByService.get('web')?.networks ?? [])],
    ['frontend'],
  )
  assertEquals(
    [...(maps.spanningHostsByService.get('cache')?.networks ?? [])],
    ['backend'],
  )
  assertEquals(maps.spanningHostsByService.get('web')?.primary, '203.0.113.10')
  assertEquals(maps.spanningHostsByService.get('cache')?.primary, '198.51.100.10')
})

test('assignTaskAddresses never allocates the reserved managed-ingress address', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_A, SERVER_A, 0)],
    existing: [
      {
        serviceId: SERVICE_A,
        slot: 0,
        serverId: SERVER_A,
        address: '203.0.113.254',
      },
    ],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, SEGMENT_A]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.address, '203.0.113.1')
})

test('assignTaskAddresses skips networks with empty service membership', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_A, SERVER_A, 0)],
    existing: [],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, SEGMENT_A]]),
    networkServiceIds: new Map([[FRONTEND, new Set()]]),
  })
  assertEquals(assigned[0]?.address, null)
})

test('assignTaskAddresses ignores blank and malformed sticky addresses', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_A, SERVER_A, 0)],
    existing: [
      {
        serviceId: SERVICE_A,
        slot: 0,
        serverId: SERVER_A,
        address: '',
      },
    ],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, SEGMENT_A]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.address, '203.0.113.1')
})

test('buildCompileAddressMaps works without network membership and skips unknown services', () => {
  const maps = buildCompileAddressMaps({
    tasks: [
      { ...task(SERVICE_A, SERVER_A, 0), address: '203.0.113.10' },
      { ...task(SERVICE_B, SERVER_A, 0), address: '203.0.113.11' },
      { ...task(SERVICE_A, SERVER_A, 1), address: '' },
    ],
    serviceIdToName: new Map([[SERVICE_A, 'web']]),
    serverId: SERVER_A,
  })
  assertEquals(maps.taskAddressesByService.get('web')?.get(0), '203.0.113.10')
  assertEquals(maps.taskAddressesByService.has('cache'), false)
  assertEquals(maps.spanningHostsByService.get('web')?.networks.size, 0)
  assertEquals(maps.spanningHostsByService.has('cache'), false)
})

test('assignTaskAddresses drops sticky addresses outside the segment host range', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_A, SERVER_A, 0)],
    existing: [
      {
        serviceId: SERVICE_A,
        slot: 0,
        serverId: SERVER_A,
        address: '198.51.100.7',
      },
    ],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, SEGMENT_A]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.address, '203.0.113.1')
})

test('assignTaskAddresses drops sticky addresses that are not parseable IPs', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_A, SERVER_A, 0)],
    existing: [
      {
        serviceId: SERVICE_A,
        slot: 0,
        serverId: SERVER_A,
        address: 'not-an-ip',
      },
    ],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, SEGMENT_A]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.address, '203.0.113.1')
})

test('assignTaskAddresses skips reserved seeding when the CIDR is too small', () => {
  const tiny = '203.0.113.0/31'
  const assigned = assignTaskAddresses({
    tasks: [
      task(SERVICE_A, SERVER_A, 0),
      task(SERVICE_A, SERVER_A, 1),
    ],
    existing: [],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, tiny]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(
    assigned.map((row) => row.address),
    ['203.0.113.0', '203.0.113.1'],
  )
})

test('assignTaskAddresses leaves address null when the segment host range is exhausted', () => {
  const single = '203.0.113.8/32'
  const assigned = assignTaskAddresses({
    tasks: [
      task(SERVICE_A, SERVER_A, 0),
      task(SERVICE_A, SERVER_A, 1),
    ],
    existing: [],
    networkSegments: segmentsFor(FRONTEND, [[SERVER_A, single]]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.address, '203.0.113.8')
  assertEquals(assigned[1]?.address, null)
})

test('assignTaskAddresses skips compose keys without service membership metadata', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_A, SERVER_A, 0)],
    existing: [],
    networkSegments: new Map([
      [FRONTEND, new Map([[SERVER_A, SEGMENT_A]])],
      ['orphan', new Map([[SERVER_A, SEGMENT_B]])],
    ]),
    networkServiceIds: new Map([[FRONTEND, new Set([SERVICE_A])]]),
  })
  assertEquals(assigned[0]?.address, '203.0.113.1')
})

test('assignTaskAddresses keeps the first network address when a task joins two spanning nets', () => {
  const assigned = assignTaskAddresses({
    tasks: [task(SERVICE_A, SERVER_A, 0)],
    existing: [],
    networkSegments: new Map([
      ['backend', new Map([[SERVER_A, SEGMENT_B]])],
      [FRONTEND, new Map([[SERVER_A, SEGMENT_A]])],
    ]),
    networkServiceIds: new Map([
      ['backend', new Set([SERVICE_A])],
      [FRONTEND, new Set([SERVICE_A])],
    ]),
  })
  // compose keys sort: backend before frontend → 198.51.100.1 wins
  assertEquals(assigned[0]?.address, '198.51.100.1')
})
