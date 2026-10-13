import { assertEquals } from '@std/assert'
import { emptyPrincipalUsage, isPrincipalUnused, placementSourceFor } from './placement-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('placementSourceFor: a compose alias wins over every other reach', () => {
  assertEquals(
    placementSourceFor({ composeAlias: true, viaTenancy: false, viaStorage: true }),
    'compose'
  )
  assertEquals(
    placementSourceFor({ composeAlias: true, viaTenancy: true, viaStorage: false }),
    'compose'
  )
})

test('placementSourceFor: storage only when the principal reaches the server through storage alone', () => {
  assertEquals(
    placementSourceFor({ composeAlias: false, viaTenancy: false, viaStorage: true }),
    'storage'
  )
  assertEquals(
    placementSourceFor({ composeAlias: false, viaTenancy: true, viaStorage: true }),
    'manual'
  )
  assertEquals(
    placementSourceFor({ composeAlias: false, viaTenancy: true, viaStorage: false }),
    'manual'
  )
  assertEquals(
    placementSourceFor({ composeAlias: false, viaTenancy: false, viaStorage: false }),
    'manual'
  )
})

test('isPrincipalUnused is true only when every usage count is zero', () => {
  assertEquals(isPrincipalUnused(emptyPrincipalUsage()), true)
  for (const kind of ['tenancies', 'bindings', 'storages', 'secrets', 'otherPlacements'] as const) {
    assertEquals(isPrincipalUnused({ ...emptyPrincipalUsage(), [kind]: 1 }), false, kind)
  }
})
