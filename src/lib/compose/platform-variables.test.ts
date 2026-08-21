import { assertEquals } from 'jsr:@std/assert'
import {
  stripBindingOwnedKeys,
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

test('stripBindingOwnedKeys removes keys owned by a binding', () => {
  const entries: DeployVariableEntry[] = [
    {
      key: 'DATABASE_URL',
      value: 'hosting-override',
      isSecret: true,
      isLiteral: true,
      forBuild: false,
      forRuntime: true,
    },
    {
      key: 'APP_ENV',
      value: 'prod',
      isSecret: false,
      isLiteral: true,
      forBuild: false,
      forRuntime: true,
    },
  ]
  const stripped = stripBindingOwnedKeys(entries, new Set(['DATABASE_URL']))
  assertEquals(stripped.length, 1)
  assertEquals(stripped[0]!.key, 'APP_ENV')
})
