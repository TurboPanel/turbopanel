import { assertEquals } from '@std/assert'
import { isHttpOrderable } from './orchestrator.ts'
import { orderNamesFor } from './names.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('an order asks for the row names and the www names its sites add', () => {
  assertEquals(
    orderNamesFor(['Example.com'], [{ hostnames: ['example.com'], www: 'www-to-root' }]),
    ['example.com', 'www.example.com']
  )
  assertEquals(
    orderNamesFor(
      ['example.com', 'shop.example.com'],
      [
        { hostnames: ['example.com'], www: 'both' },
        { hostnames: ['shop.example.com'], www: 'off' },
      ]
    ),
    ['example.com', 'shop.example.com', 'www.example.com']
  )
  // A site with no www mode adds nothing.
  assertEquals(orderNamesFor(['example.com'], [{ hostnames: ['example.com'], www: 'off' }]), [
    'example.com',
  ])
})

test("a site whose names the row does not cover adds nothing to the row's order", () => {
  assertEquals(
    orderNamesFor(['example.com'], [{ hostnames: ['other.example.net'], www: 'both' }]),
    ['example.com']
  )
})

test('a wildcard or an empty row is not ordered over the web check', () => {
  assertEquals(orderNamesFor([], []), null)
  assertEquals(orderNamesFor(['  '], []), null)
  assertEquals(orderNamesFor(['*.example.com'], []), null)
  assertEquals(isHttpOrderable([]), false)
  assertEquals(isHttpOrderable(['*.example.com']), false)
  assertEquals(isHttpOrderable(['example.com', 'www.example.com']), true)
})

test('names are folded the same way everywhere, an international name as punycode', () => {
  assertEquals(
    orderNamesFor([' Bücher.Example '], [{ hostnames: ['bücher.example'], www: 'both' }]),
    ['xn--bcher-kva.example', 'www.xn--bcher-kva.example']
  )
})
