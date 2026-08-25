import { assertEquals } from '@std/assert'
import { QUERY_CACHE_PREFIX, queryCacheKey } from './keys.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('queryCacheKey uses tp:qcache prefix and colon separators', () => {
  assertEquals(QUERY_CACHE_PREFIX, 'tp:qcache:')
  assertEquals(
    queryCacheKey('servers-list', 'org-203.0.113.10', 'a,b'),
    'tp:qcache:servers-list:org-203.0.113.10:a,b',
  )
})

test('queryCacheKey preserves empty trailing segments', () => {
  assertEquals(queryCacheKey('servers-list'), 'tp:qcache:servers-list')
  assertEquals(
    queryCacheKey('server-detail', 'org-1', ''),
    'tp:qcache:server-detail:org-1:',
  )
})

test('queryCacheKey joins multiple id segments', () => {
  assertEquals(
    queryCacheKey('server-detail', 'org-1', 'srv-1', 'extra'),
    'tp:qcache:server-detail:org-1:srv-1:extra',
  )
})
