import { assertEquals } from '@std/assert'
import {
  capServerServicesList,
  SERVER_SERVICES_LIST_CAP,
  serverServicesRemovalMessage,
  serverServicesRemovalReasons,
  serverServicesRuntimesFromMetadata,
} from './server-services.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('serverServicesRemovalMessage uses one plain sentence per kind', () => {
  assertEquals(
    serverServicesRemovalMessage('container', 1),
    'One container is still on this server: stop or move the apps first.'
  )
  assertEquals(
    serverServicesRemovalMessage('container', 2),
    '2 containers are still on this server: stop or move the apps first.'
  )
  assertEquals(
    serverServicesRemovalMessage('network', 1),
    'One network is still on this server: remove it first.'
  )
  assertEquals(
    serverServicesRemovalMessage('ip', 3),
    '3 addresses are still assigned to this server: remove them first.'
  )
  assertEquals(
    serverServicesRemovalMessage('colocated', 1),
    'This is the machine running the control panel itself and cannot be removed.'
  )
  assertEquals(
    serverServicesRemovalMessage('managed', 1),
    'One managed database is still placed on this server.'
  )
  assertEquals(
    serverServicesRemovalMessage('replica', 1),
    'One database member is still placed on this server.'
  )
  assertEquals(
    serverServicesRemovalMessage('slot', 1),
    'One scheduled app instance is still placed on this server.'
  )
  assertEquals(
    serverServicesRemovalMessage('copy', 2),
    '2 volume copies are still stored on this server.'
  )
  assertEquals(
    serverServicesRemovalMessage('environment', 2),
    '2 app environments are still placed on this server.'
  )
  assertEquals(
    serverServicesRemovalMessage('deployment', 3),
    '3 deployments are still recorded on this server.'
  )
})

test('serverServicesRemovalMessage mentions Host is gone when the leftovers can be forgotten', () => {
  assertEquals(
    serverServicesRemovalMessage('container', 1, { canForget: true }),
    'One container is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.'
  )
  assertEquals(
    serverServicesRemovalMessage('network', 2, { canForget: true }),
    '2 networks are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.'
  )
})

test('serverServicesRemovalReasons prepends colocated then maps delete blockers', () => {
  assertEquals(
    serverServicesRemovalReasons(
      [
        { kind: 'network', count: 1, label: 'a network' },
        { kind: 'container', count: 2, label: 'a container' },
      ],
      true
    ),
    [
      {
        kind: 'colocated',
        count: 1,
        message: 'This is the machine running the control panel itself and cannot be removed.',
      },
      {
        kind: 'network',
        count: 1,
        message: 'One network is still on this server: remove it first.',
      },
      {
        kind: 'container',
        count: 2,
        message: '2 containers are still on this server: stop or move the apps first.',
      },
    ]
  )
})

test('capServerServicesList keeps 50 items and reports the remainder', () => {
  const items = Array.from({ length: SERVER_SERVICES_LIST_CAP + 3 }, (_, i) => i)
  assertEquals(capServerServicesList(items), {
    items: items.slice(0, SERVER_SERVICES_LIST_CAP),
    more: 3,
  })
  assertEquals(capServerServicesList(['a', 'b']), { items: ['a', 'b'], more: 0 })
})

test('serverServicesRuntimesFromMetadata maps stored facts including lsphp', () => {
  assertEquals(serverServicesRuntimesFromMetadata(null), [])
  assertEquals(serverServicesRuntimesFromMetadata({}), [])
  assertEquals(
    serverServicesRuntimesFromMetadata({
      runtimes: {
        php: { series: ['8.4', '8.3'] },
        node: { series: ['22'] },
        lsphp: { series: ['8.4'] },
      },
    }),
    [
      { kind: 'php', versions: ['8.3', '8.4'] },
      { kind: 'node', versions: ['22'] },
      { kind: 'lsphp', versions: ['8.4'] },
    ]
  )
})
