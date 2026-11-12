import { assertEquals } from '@std/assert'
import {
  allocateHelperPorts,
  helperEnvName,
  helperVariables,
  injectHelperPublishes,
  planHelperReach,
  reachDecls,
  readRecordedCacheConsumers,
  readRecordedHelperPorts,
  type ReachServiceInfo,
} from './reach.ts'
import { ENV_1, PRINCIPAL_A, PRINCIPAL_B } from './fixtures.test.support.ts'

import { buildApplicationModel } from '../compose/ir.ts'

const test = Deno.test.bind(Deno)

const services = new Map<string, ReachServiceInfo>([
  ['web', { kind: 'site', principalId: PRINCIPAL_A }],
  ['worker', { kind: 'node', principalId: PRINCIPAL_A }],
  ['api', { kind: 'site', principalId: PRINCIPAL_B }],
  ['db', { kind: 'container', principalId: undefined }],
  ['search', { kind: 'container', principalId: undefined }],
])
const usernameOf = (id: string) => (id === PRINCIPAL_A ? 'siteowner' : undefined)
const one = new Map<string, readonly string[]>()

test('a reach port opens to the one account of every service in from', () => {
  const plan = planHelperReach(
    [{ service: 'search', port: 7700, from: ['web', 'worker'] }],
    services,
    usernameOf,
    one
  )
  assertEquals(plan.errors, [])
  assertEquals(plan.entries, [
    {
      origin: 'search',
      composeServiceName: 'search',
      containerPort: 7700,
      username: 'siteowner',
      from: ['web', 'worker'],
    },
  ])
})

test('services of different accounts are refused with the plain sentence', () => {
  const plan = planHelperReach(
    [{ service: 'search', port: 7700, from: ['web', 'api'] }],
    services,
    usernameOf,
    one
  )
  assertEquals(plan.entries, [])
  assertEquals(plan.errors[0]?.startsWith('A helper port opens to one Hosting Account;'), true)
})

test('unknown, container, unowned and replicated services are refused', () => {
  const refused = (from: string[], expansion = one) =>
    planHelperReach([{ service: 'search', port: 1, from }], services, usernameOf, expansion).errors
  assertEquals(refused(['nope']).length, 1)
  assertEquals(refused(['db']).length, 1)
  assertEquals(refused(['web'], new Map([['search', ['search-1', 'search-2']]])).length, 1)
  const unowned = planHelperReach(
    [{ service: 'search', port: 1, from: ['web'] }],
    services,
    () => undefined,
    one
  )
  assertEquals(unowned.errors.length, 1)
})

test('a container scaled by deploy.replicas is refused, naming the service', () => {
  const plan = (replicas: number | undefined) =>
    planHelperReach(
      [{ service: 'search', port: 7700, from: ['web'], replicas }],
      services,
      usernameOf,
      one
    )
  assertEquals(plan(2).entries, [])
  assertEquals(plan(2).errors, ['"search" has a reach port, so it must run as one copy'])
  assertEquals(plan(1).errors, [])
  assertEquals(plan(undefined).errors, [])
})

test('reach declarations carry deploy.replicas and scale from the document', () => {
  const replicasOf = (extra: Record<string, unknown>) => {
    const data = {
      services: {
        search: {
          image: 'search',
          'x-turbopanel': { reach: { port: 7700, from: ['web'] } },
          ...extra,
        },
      },
    }
    const decls = reachDecls(buildApplicationModel({ data } as never))
    return planHelperReach(decls, services, usernameOf, one).errors
  }
  const refusal = ['"search" has a reach port, so it must run as one copy']
  assertEquals(replicasOf({}), [])
  assertEquals(replicasOf({ deploy: { replicas: 1 } }), [])
  assertEquals(replicasOf({ deploy: { replicas: 2 } }), refusal)
  assertEquals(replicasOf({ deploy: { replicas: '2' } }), refusal)
  assertEquals(replicasOf({ scale: 3 }), refusal)
  assertEquals(replicasOf({ deploy: { mode: 'global', replicas: 4 } }), [])
})

