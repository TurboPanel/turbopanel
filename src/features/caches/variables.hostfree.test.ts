import { assertEquals } from '@std/assert'
import { decryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { ResolvedVariableMap } from '../variables/resolve-inherited.ts'
import {
  applyCacheRows,
  type CacheVariableWarning,
  cacheConnectionUrl,
  cacheVariableMap,
  cacheVariableNames,
} from './variables.ts'
import { CACHE_A, cacheRowFixture, deriveTestSecrets } from './fixtures.test.support.ts'

const test = Deno.test.bind(Deno)

test('names per access mode', () => {
  assertEquals(cacheVariableNames('REDIS', 'socket'), [
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_SOCKET',
    'REDIS_USERNAME',
    'REDIS_PASSWORD',
  ])
  assertEquals(cacheVariableNames('QUEUE', 'port'), [
    'QUEUE_HOST',
    'QUEUE_PORT',
    'QUEUE_USERNAME',
    'QUEUE_PASSWORD',
    'QUEUE_URL',
  ])
})

test('a socket cache sets the socket path, port 0 and the login', async () => {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets)
  const map = cacheVariableMap(row, undefined)
  const path = `/run/turbopanel-cache-${CACHE_A}/valkey.sock`
  assertEquals(map.get('REDIS_HOST')?.value, path)
  assertEquals(map.get('REDIS_SOCKET')?.value, path)
  assertEquals(map.get('REDIS_PORT')?.value, '0')
  assertEquals(map.get('REDIS_USERNAME')?.value, 'app')
  assertEquals(map.has('REDIS_URL'), false)
  // The stored envelope travels untouched and is marked secret; nothing else is.
  assertEquals(map.get('REDIS_PASSWORD')?.value, row.password)
  assertEquals(map.get('REDIS_PASSWORD')?.isSecret, true)
  assertEquals(map.get('REDIS_HOST')?.isSecret, false)
  for (const entry of map.values()) {
    assertEquals(entry.forRuntime, true)
    assertEquals(entry.forBuild, false)
    assertEquals(entry.isLiteral, true)
    assertEquals(entry.bindingId, null)
  }
})

test('a port cache sets loopback host and port, and a URL only when one is given', async () => {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets, { access: 'port', port: 18234, keyPrefix: 'QUEUE' })
  const bare = cacheVariableMap(row, undefined)
  assertEquals(bare.get('QUEUE_HOST')?.value, '127.0.0.1')
  assertEquals(bare.get('QUEUE_PORT')?.value, '18234')
  assertEquals(bare.has('QUEUE_SOCKET'), false)
  assertEquals(bare.has('QUEUE_URL'), false)
  assertEquals(cacheVariableMap(row, 'sealed-url').get('QUEUE_URL')?.isSecret, true)
  assertEquals(cacheConnectionUrl(18234, 'pw'), ['redis:', '//app:pw@127.0.0.1:18234'].join(''))
})

test('applyCacheRows seals the URL of a port cache and warns about overridden names only', async () => {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets, { access: 'port', port: 18234 })
  const map: ResolvedVariableMap = new Map([
    [
      'REDIS_HOST',
      {
        value: 'inherited',
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      },
    ],
  ])
  const warnings: CacheVariableWarning[] = []
  await applyCacheRows(secrets, [row], map, warnings)
  assertEquals(warnings, [{ code: 'cache_variable_overrides', key: 'REDIS_HOST' }])
  assertEquals(map.get('REDIS_HOST')?.value, '127.0.0.1')
  const url = map.get('REDIS_URL')
  assertEquals(url?.isSecret, true)
  assertEquals(
    await decryptSecret(secrets, url?.value ?? ''),
    ['redis:', '//app:fixture-password@127.0.0.1:18234'].join('')
  )
})

test('without data keys no URL is made and the rest is still set', async () => {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets, { access: 'port', port: 18234 })
  const map: ResolvedVariableMap = new Map()
  await applyCacheRows(undefined, [row], map)
  assertEquals(map.has('REDIS_URL'), false)
  assertEquals(map.has('REDIS_PASSWORD'), true)
})
