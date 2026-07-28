import { assertEquals } from 'jsr:@std/assert'
import {
  MAX_SERVICE_INSTANCES,
  parseServiceOptions,
  resolveServiceInstances,
} from './service-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseServiceOptions accepts instances within the clamp', () => {
  assertEquals(parseServiceOptions({ instances: 3 }), { instances: 3 })
  assertEquals(
    parseServiceOptions({ instances: MAX_SERVICE_INSTANCES }),
    { instances: MAX_SERVICE_INSTANCES },
  )
})

test('parseServiceOptions drops invalid or oversized instances', () => {
  assertEquals(parseServiceOptions({ instances: 0 }), {})
  assertEquals(parseServiceOptions({ instances: -1 }), {})
  assertEquals(parseServiceOptions({ instances: 1.5 }), { instances: 1 })
  assertEquals(parseServiceOptions({ instances: MAX_SERVICE_INSTANCES + 1 }), {})
})

test('resolveServiceInstances defaults to 1', () => {
  assertEquals(resolveServiceInstances(undefined), 1)
  assertEquals(resolveServiceInstances({}), 1)
  assertEquals(resolveServiceInstances({ instances: 4 }), 4)
})
