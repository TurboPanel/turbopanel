import { assertEquals, assertThrows } from '@std/assert'
import { base64urlDecode, base64urlEncode } from './base64url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('base64urlEncode uses the URL alphabet and drops padding', () => {
  assertEquals(base64urlEncode(new Uint8Array([0xfb, 0xff])), '-_8')
  assertEquals(base64urlEncode(new Uint8Array([])), '')
  assertEquals(base64urlEncode(new TextEncoder().encode('f')), 'Zg')
})

test('base64urlDecode round-trips every byte value and accepts padding', () => {
  const all = new Uint8Array(256).map((_, i) => i)
  assertEquals(base64urlDecode(base64urlEncode(all)), all)
  assertEquals(base64urlDecode('Zg=='), new TextEncoder().encode('f'))
  assertThrows(() => base64urlDecode('*'))
})
