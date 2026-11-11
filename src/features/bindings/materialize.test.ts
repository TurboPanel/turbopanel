/**
 * Host-free tests for binding materialization key sets.
 */

import { assertEquals } from '@std/assert'
import { computeBindingVariableSet, listBindingEmittedKeys } from './materialize.ts'
import { bindingPrefixedKeys } from '../../lib/naming.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('computeBindingVariableSet emits prefixed keys for postgres', () => {
  const result = computeBindingVariableSet({
    keyPrefix: 'DATABASE',
    preset: null,
    databaseName: 'appdb',
    username: 'appuser',
    password: 's3cret',
    host: 'db.example',
    port: 5432,
    caCertPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    readSplit: true,
    engineCode: 'postgres',
    sslMode: 'verify-full',
  })
  if ('kind' in result) throw new TypeError(result.kind)

  const byKey = new Map(result.map((r) => [r.key, r]))
  const keys = bindingPrefixedKeys('DATABASE')
  assertEquals(byKey.get(keys.url)?.isSecret, true)
  assertEquals(byKey.get(keys.url)?.value.includes('s3cret'), true)
  assertEquals(byKey.get(keys.url)?.value.includes('sslmode=verify-full'), true)
  assertEquals(byKey.get(keys.caCert)?.isSecret, true)
  assertEquals(byKey.get(keys.readSplit)?.value, 'true')
  assertEquals(byKey.get(keys.host)?.value, 'db.example')
  assertEquals(byKey.get(keys.port)?.value, '5432')
  assertEquals(byKey.get(keys.database)?.value, 'appdb')
  assertEquals(byKey.get(keys.user)?.value, 'appuser')
  assertEquals(byKey.get(keys.password)?.isSecret, true)
  assertEquals(byKey.has('PGHOST'), false)
})

test('computeBindingVariableSet gates unprefixed engine defaults', () => {
  const result = computeBindingVariableSet({
    keyPrefix: 'DB',
    preset: 'postgres',
    databaseName: 'appdb',
    username: 'appuser',
    password: 's3cret',
    host: 'db.example',
    port: 5432,
    caCertPem: 'CA',
    readSplit: false,
    engineCode: 'postgres',
    sslMode: 'verify-full',
  })
  if ('kind' in result) throw new TypeError(result.kind)

  const byKey = new Map(result.map((r) => [r.key, r]))
  assertEquals(byKey.get('PGHOST')?.value, 'db.example')
  assertEquals(byKey.get('PGPORT')?.value, '5432')
  assertEquals(byKey.get('PGDATABASE')?.value, 'appdb')
  assertEquals(byKey.get('PGUSER')?.value, 'appuser')
  assertEquals(byKey.get('PGPASSWORD')?.isSecret, true)
  assertEquals(byKey.get('PGSSLMODE')?.value, 'verify-full')
  assertEquals(byKey.get('DB_READ_SPLIT')?.value, 'false')
})

test('computeBindingVariableSet emits mysql-family unprefixed keys', () => {
  const result = computeBindingVariableSet({
    keyPrefix: 'DATABASE',
    preset: 'mysql',
    databaseName: 'appdb',
    username: 'appuser',
    password: 's3cret',
    host: 'db.example',
    port: 3306,
    caCertPem: 'CA',
    readSplit: false,
    engineCode: 'mysql',
    sslMode: 'verify-full',
  })
  if ('kind' in result) throw new TypeError(result.kind)

  const byKey = new Map(result.map((r) => [r.key, r]))
  assertEquals(byKey.get('MYSQL_HOST')?.value, 'db.example')
  assertEquals(byKey.get('MYSQL_PORT')?.value, '3306')
  assertEquals(byKey.has('PGHOST'), false)
  assertEquals(byKey.get('DATABASE_URL')?.value.includes('ssl-mode=VERIFY_IDENTITY'), true)
})

