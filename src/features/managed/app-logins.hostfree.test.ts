import { assertEquals } from '@std/assert'
import { APP_LOGIN_KINDS, appLoginRequests, parseAppLoginPrefix } from './app-logins.ts'

const test = Deno.test.bind(Deno)

test('the prefix defaults to the database name and is trimmed', () => {
  assertEquals(parseAppLoginPrefix(undefined, 'staging', 63), { ok: true, prefix: 'staging' })
  assertEquals(parseAppLoginPrefix('', 'staging', 63), { ok: true, prefix: 'staging' })
  assertEquals(parseAppLoginPrefix('   ', 'staging', 63), { ok: true, prefix: 'staging' })
  assertEquals(parseAppLoginPrefix(' shop ', 'staging', 63), { ok: true, prefix: 'shop' })
})

test('a prefix that is not a plain name is refused in plain words', () => {
  for (const value of ['1shop', 'shop-app', 'shop app', 42]) {
    const result = parseAppLoginPrefix(value, 'staging', 63)
    assertEquals(result.ok, false)
    if (!result.ok) assertEquals(result.error, 'managed_app_login_prefix_invalid')
  }
})

test('the prefix leaves room for the longest name under the engine limit', () => {
  // MySQL and MariaDB allow 32 characters: 24 + "_migrate".
  assertEquals(parseAppLoginPrefix('a'.repeat(24), 'db', 32).ok, true)
  const tooLong = parseAppLoginPrefix('a'.repeat(25), 'db', 32)
  assertEquals(tooLong.ok, false)
  if (!tooLong.ok) {
    assertEquals(tooLong.error, 'managed_app_login_prefix_too_long')
    assertEquals(tooLong.message.includes('at most 24 characters'), true)
  }
})

test('the three logins: owner, read/write and read-only on that database only', () => {
  assertEquals(appLoginRequests('shop', 'staging'), [
    {
      kind: APP_LOGIN_KINDS[0],
      body: {
        username: 'shop_migrate',
        databases: ['staging'],
        privileges: ['admin'],
        connectionRole: 'read-write',
      },
    },
    {
      kind: APP_LOGIN_KINDS[1],
      body: {
        username: 'shop_rw',
        databases: ['staging'],
        privileges: ['read-write'],
        connectionRole: 'read-write',
      },
    },
    {
      kind: APP_LOGIN_KINDS[2],
      body: {
        username: 'shop_ro',
        databases: ['staging'],
        privileges: ['read-only'],
        connectionRole: 'read-only',
      },
    },
  ])
})
