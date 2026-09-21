import { assertEquals } from '@std/assert'
import { parseMetricsCapabilityPlanOverride } from './metrics-capability-override.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseMetricsCapabilityPlanOverride clamps normalNicSlots to 11', () => {
  assertEquals(parseMetricsCapabilityPlanOverride({ normalNicSlots: 99 }), {
    normalNicSlots: 11,
  })
})

test('parseMetricsCapabilityPlanOverride returns empty object for non-records', () => {
  assertEquals(parseMetricsCapabilityPlanOverride(null), {})
  assertEquals(parseMetricsCapabilityPlanOverride([]), {})
  assertEquals(parseMetricsCapabilityPlanOverride('nope'), {})
})
