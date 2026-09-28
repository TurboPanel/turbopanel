import { assertEquals } from '@std/assert'
import { addressesFetchErrorStatus, extractAddresses } from './daemon-addresses-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('extractAddresses returns ips when status is done', () => {
  const ips = [{ address: '203.0.113.10', version: 4 as const, scope: 'public' as const }]
  assertEquals(extractAddresses({ status: 'done', result: { ips } }), ips)
})

test('extractAddresses throws on expired, failed, and missing payload', () => {
  try {
    extractAddresses({ status: 'expired' })
    throw new TypeError('expected throw')
  } catch (err) {
    assertEquals((err as Error).message, 'timeout waiting for addresses')
  }
  try {
    extractAddresses({ status: 'failed' })
    throw new TypeError('expected throw')
  } catch (err) {
    assertEquals((err as Error).message, 'failed to fetch addresses')
  }
  try {
    extractAddresses({ status: 'done', result: {} })
    throw new TypeError('expected throw')
  } catch (err) {
    assertEquals((err as Error).message, 'missing ips in daemon response')
  }
})

test('addressesFetchErrorStatus maps disconnected to 404 and everything else to 500', () => {
  assertEquals(addressesFetchErrorStatus('daemon not connected'), 404)
  assertEquals(addressesFetchErrorStatus('timeout waiting for addresses'), 500)
  assertEquals(addressesFetchErrorStatus('failed to fetch addresses'), 500)
})
