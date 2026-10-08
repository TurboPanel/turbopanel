import { assertEquals } from '@std/assert'
import { COLOCATED_SERVER_DELETE_BLOCKED_REASON } from './delete-guards.ts'
import {
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

test('serverServicesRemovalMessage uses plain words for each blocker kind', () => {
  assertEquals(
    serverServicesRemovalMessage('container', 1, ''),
    '1 container still runs here: stop or move the apps first'
  )
  assertEquals(
    serverServicesRemovalMessage('container', 2, ''),
    '2 containers still run here: stop or move the apps first'
  )
  assertEquals(
    serverServicesRemovalMessage('network', 1, ''),
    '1 network still uses this server: remove it first'
  )
  assertEquals(
    serverServicesRemovalMessage('ip', 3, ''),
    '3 addresses are still assigned here: remove them first'
  )
  assertEquals(
    serverServicesRemovalMessage('colocated', 1, ''),
    COLOCATED_SERVER_DELETE_BLOCKED_REASON
  )
})

test('serverServicesRemovalMessage falls back to the guard label for other blockers', () => {
  assertEquals(
    serverServicesRemovalMessage('replica', 1, 'a database member is still placed on this server'),
    'Still on this server: a database member is still placed on this server'
  )
  assertEquals(
    serverServicesRemovalMessage('deployment', 3, 'a deployment'),
    'Still on this server: a deployment (3)'
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
        message: COLOCATED_SERVER_DELETE_BLOCKED_REASON,
      },
      {
        kind: 'network',
        count: 1,
        message: '1 network still uses this server: remove it first',
      },
      {
        kind: 'container',
        count: 2,
        message: '2 containers still run here: stop or move the apps first',
      },
    ]
  )
})

test('serverServicesRuntimesFromMetadata maps stored facts and ignores the rest', () => {
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
