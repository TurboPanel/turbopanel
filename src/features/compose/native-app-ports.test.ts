/**
 * Native `node` app loopback ports across environments of one project on one
 * server: the same service name in every environment must never share a port.
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import { buildNativeAppServicesForDeploy } from '../../client/environments/deploy-routes-helpers.ts'
import { assignNativeAppListenPorts } from './native-app.ts'

const APP = {
  composeServiceName: 'web',
  serviceId: '00000000-0000-4000-8000-0000000000a1',
  framework: 'next',
  listenPort: 0,
} as const

/** Deploy `web` for one environment the way `deploy-routes` does: other environments' ports are reserved. */
function deployWeb(environmentId: string, reserved: readonly number[]): number {
  const used = new Set<number>(reserved)
  const [app] = buildNativeAppServicesForDeploy([APP], [], [], used, environmentId)
  return app!.listenPort
}

/** The port an environment gets on an empty server. */
const naturalPort = (environmentId: string): number => deployWeb(environmentId, [])

Deno.test('three environments with the same node service name get different ports', () => {
  const production = deployWeb('env-production', [])
  const staging = deployWeb('env-staging', [production])
  const preview = deployWeb('env-preview', [production, staging])
  assertEquals(new Set([production, staging, preview]).size, 3)
})

Deno.test('the same service name even with the same key never shares a held port', () => {
  const first = deployWeb('env-same', [])
  const second = deployWeb('env-same', [first])
  assertNotEquals(second, first)
})

Deno.test('a redeploy keeps its port, including when it had to skip held ports', () => {
  const natural = naturalPort('env-b')
  // Another environment holds this environment's natural port and the next.
  const held = [natural, natural + 1]
  const first = deployWeb('env-b', held)
  assertEquals(first, natural + 2)
  assertEquals(deployWeb('env-b', held), first)
  assertEquals(deployWeb('env-b', held), first)
})

Deno.test('a collision falls through to the next free port, deterministically', () => {
  const natural = naturalPort('env-c')
  assertEquals(deployWeb('env-c', [natural]), natural + 1)
  assertEquals(deployWeb('env-c', [natural, natural + 1]), natural + 2)
  // Ports below the natural one do not matter.
  assertEquals(deployWeb('env-c', [natural - 1]), natural)
})

Deno.test('probing wraps from the top of the range back to the start', () => {
  let key = ''
  for (let i = 0; i < 20_000 && key === ''; i++) {
    if (naturalPort(`wrap-${i}`) === 18_999) key = `wrap-${i}`
  }
  assertNotEquals(key, '')
  assertEquals(deployWeb(key, [18_999]), 18_080)
})

Deno.test('apps in one environment get distinct ports and the ledger is shared', () => {
  const used = new Set<number>()
  const apps = assignNativeAppListenPorts(
    [
      { composeServiceName: 'a', listenPort: 0 },
      { composeServiceName: 'b', listenPort: 0 },
    ],
    new Map(),
    used,
    'env-d'
  )
  assertEquals(new Set(apps.map((app) => app.listenPort)).size, 2)
  assertEquals(used.size, 2)
})
