import { assertEquals } from '@std/assert'
import { cachedForEnv, NOTIFICATION_EMAIL_CACHE_TTL_MS } from './notification-email-cache.ts'

/** Jest/Mocha-shaped alias so Sonar typescript:S2187 sees real tests. */
const test = Deno.test.bind(Deno)

test('three phases in one tick resolve the mail setup once', async () => {
  const env = {}
  let reads = 0
  const resolve = () => {
    reads += 1
    return Promise.resolve({ from: 'a@example.test' })
  }
  await cachedForEnv(env, resolve, 1_000)
  await cachedForEnv(env, resolve, 1_000)
  await cachedForEnv(env, resolve, 61_000)
  assertEquals(reads, 1)
})

test('expires after the TTL and is per env', async () => {
  const env = {}
  let reads = 0
  const resolve = () => {
    reads += 1
    return Promise.resolve(reads)
  }
  await cachedForEnv(env, resolve, 0)
  await cachedForEnv(env, resolve, NOTIFICATION_EMAIL_CACHE_TTL_MS + 1)
  assertEquals(reads, 2)
  await cachedForEnv({}, resolve, 0)
  assertEquals(reads, 3)
})

test('a failed resolution is not pinned', async () => {
  const env = {}
  let reads = 0
  const resolve = () => {
    reads += 1
    return Promise.resolve(reads === 1 ? undefined : 'ok')
  }
  assertEquals(await cachedForEnv(env, resolve, 0), undefined)
  assertEquals(await cachedForEnv(env, resolve, 1), 'ok')
  assertEquals(reads, 2)
})
