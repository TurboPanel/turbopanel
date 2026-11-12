import { assertEquals, assertThrows } from '@std/assert'
import { allocateCachePort, classifyInsertFailure } from './store.ts'
import { ENV_1 } from './fixtures.test.support.ts'

const test = Deno.test.bind(Deno)

function violation(message: string): Error {
  return Object.assign(new Error('Failed query'), { cause: { code: '23505', message } })
}

test('a unique-index clash is named by the index it hit', () => {
  assertEquals(classifyInsertFailure(violation('violates "uniq_cache_environment_name"')), {
    ok: false,
    reason: 'name_taken',
  })
  assertEquals(
    classifyInsertFailure(violation('violates "uniq_cache_environment_principal_prefix"')),
    { ok: false, reason: 'prefix_taken' }
  )
  assertEquals(classifyInsertFailure(violation('violates "uniq_cache_server_port"')), {
    ok: false,
    reason: 'port_taken',
  })
})

test('an error that is not a clash is thrown again', () => {
  assertThrows(() => classifyInsertFailure(new Error('connection lost')), Error, 'connection lost')
})

test('a cache port is in the listen band and skips every used port', () => {
  const used = new Set<number>()
  const seen = new Set<number>()
  for (let i = 0; i < 20; i += 1) {
    const port = allocateCachePort(`cache-${i}`, used, ENV_1)
    assertEquals(port >= 18080 && port <= 18999, true)
    assertEquals(seen.has(port), false)
    seen.add(port)
  }
  assertEquals(used.size, 20)
})
