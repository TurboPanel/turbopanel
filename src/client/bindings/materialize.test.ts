/**
 * Host-free tests for binding materialization key sets.
 */

import { assertEquals } from 'jsr:@std/assert'
import { DEFAULT_MANAGED_SETTINGS } from '../../lib/managed/settings.ts'
import {
  computeBindingVariableSet,
  listBindingEmittedKeys,
} from './materialize.ts'
import { bindingPrefixedKeys } from '../../lib/naming.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SETTINGS = {
  ...DEFAULT_MANAGED_SETTINGS,
  ssl: { enabled: true },
  exposure: { enabled: true, bind: 'public' as const },
}

test('computeBindingVariableSet emits prefixed keys for postgres', () => {
  const result = computeBindingVariableSet({
    keyPrefix: 'DATABASE',
    emitEngineDefaults: false,
    databaseName: 'appdb',
    username: 'appuser',
    password: 's3cret',
    host: 'db.example',
    port: 5432,
    caCertPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    readSplit: true,
    engineCode: 'postgres',
    settings: SETTINGS,
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
    emitEngineDefaults: true,
    databaseName: 'appdb',
    username: 'appuser',
    password: 's3cret',
    host: 'db.example',
    port: 5432,
    caCertPem: 'CA',
    readSplit: false,
    engineCode: 'postgres',
    settings: SETTINGS,
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
    emitEngineDefaults: true,
    databaseName: 'appdb',
    username: 'appuser',
    password: 's3cret',
    host: 'db.example',
    port: 3306,
    caCertPem: 'CA',
    readSplit: false,
    engineCode: 'mysql',
    settings: SETTINGS,
  })
  if ('kind' in result) throw new TypeError(result.kind)

  const byKey = new Map(result.map((r) => [r.key, r]))
  assertEquals(byKey.get('MYSQL_HOST')?.value, 'db.example')
  assertEquals(byKey.get('MYSQL_PORT')?.value, '3306')
  assertEquals(byKey.has('PGHOST'), false)
  assertEquals(byKey.get('DATABASE_URL')?.value.includes('ssl-mode=VERIFY_IDENTITY'), true)
})

test('listBindingEmittedKeys drops stale unprefixed keys when gated off', () => {
  const withDefaults = listBindingEmittedKeys({
    keyPrefix: 'DATABASE',
    emitEngineDefaults: true,
    engineCode: 'postgres',
  })
  const without = listBindingEmittedKeys({
    keyPrefix: 'DATABASE',
    emitEngineDefaults: false,
    engineCode: 'postgres',
  })
  assertEquals(withDefaults?.includes('PGHOST'), true)
  assertEquals(without?.includes('PGHOST'), false)
  assertEquals(without?.includes('DATABASE_URL'), true)
})

test('prefix change swaps emitted key set', () => {
  const before = listBindingEmittedKeys({
    keyPrefix: 'DATABASE',
    emitEngineDefaults: false,
    engineCode: 'postgres',
  })
  const after = listBindingEmittedKeys({
    keyPrefix: 'APP',
    emitEngineDefaults: false,
    engineCode: 'postgres',
  })
  assertEquals(before?.includes('DATABASE_URL'), true)
  assertEquals(after?.includes('DATABASE_URL'), false)
  assertEquals(after?.includes('APP_URL'), true)
})
