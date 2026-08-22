import { assertEquals } from '@std/assert'
import { encodeEnvFile, serviceEnvInterpolationKey } from './env-file.ts'
import {
  buildSecretPlanEntry,
  secretContainerPath,
  secretHostPath,
} from './secret-files.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('encodeEnvFile quotes, sorts, and escapes literal dollars', () => {
  const body = encodeEnvFile([
    { key: 'B', value: 'has space', isLiteral: false },
    { key: 'A', value: '$raw', isLiteral: true },
  ])
  assertEquals(body, 'A=$$raw\nB="has space"\n')
})

test('serviceEnvInterpolationKey slugifies compose service names', () => {
  assertEquals(serviceEnvInterpolationKey('my-web', 'PORT'), 'my_web__PORT')
})

test('secret host paths live under /run/turbopanel/deployments', () => {
  const plan = buildSecretPlanEntry({
    key: 'DATABASE_PASSWORD',
    composeServiceName: 'web',
    forBuild: false,
    forRuntime: true,
  })
  assertEquals(plan.source, 'web_database_password')
  assertEquals(plan.target, 'DATABASE_PASSWORD')
  assertEquals(
    secretHostPath('proj', 'env', plan.relativePath),
    '/run/turbopanel/deployments/proj/env/secrets/web--DATABASE_PASSWORD',
  )
  assertEquals(secretContainerPath(plan.target), '/run/secrets/DATABASE_PASSWORD')
})
