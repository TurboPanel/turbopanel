/**
 * Host-free coverage for Redis stream parse helpers + socket path resolution.
 * Does not open a live Redis connection (RedisCellClient constructor would).
 */

import { assertEquals } from 'jsr:@std/assert'
import {
  parseAutoClaimEntries,
  parseMessageList,
  parseStreamEntries,
  parseStreamFields,
  parseStreamMessage,
  resolveSocketPath,
} from './client.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveSocketPath prefers explicit opts then env then default', () => {
  assertEquals(
    resolveSocketPath({ socketPath: '/tmp/custom.sock' }),
    '/tmp/custom.sock',
  )
  const previous = Deno.env.get('TURBOPANEL_REDIS_SOCKET')
  try {
    Deno.env.set('TURBOPANEL_REDIS_SOCKET', '/tmp/env.sock')
    assertEquals(resolveSocketPath(), '/tmp/env.sock')
    Deno.env.delete('TURBOPANEL_REDIS_SOCKET')
    assertEquals(resolveSocketPath(), '/run/turbopanel/redis.sock')
  } finally {
    if (previous === undefined) {
      Deno.env.delete('TURBOPANEL_REDIS_SOCKET')
    } else {
      Deno.env.set('TURBOPANEL_REDIS_SOCKET', previous)
    }
  }
})

test('parseStreamFields pairs Redis flat field lists', () => {
  assertEquals(parseStreamFields(null), {})
  assertEquals(parseStreamFields('nope'), {})
  assertEquals(parseStreamFields(['a', '1', 'b', '2']), { a: '1', b: '2' })
  assertEquals(parseStreamFields(['solo']), { solo: '' })
})

test('parseStreamMessage requires an id + fields array', () => {
  assertEquals(parseStreamMessage(null), null)
  assertEquals(parseStreamMessage(['only-id']), null)
  assertEquals(parseStreamMessage(['1-0', ['k', 'v']]), {
    id: '1-0',
    fields: { k: 'v' },
  })
})

test('parseMessageList skips malformed entries', () => {
  assertEquals(parseMessageList(null), [])
  assertEquals(
    parseMessageList([['1-0', ['a', 'b']], 'bad', ['2-0', ['c', 'd']]]),
    [
      { id: '1-0', fields: { a: 'b' } },
      { id: '2-0', fields: { c: 'd' } },
    ],
  )
})

test('parseStreamEntries walks XREADGROUP stream blocks', () => {
  assertEquals(parseStreamEntries(null), [])
  assertEquals(parseStreamEntries([]), [])
  assertEquals(parseStreamEntries([['stream', []]]), [])
  assertEquals(
    parseStreamEntries([
      ['tp:cell:s:outbox', [['1-0', ['payload', '{}']], ['bad']]],
      'not-a-block',
      ['other', 'not-messages'],
    ]),
    [{ id: '1-0', fields: { payload: '{}' } }],
  )
})

test('parseAutoClaimEntries reads the claimed-message list', () => {
  assertEquals(parseAutoClaimEntries(null), [])
  assertEquals(parseAutoClaimEntries(['0-0']), [])
  assertEquals(
    parseAutoClaimEntries(['0-0', [['9-0', ['f', '1']]]]),
    [{ id: '9-0', fields: { f: '1' } }],
  )
})
