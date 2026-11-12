import { assertEquals } from '@std/assert'
import { cacheConsumers, cacheConsumerWarningMessage } from './consumers.ts'
import {
  CACHE_A,
  CACHE_B,
  PRINCIPAL_A,
  PRINCIPAL_B,
  SERVER_1,
  SERVER_2,
} from './fixtures.test.support.ts'

const test = Deno.test.bind(Deno)

const caches = [
  { id: CACHE_A, serverId: SERVER_1, principalId: PRINCIPAL_A },
  { id: CACHE_B, serverId: SERVER_1, principalId: PRINCIPAL_A },
]

test('a site or app of the cache account on its server gets every cache of that account', () => {
  const result = cacheConsumers(
    [
      { name: 'web', kind: 'site', principalId: PRINCIPAL_A },
      { name: 'api', kind: 'node', principalId: PRINCIPAL_A },
    ],
    caches,
    SERVER_1
  )
  assertEquals(result.consumers.get('web'), [CACHE_A, CACHE_B])
  assertEquals(result.consumers.get('api'), [CACHE_A, CACHE_B])
  assertEquals(result.warnings, [])
})

test('another account gets nothing and one warning per service', () => {
  const result = cacheConsumers(
    [{ name: 'admin', kind: 'site', principalId: PRINCIPAL_B }],
    caches,
    SERVER_1
  )
  assertEquals(result.consumers.size, 0)
  assertEquals(result.warnings, [{ code: 'cache_other_account', composeServiceName: 'admin' }])
})

test('the same account on another server gets nothing and a server warning', () => {
  const result = cacheConsumers(
    [{ name: 'web', kind: 'site', principalId: PRINCIPAL_A }],
    caches,
    SERVER_2
  )
  assertEquals(result.consumers.size, 0)
  assertEquals(result.warnings, [{ code: 'cache_other_server', composeServiceName: 'web' }])
})

test('a container, or a service with no account, is never a consumer and never warned about', () => {
  const result = cacheConsumers(
    [
      { name: 'redis-ui', kind: 'container', principalId: PRINCIPAL_A },
      { name: 'orphan', kind: 'site', principalId: undefined },
    ],
    caches,
    SERVER_1
  )
  assertEquals(result.consumers.size, 0)
  assertEquals(result.warnings, [{ code: 'cache_other_account', composeServiceName: 'orphan' }])
})

test('with no caches nothing is computed and nothing is warned', () => {
  const result = cacheConsumers(
    [{ name: 'web', kind: 'site', principalId: PRINCIPAL_A }],
    [],
    SERVER_1
  )
  assertEquals(result.consumers.size, 0)
  assertEquals(result.warnings, [])
})

test('warning text names the service and never a value', () => {
  assertEquals(
    cacheConsumerWarningMessage({ code: 'cache_other_server', composeServiceName: 'web' }).includes(
      '"web"'
    ),
    true
  )
  assertEquals(
    cacheConsumerWarningMessage({
      code: 'cache_other_account',
      composeServiceName: 'web',
    }).includes('different Hosting Account'),
    true
  )
})