test('the effective ssl mode reaches both the DSN and the engine default key', () => {
  // Bindings used to hardcode `verify-full`; the cluster's effective mode now
  // decides, so a `require` cluster must not hand the app a DSN that fails
  // chain validation against a platform-CA certificate it does not trust.
  const result = computeBindingVariableSet({
    keyPrefix: 'DATABASE',
    preset: 'postgres',
    databaseName: 'appdb',
    username: 'appuser',
    password: 's3cret',
    host: 'db.example',
    port: 5432,
    caCertPem: 'CA',
    readSplit: false,
    engineCode: 'postgres',
    sslMode: 'require',
  })
  if ('kind' in result) throw new TypeError(result.kind)

  const byKey = new Map(result.map((r) => [r.key, r]))
  assertEquals(byKey.get('PGSSLMODE')?.value, 'require')
  assertEquals(
    byKey.get(bindingPrefixedKeys('DATABASE').url)?.value.includes('sslmode=require'),
    true
  )
})

test('listBindingEmittedKeys drops stale unprefixed keys when gated off', () => {
  const withDefaults = listBindingEmittedKeys({
    keyPrefix: 'DATABASE',
    preset: 'postgres',
    engineCode: 'postgres',
  })
  const without = listBindingEmittedKeys({
    keyPrefix: 'DATABASE',
    preset: null,
    engineCode: 'postgres',
  })
  assertEquals(withDefaults?.includes('PGHOST'), true)
  assertEquals(without?.includes('PGHOST'), false)
  assertEquals(without?.includes('DATABASE_URL'), true)
})

test('prefix change swaps emitted key set', () => {
  const before = listBindingEmittedKeys({
    keyPrefix: 'DATABASE',
    preset: null,
    engineCode: 'postgres',
  })
  const after = listBindingEmittedKeys({
    keyPrefix: 'APP',
    preset: null,
    engineCode: 'postgres',
  })
  assertEquals(before?.includes('DATABASE_URL'), true)
  assertEquals(after?.includes('DATABASE_URL'), false)
  assertEquals(after?.includes('APP_URL'), true)
})

function renderSet(extra: Partial<Parameters<typeof computeBindingVariableSet>[0]>) {
  const result = computeBindingVariableSet({
    keyPrefix: 'DATABASE',
    preset: null,
    databaseName: 'appdb',
    username: 'appuser',
    password: 's3cret',
    host: 'db.example',
    port: 5432,
    caCertPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    readSplit: false,
    engineCode: 'postgres',
    sslMode: 'verify-full',
    ...extra,
  })
  if ('kind' in result) throw new TypeError(result.kind)
  return new Map(result.map((row) => [row.key, row]))
}

test('a container Postgres URL names its CA file in the verify modes only', () => {
  const keys = bindingPrefixedKeys('DATABASE')
  for (const sslMode of ['verify-ca', 'verify-full'] as const) {
    const url = renderSet({ sslMode }).get(keys.url)?.value ?? ''
    assertEquals(url.endsWith('&sslrootcert=/run/secrets/DATABASE_CA_CERT'), true, sslMode)
  }
  const require = renderSet({ sslMode: 'require' }).get(keys.url)?.value ?? ''
  assertEquals(require.includes('sslrootcert'), false)
  for (const delivery of ['host-site', 'host-node'] as const) {
    const url = renderSet({ delivery }).get(keys.url)?.value ?? ''
    assertEquals(url.includes('sslrootcert'), false, delivery)
  }
  const mysql = renderSet({ engineCode: 'mysql', port: 3306 }).get(keys.url)?.value ?? ''
  assertEquals(mysql.includes('sslrootcert'), false)
})

test('every kind stores the TLS mode; only a container stores the CA file path', () => {
  const keys = bindingPrefixedKeys('DATABASE')
  for (const delivery of ['container', 'host-site', 'host-node'] as const) {
    assertEquals(renderSet({ delivery }).get(keys.sslMode)?.value, 'verify-full', delivery)
  }
  assertEquals(renderSet({}).get(keys.caFile)?.value, '/run/secrets/DATABASE_CA_CERT')
  assertEquals(renderSet({ delivery: 'host-site' }).has(keys.caFile), false)
  assertEquals(renderSet({ delivery: 'host-node' }).has(keys.caFile), false)
  assertEquals(renderSet({ engineCode: 'mysql' }).get(keys.sslMode)?.value, 'VERIFY_IDENTITY')
})
