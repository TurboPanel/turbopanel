import { assertEquals } from '@std/assert'
import type { ComposeDocument } from '../compose/types.ts'
import {
  collectSpanningComposeNetworkKeys,
  composeServiceNetworkKeys,
  participatingServerIdsForNetwork,
  readOverlayDeclaredNetworkKeys,
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
      networks: { frontend: { driver: 'overlay' } },
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
    networks: { frontend: { driver: 'overlay' } },
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
      networks: { frontend: { driver: 'overlay' } },
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

test('collectSpanningComposeNetworkKeys leaves the undeclared implicit default alone', () => {
  // A document with no `networks:` block spreads over two hosts and still gets
  // two ordinary local bridges: the author never asked for a spanning network,
  // and the scheduler's placement decision must not answer that for them.
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
  assertEquals(keys, [])
})

test('collectSpanningComposeNetworkKeys spans an overlay-declared default', () => {
  // `default` is a key like any other: declaring it overlay opts it in.
  const keys = collectSpanningComposeNetworkKeys(
    doc({
      services: {
        web: { image: 'nginx' },
        api: { image: 'api' },
      },
      networks: { default: { driver: 'overlay' } },
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

test('collectSpanningComposeNetworkKeys ignores a bridge or undeclared network', () => {
  const services = {
    web: { image: 'nginx', networks: ['frontend'] },
    api: { image: 'api', networks: ['frontend'] },
  }
  const slots = [
    { serviceId: 'svc-web', serverId: 'srv-a' },
    { serviceId: 'svc-api', serverId: 'srv-b' },
  ]
  const serviceRows = [
    { id: 'svc-web', composeServiceName: 'web' },
    { id: 'svc-api', composeServiceName: 'api' },
  ]
  // `driver: bridge` used to behave identically to declaring overlay.
  assertEquals(
    collectSpanningComposeNetworkKeys(
      doc({ services, networks: { frontend: { driver: 'bridge' } } }),
      slots,
      serviceRows,
    ),
    [],
  )
  // No top-level entry for the key at all.
  assertEquals(
    collectSpanningComposeNetworkKeys(doc({ services }), slots, serviceRows),
    [],
  )
  // Declared, but with no driver.
  assertEquals(
    collectSpanningComposeNetworkKeys(
      doc({ services, networks: { frontend: { labels: { a: 'b' } } } }),
      slots,
      serviceRows,
    ),
    [],
  )
})

test('collectSpanningComposeNetworkKeys respects a platform attachment only on a declared key', () => {
  const document = doc({
    services: {
      web: { image: 'nginx', networks: ['frontend'] },
    },
    networks: { frontend: { driver: 'bridge' } },
  })
  // ProxySQL is on another host and joins `frontend`, but the author never
  // declared it overlay, so nothing spans.
  assertEquals(
    collectSpanningComposeNetworkKeys(
      document,
      [{ serviceId: 'svc-web', serverId: 'srv-b' }],
      [{ id: 'svc-web', composeServiceName: 'web' }],
      [{ serverId: 'srv-a', networkKeys: ['frontend'] }],
    ),
    [],
  )
})

test('readOverlayDeclaredNetworkKeys tolerates every non-overlay entry shape', () => {
  assertEquals([...readOverlayDeclaredNetworkKeys(doc({}))], [])
  assertEquals([...readOverlayDeclaredNetworkKeys(doc({ networks: 'nope' }))], [])
  assertEquals(
    [
      ...readOverlayDeclaredNetworkKeys(
        doc({
          networks: {
            spans: { driver: ' overlay ' },
            shared: { external: true, name: 'turbopanel-shared' },
            local: { driver: 'bridge' },
            empty: null,
            numeric: { driver: 12 },
          },
        }),
      ),
    ],
    ['spans'],
  )
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
