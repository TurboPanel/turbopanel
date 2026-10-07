import { assertEquals } from '@std/assert'
import { describeEvent } from './events.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('an offline server that hosts HA database primaries says what is at stake and what happens next', () => {
  const body =
    describeEvent('server.offline', {
      serverName: 'db-1',
      databases: 'orders, shop',
    }).body ?? ''
  assertEquals(body.includes('It hosts the primary of orders, shop.'), true)
  assertEquals(body.includes('promote a replica'), true)
  // Without databases the sentence is exactly the old one.
  assertEquals(
    describeEvent('server.offline', { serverName: 'db-1' }).body,
    'The daemon on db-1 stopped answering and the server was marked offline.'
  )
  assertEquals(
    describeEvent('server.offline', { serverName: 'db-1', databases: '' }).body,
    'The daemon on db-1 stopped answering and the server was marked offline.'
  )
})
