import { assertEquals } from '@std/assert'
import {
  composeInterpolationRef,
  encodeEnvFile,
  serviceEnvInterpolationKey,
} from './env-file.ts'
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
  // `\W+` replaces `***` with a single underscore; the `svc` fallback is only
  // for a slug that is empty after replace (blank service name).
  assertEquals(serviceEnvInterpolationKey('***', 'PORT'), '___PORT')
  assertEquals(serviceEnvInterpolationKey('', 'PORT'), 'svc__PORT')
})

test('encodeEnvFile quotes empty, hashed, and backslash values', () => {
  const body = encodeEnvFile([
    { key: 'EMPTY', value: '', isLiteral: false },
    { key: 'HASH', value: 'has#hash', isLiteral: false },
    { key: 'SLASH', value: String.raw`a\b`, isLiteral: false },
  ])
  assertEquals(body.includes('EMPTY=""'), true)
  assertEquals(body.includes('HASH="has#hash"'), true)
  assertEquals(body.includes(String.raw`SLASH="a\\b"`), true)
})

test('composeInterpolationRef wraps a project .env key', () => {
  assertEquals(composeInterpolationRef('web__PORT'), '${web__PORT}')
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
