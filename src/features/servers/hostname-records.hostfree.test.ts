import { assertEquals } from '@std/assert'
import { hostingRoutingNames } from './hostname-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('hostingRoutingNames is the typed names alone when www is off or unset', () => {
  assertEquals(hostingRoutingNames(['example.com'], undefined), ['example.com'])
  assertEquals(hostingRoutingNames(['example.com'], 'off'), ['example.com'])
  assertEquals(hostingRoutingNames(['www.example.com'], 'off'), ['www.example.com'])
  assertEquals(hostingRoutingNames([], 'both'), [])
})

test('hostingRoutingNames adds the other spelling for every www choice, served or redirect-only', () => {
  for (const www of ['both', 'www-to-root', 'root-to-www'] as const) {
    assertEquals(
      new Set(hostingRoutingNames(['example.com'], www)),
      new Set(['example.com', 'www.example.com']),
      www
    )
    assertEquals(
      new Set(hostingRoutingNames(['www.example.com'], www)),
      new Set(['example.com', 'www.example.com']),
      www
    )
  }
})

test('hostingRoutingNames lists a name once when both spellings are typed', () => {
  for (const www of ['off', 'both', 'www-to-root', 'root-to-www'] as const) {
    const names = hostingRoutingNames(['example.com', 'www.example.com'], www)
    assertEquals(names.length, 2, www)
    assertEquals(new Set(names), new Set(['example.com', 'www.example.com']), www)
  }
})

test('hostingRoutingNames adds nothing for a name with no www spelling', () => {
  assertEquals(hostingRoutingNames(['203.0.113.5'], 'both'), ['203.0.113.5'])
  assertEquals(hostingRoutingNames(['localhost'], 'root-to-www'), ['localhost'])
})
