import { assertEquals } from '@std/assert'
import { constantTimeEqual, constantTimeEqualBytes } from './constant-time.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('constantTimeEqual is true only for identical strings', () => {
  assertEquals(constantTimeEqual('123456', '123456'), true)
  assertEquals(constantTimeEqual('123456', '123457'), false)
  assertEquals(constantTimeEqual('123456', '12345'), false)
  assertEquals(constantTimeEqual('', ''), true)
  // Same UTF-16 length, different UTF-8 bytes.
  assertEquals(constantTimeEqual('é', 'e'), false)
})

test('constantTimeEqualBytes compares every byte and the length', () => {
  const a = new Uint8Array([1, 2, 3])
  assertEquals(constantTimeEqualBytes(a, new Uint8Array([1, 2, 3])), true)
  assertEquals(constantTimeEqualBytes(a, new Uint8Array([1, 2, 4])), false)
  assertEquals(constantTimeEqualBytes(a, new Uint8Array([9, 2, 3])), false)
  assertEquals(constantTimeEqualBytes(a, new Uint8Array([1, 2])), false)
})
