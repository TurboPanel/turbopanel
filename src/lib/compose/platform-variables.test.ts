import { assertEquals } from 'jsr:@std/assert'
import {
  buildPlatformDeployVariables,
  stripReservedDeployVariableKeys,
} from './platform-variables.ts'
import type { DeployVariableEntry } from './apply-variables.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('buildPlatformDeployVariables emits all six keys when container is known', () => {
  const entries = buildPlatformDeployVariables({
    projectId: 'proj-1',
    environmentId: 'env-1',
    serviceId: 'svc-1',
    containerId: 'cid-1',
    containerName: 'cid-1',
  })
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]))
  assertEquals(Object.keys(byKey).sort((a, b) => a.localeCompare(b)), [
    'TURBOPANEL_CONTAINER_ID',
    'TURBOPANEL_CONTAINER_NAME',
    'TURBOPANEL_ENVIRONMENT_ID',
    'TURBOPANEL_PROJECT_ID',
    'TURBOPANEL_SERVICE_HOST',
    'TURBOPANEL_SERVICE_ID',
  ])
  assertEquals(byKey.TURBOPANEL_SERVICE_HOST?.value, 'cid-1')
  assertEquals(byKey.TURBOPANEL_CONTAINER_NAME?.value, 'cid-1')
  assertEquals(byKey.TURBOPANEL_PROJECT_ID?.forRuntime, true)
  assertEquals(byKey.TURBOPANEL_PROJECT_ID?.forBuild, false)
  assertEquals(byKey.TURBOPANEL_PROJECT_ID?.isLiteral, true)
  assertEquals(byKey.TURBOPANEL_PROJECT_ID?.isSecret, false)
})

test('buildPlatformDeployVariables omits container keys when unallocated', () => {
  const entries = buildPlatformDeployVariables({
    projectId: 'proj-1',
    environmentId: 'env-1',
    serviceId: 'svc-1',
  })
  assertEquals(
    entries.map((e) => e.key).sort((a, b) => a.localeCompare(b)),
    [
      'TURBOPANEL_ENVIRONMENT_ID',
      'TURBOPANEL_PROJECT_ID',
      'TURBOPANEL_SERVICE_ID',
    ],
  )
})

test('stripReservedDeployVariableKeys removes only reserved keys', () => {
  const entries: DeployVariableEntry[] = [
    {
      key: 'APP_ENV',
      value: 'prod',
      isSecret: false,
      isLiteral: true,
      forBuild: false,
      forRuntime: true,
    },
    {
      key: 'TURBOPANEL_PROJECT_ID',
      value: 'shadow',
      isSecret: false,
      isLiteral: true,
      forBuild: false,
      forRuntime: true,
    },
  ]
  const stripped = stripReservedDeployVariableKeys(entries)
  assertEquals(stripped.length, 1)
  assertEquals(stripped[0]!.key, 'APP_ENV')
})
