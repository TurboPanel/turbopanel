/**
 * Host-free coverage for system operate route pure helpers.
 */

import { assertEquals } from '@std/assert'
import {
  SYSTEM_HOSTING_INGRESS_COMPONENT,
  SYSTEM_MANAGED_HA_COMPONENT,
  SYSTEM_MANAGED_INGRESS_COMPONENT,
} from './hierarchy.ts'
import {
  isSystemOperateComponent,
  mapSystemRestartFailure,
  SYSTEM_OPERATE_COMPONENTS,
  systemRestartQueuedResponse,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isSystemOperateComponent accepts known components only', () => {
  assertEquals(isSystemOperateComponent(SYSTEM_HOSTING_INGRESS_COMPONENT), true)
  assertEquals(isSystemOperateComponent(SYSTEM_MANAGED_INGRESS_COMPONENT), true)
  assertEquals(isSystemOperateComponent(SYSTEM_MANAGED_HA_COMPONENT), true)
  assertEquals(isSystemOperateComponent('postgres'), false)
  assertEquals(SYSTEM_OPERATE_COMPONENTS.length, 3)
})

test('mapSystemRestartFailure maps provisioned vs unavailable', () => {
  assertEquals(mapSystemRestartFailure('not_provisioned'), {
    error: 'system_component_not_provisioned',
    status: 404,
  })
  assertEquals(mapSystemRestartFailure('other'), {
    error: 'system_reconcile_unavailable',
    status: 503,
  })
})

test('systemRestartQueuedResponse shapes the ack payload', () => {
  assertEquals(
    systemRestartQueuedResponse({ commandId: 'c1', serverId: 's1' }),
    { ok: true, commandId: 'c1', status: 'queued', serverId: 's1' },
  )
})
