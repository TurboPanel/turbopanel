import { assertEquals } from 'jsr:@std/assert'
import { isVpnAddressUniqueViolation } from './vpn-address-allocator.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isVpnAddressUniqueViolation matches postgres 23505 on overlay address index', () => {
  const err = Object.assign(new Error('duplicate key value violates unique constraint "uniq_ip_vpn_address"'), {
    code: '23505',
  })
  assertEquals(isVpnAddressUniqueViolation(err), true)
})

test('isVpnAddressUniqueViolation ignores other codes and constraints', () => {
  assertEquals(isVpnAddressUniqueViolation({ code: '23505', message: 'other' }), false)
  assertEquals(
    isVpnAddressUniqueViolation(new Error('uniq_ip_vpn_address')),
    false,
  )
  assertEquals(isVpnAddressUniqueViolation(null), false)
  assertEquals(isVpnAddressUniqueViolation('boom'), false)
})
