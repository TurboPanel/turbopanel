import { assertEquals } from '@std/assert'
import type { ComposeDocument } from '../compose/types.ts'
import {
  collectSpanningComposeNetworkKeys,
  composeServiceNetworkKeys,
  participatingServerIdsForNetwork,
} from './spanning.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function doc(data: Record<string, unknown>): ComposeDocument {
  return { version: 1, data, presentation: { keyOrder: Object.keys(data), comments: {} } }
}

test('composeServiceNetworkKeys uses default when networks are omitted', () => {
  assertEquals(composeServiceNetworkKeys({ image: 'nginx' }), ['default'])
  assertEquals(composeServiceNetworkKeys({ networks: ['frontend', 'backend'] }), [
    'frontend',
    'backend',
  ])
  assertEquals(composeServiceNetworkKeys({ networks: { frontend: {} } }), ['frontend'])
})

test('collectSpanningComposeNetworkKeys is empty for a single-server plan', () => {
  const keys = collectSpanningComposeNetworkKeys(
    doc({
      services: {
        web: { image: 'nginx', networks: ['frontend'] },
        api: { image: 'api', networks: ['frontend'] },
      },
    }),
    [
      { serviceId: 'svc-web', serverId: 'srv-a' },
      { serviceId: 'svc-api', serverId: 'srv-a' },
    ],
    [
      { id: 'svc-web', composeServiceName: 'web' },
      { id: 'svc-api', composeServiceName: 'api' },
    ],
  )
  assertEquals(keys, [])
})

test('collectSpanningComposeNetworkKeys spans when a platform attachment is on another host', () => {
  const document = doc({
    services: {
      web: { image: 'nginx', networks: ['frontend'] },
    },
  })
  const tasks = [{ serviceId: 'svc-web', serverId: 'srv-b' }]
  const serviceRows = [{ id: 'svc-web', composeServiceName: 'web' }]
  assertEquals(
    collectSpanningComposeNetworkKeys(document, tasks, serviceRows),
    [],
  )
  assertEquals(
    collectSpanningComposeNetworkKeys(document, tasks, serviceRows, [
      { serverId: 'srv-a', networkKeys: ['frontend'] },
    ]),
    ['frontend'],
  )
  assertEquals(
    participatingServerIdsForNetwork(
      document,
      tasks,
      serviceRows,
      'frontend',
      [{ serverId: 'srv-a', networkKeys: ['frontend'] }],
    ),
    ['srv-a', 'srv-b'],
  )
})

test('collectSpanningComposeNetworkKeys returns networks used on two servers', () => {
  const keys = collectSpanningComposeNetworkKeys(
    doc({
      services: {
        web: { image: 'nginx', networks: ['frontend'] },
        api: { image: 'api', networks: ['frontend'] },
        worker: { image: 'worker' },
      },
    }),
    [
      { serviceId: 'svc-web', serverId: 'srv-a' },
      { serviceId: 'svc-api', serverId: 'srv-b' },
      { serviceId: 'svc-worker', serverId: 'srv-a' },
    ],
    [
      { id: 'svc-web', composeServiceName: 'web' },
      { id: 'svc-api', composeServiceName: 'api' },
      { id: 'svc-worker', composeServiceName: 'worker' },
    ],
  )
  assertEquals(keys, ['frontend'])
})

test('collectSpanningComposeNetworkKeys treats implicit default as spanning', () => {
  const keys = collectSpanningComposeNetworkKeys(
    doc({
      services: {
        web: { image: 'nginx' },
        api: { image: 'api' },
      },
    }),
    [
      { serviceId: 'svc-web', serverId: 'srv-a' },
      { serviceId: 'svc-api', serverId: 'srv-b' },
    ],
    [
      { id: 'svc-web', composeServiceName: 'web' },
      { id: 'svc-api', composeServiceName: 'api' },
    ],
  )
  assertEquals(keys, ['default'])
})

test('participatingServerIdsForNetwork lists servers that join the key', () => {
  const ids = participatingServerIdsForNetwork(
    doc({
      services: {
        web: { image: 'nginx', networks: ['frontend'] },
        api: { image: 'api', networks: ['frontend'] },
        db: { image: 'postgres', networks: ['backend'] },
      },
    }),
    [
      { serviceId: 'svc-web', serverId: 'srv-b' },
      { serviceId: 'svc-api', serverId: 'srv-a' },
      { serviceId: 'svc-db', serverId: 'srv-c' },
    ],
    [
      { id: 'svc-web', composeServiceName: 'web' },
      { id: 'svc-api', composeServiceName: 'api' },
      { id: 'svc-db', composeServiceName: 'db' },
    ],
    'frontend',
  )
  assertEquals(ids, ['srv-a', 'srv-b'])
})