test('more than 32 reach ports is refused', () => {
  const decls = Array.from({ length: 33 }, (_, i) => ({ service: `s${i}`, port: 1, from: ['web'] }))
  assertEquals(planHelperReach(decls, services, usernameOf, one).errors.length, 1)
})

test('a cloned container is named by its single clone', () => {
  const plan = planHelperReach(
    [{ service: 'search', port: 7700, from: ['web'] }],
    services,
    usernameOf,
    new Map([['search', ['search-1']]])
  )
  assertEquals(plan.entries[0]?.composeServiceName, 'search-1')
})

test('ports come from the listen band, keep a preferred free one and skip used ones', () => {
  const entries = planHelperReach(
    [
      { service: 'search', port: 7700, from: ['web'] },
      { service: 'mail', port: 25, from: ['web'] },
    ],
    new Map([...services, ['mail', { kind: 'container', principalId: undefined }]]),
    usernameOf,
    one
  ).entries
  const used = new Set<number>([18100])
  const first = allocateHelperPorts(entries, used, { search: 18100, mail: 80 }, ENV_1)
  const ports = first.reach.map((entry) => entry.hostPort)
  assertEquals(
    ports.every((port) => port >= 18080 && port <= 18999),
    true
  )
  assertEquals(new Set(ports).size, 2)
  assertEquals(ports.includes(18100), false)
  // A redeploy that prefers what it got keeps it.
  const again = allocateHelperPorts(entries, new Set(), first.helperPorts, ENV_1)
  assertEquals(again.helperPorts, first.helperPorts)
})

test('recorded ports and consumers read back only well-formed values', () => {
  assertEquals(readRecordedHelperPorts({ helperPorts: { a: 18100, b: 80, c: 'x' } }), { a: 18100 })
  assertEquals(readRecordedHelperPorts(null), {})
  assertEquals(readRecordedHelperPorts({ helperPorts: [1] }), {})
  assertEquals(readRecordedCacheConsumers({ cacheConsumers: { web: ['x', 1], bad: 'y' } }), {
    web: ['x'],
  })
  assertEquals(readRecordedCacheConsumers(undefined), {})
})

test('the publish is added to the container ports and a missing container is reported', () => {
  const data: Record<string, unknown> = {
    services: { search: { image: 'x', ports: ['8080:80'] }, plain: {} },
  }
  const missing = injectHelperPublishes(data, [
    { composeServiceName: 'search', containerPort: 7700, hostPort: 18101, username: 'siteowner' },
    { composeServiceName: 'gone', containerPort: 1, hostPort: 18102, username: 'siteowner' },
  ])
  assertEquals(missing, ['gone'])
  assertEquals((data.services as Record<string, { ports: string[] }>).search.ports, [
    '8080:80',
    '127.0.0.1:18101:7700',
  ])
  const noPorts: Record<string, unknown> = { services: { plain: {} } }
  injectHelperPublishes(noPorts, [
    { composeServiceName: 'plain', containerPort: 5, hostPort: 18103, username: 'u' },
  ])
  assertEquals((noPorts.services as Record<string, { ports: string[] }>).plain.ports, [
    '127.0.0.1:18103:5',
  ])
})

test('helper variables follow the site variable naming rule', () => {
  assertEquals(helperEnvName('my-search.1'), 'MY_SEARCH_1')
  assertEquals(helperEnvName('9lives'), '_9LIVES')
  const vars = helperVariables(
    [
      {
        origin: 'search',
        composeServiceName: 'search',
        containerPort: 7700,
        username: 'u',
        from: ['web', 'worker'],
      },
    ],
    { search: 18101 }
  )
  assertEquals(vars.get('web'), {
    TURBOPANEL_HELPER_SEARCH_HOST: '127.0.0.1',
    TURBOPANEL_HELPER_SEARCH_PORT: '18101',
  })
  assertEquals(vars.get('worker'), vars.get('web'))
  assertEquals(helperVariables([], {}).size, 0)
})
