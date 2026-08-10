import { assertEquals } from 'jsr:@std/assert'
import {
  loadDatacenterCidrs,
  assertDatacenterHasCidr,
  assertServerDatacenterReady,
} from './datacenter-networks.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createQueuedDb(
  queue: Array<Array<Record<string, unknown>>>,
): Parameters<typeof loadDatacenterCidrs>[0] {
  let i = 0
  return {
    select() {
      const value = queue[i++] ?? []
      const chain = {
        async limit() {
          return value
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(value).then(resolve, reject)
        },
      }
      return {
        from() {
          return {
            where() {
              return chain
            },
          }
        },
      }
    },
  } as unknown as Parameters<typeof loadDatacenterCidrs>[0]
}

test('loadDatacenterCidrs returns empty map for empty id list without querying', async () => {
  const db = createQueuedDb([[{ should: 'not-run' }]])
  const map = await loadDatacenterCidrs(db, [])
  assertEquals(map.size, 0)
})

test('loadDatacenterCidrs groups cidrs by datacenter id', async () => {
  const db = createQueuedDb([[
    { datacenterId: 'dc-a', cidr: '10.0.0.0/24' },
    { datacenterId: 'dc-a', cidr: '10.0.1.0/24' },
    { datacenterId: 'dc-b', cidr: '10.1.0.0/16' },
    { datacenterId: null, cidr: '10.9.0.0/24' },
    { datacenterId: 'dc-c', cidr: null },
  ]])
  const map = await loadDatacenterCidrs(db, ['dc-a', 'dc-b', 'dc-c'])
  assertEquals(map.get('dc-a'), ['10.0.0.0/24', '10.0.1.0/24'])
  assertEquals(map.get('dc-b'), ['10.1.0.0/16'])
  assertEquals(map.has('dc-c'), false)
})

test('assertDatacenterHasCidr fails when no CIDR rows exist', async () => {
  const db = createQueuedDb([[]])
  assertEquals(await assertDatacenterHasCidr(db, 'dc-a'), {
    kind: 'datacenter_cidr_required',
    datacenterId: 'dc-a',
  })
})

test('assertDatacenterHasCidr succeeds when a CIDR row exists', async () => {
  const db = createQueuedDb([[
    { datacenterId: 'dc-a', cidr: '10.0.0.0/24' },
  ]])
  assertEquals(await assertDatacenterHasCidr(db, 'dc-a'), null)
})

test('assertServerDatacenterReady requires a pin and a site CIDR', async () => {
  assertEquals(
    await assertServerDatacenterReady(
      createQueuedDb([[{ datacenterId: null }]]),
      'srv-1',
    ),
    { kind: 'datacenter_required', serverId: 'srv-1' },
  )

  assertEquals(
    await assertServerDatacenterReady(
      createQueuedDb([
        [{ datacenterId: 'dc-a' }],
        [],
      ]),
      'srv-1',
    ),
    { kind: 'datacenter_cidr_required', datacenterId: 'dc-a' },
  )

  assertEquals(
    await assertServerDatacenterReady(
      createQueuedDb([
        [{ datacenterId: 'dc-a' }],
        [{ datacenterId: 'dc-a', cidr: '10.0.0.0/24' }],
      ]),
      'srv-1',
    ),
    null,
  )
})
