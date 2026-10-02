import { assertEquals } from '@std/assert'
import { AUTO_FAILOVER_ENV, resolveAutoFailover } from './auto-failover-switch.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveAutoFailover: unset is on for self-hosted / dev / testing', () => {
  assertEquals(resolveAutoFailover(undefined), 'on')
  assertEquals(resolveAutoFailover({}), 'on')
  assertEquals(resolveAutoFailover({ [AUTO_FAILOVER_ENV]: '  ' }), 'on')
  assertEquals(resolveAutoFailover({ TURBOPANEL_ENVIRONMENT: 'testing' }), 'on')
})

test('resolveAutoFailover: unset is off on staging and live', () => {
  assertEquals(resolveAutoFailover({ TURBOPANEL_ENVIRONMENT: 'staging' }), 'off')
  assertEquals(resolveAutoFailover({ TURBOPANEL_ENVIRONMENT: 'live' }), 'off')
})

test('resolveAutoFailover: an explicit value wins over the deployment', () => {
  assertEquals(
    resolveAutoFailover({ [AUTO_FAILOVER_ENV]: 'on', TURBOPANEL_ENVIRONMENT: 'live' }),
    'on'
  )
  assertEquals(
    resolveAutoFailover({ [AUTO_FAILOVER_ENV]: 'OFF', TURBOPANEL_ENVIRONMENT: 'testing' }),
    'off'
  )
  assertEquals(resolveAutoFailover({ [AUTO_FAILOVER_ENV]: 'true' }), 'on')
  assertEquals(resolveAutoFailover({ [AUTO_FAILOVER_ENV]: '0' }), 'off')
})

test('resolveAutoFailover: an unknown value is off (fail safe)', () => {
  assertEquals(resolveAutoFailover({ [AUTO_FAILOVER_ENV]: 'enabled' }), 'off')
  assertEquals(resolveAutoFailover({ [AUTO_FAILOVER_ENV]: 'yes please' }), 'off')
})
