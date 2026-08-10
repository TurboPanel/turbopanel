/**
 * Host-free tests for binding routes-helpers pure helpers.
 */

import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  assertSafeBindingKeyPrefix,
  bindingPrefixedKeys,
  DEFAULT_BINDING_KEY_PREFIX,
} from '../../lib/naming.ts'
import {
  parseBindingKeyPrefix,
  parseEmitEngineDefaults,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseBindingKeyPrefix defaults to DATABASE', () => {
  assertEquals(parseBindingKeyPrefix(undefined), {
    ok: true,
    prefix: DEFAULT_BINDING_KEY_PREFIX,
  })
  assertEquals(parseBindingKeyPrefix(''), {
    ok: true,
    prefix: DEFAULT_BINDING_KEY_PREFIX,
  })
})

test('parseBindingKeyPrefix rejects reserved TURBOPANEL prefix', () => {
  const result = parseBindingKeyPrefix('TURBOPANEL')
  assertEquals(result.ok, false)
})

test('parseBindingKeyPrefix accepts valid prefixes', () => {
  assertEquals(parseBindingKeyPrefix('APP_DB'), { ok: true, prefix: 'APP_DB' })
  assertEquals(parseBindingKeyPrefix('db'), { ok: true, prefix: 'db' })
})

test('parseEmitEngineDefaults defaults true', () => {
  assertEquals(parseEmitEngineDefaults(undefined), { ok: true, value: true })
  assertEquals(parseEmitEngineDefaults(false), { ok: true, value: false })
  assertEquals(parseEmitEngineDefaults('yes').ok, false)
})

test('assertSafeBindingKeyPrefix and bindingPrefixedKeys stay aligned', () => {
  const prefix = assertSafeBindingKeyPrefix('ORDERS')
  const keys = bindingPrefixedKeys(prefix)
  assertEquals(keys.url, 'ORDERS_URL')
  assertEquals(keys.password, 'ORDERS_PASSWORD')
  assertEquals(keys.readSplit, 'ORDERS_READ_SPLIT')
})

test('assertSafeBindingKeyPrefix rejects reserved', () => {
  assertThrows(() => assertSafeBindingKeyPrefix('TURBOPANEL'), TypeError)
  assertThrows(() => assertSafeBindingKeyPrefix('1BAD'), TypeError)
  assertThrows(() => assertSafeBindingKeyPrefix(''), TypeError)
})
