/**
 * The `composeCheckout` field of a command: a normal run sends the checkout, a
 * hostings-only run (nothing is built or started) sends none.
 */

import { assertEquals } from '@std/assert'
import type { EnvironmentDeployComposeCheckout } from '../../contracts/commands/schemas.ts'
import { composeCheckoutField } from './deploy-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const CHECKOUT: EnvironmentDeployComposeCheckout = {
  sourceId: '00000000-0000-4000-8000-0000000000c1',
  provider: 'git',
  cloneUrl: 'https://git.example.net/acme/stack.git',
  ref: 'main',
  commitSha: 'c'.repeat(40),
  composePath: 'deploy/compose.yaml',
  credential: 'tpdaemon.v1.sealed',
}

test('a normal run sends the checkout', () => {
  assertEquals(composeCheckoutField(CHECKOUT, undefined), { composeCheckout: CHECKOUT })
  assertEquals(composeCheckoutField(CHECKOUT, false), { composeCheckout: CHECKOUT })
})

test('a hostings-only run sends no checkout, credential included', () => {
  assertEquals(composeCheckoutField(CHECKOUT, true), {})
})

test('a project with nothing to check out sends none', () => {
  assertEquals(composeCheckoutField(undefined, undefined), {})
})
