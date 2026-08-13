import { assertEquals } from 'jsr:@std/assert'
import { fabricSettingsResponse, parseFabricPutBody } from './fabric-routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseFabricPutBody requires a boolean enabled flag', () => {
  assertEquals(parseFabricPutBody({ enabled: true }), { ok: true, enabled: true })
  assertEquals(parseFabricPutBody({ enabled: false }), { ok: true, enabled: false })
  assertEquals(parseFabricPutBody({}), { ok: false, error: 'Invalid request' })
  assertEquals(parseFabricPutBody(null), { ok: false, error: 'Invalid request' })
})

test('fabricSettingsResponse omits fabric when TurboFabric is off', () => {
  assertEquals(fabricSettingsResponse(null), { enabled: false })
  assertEquals(
    fabricSettingsResponse({
      id: 'fab-1',
      organizationId: 'org-1',
      cidr: '10.250.0.0/16',
      options: null,
    }),
    { enabled: true, fabric: { id: 'fab-1', cidr: '10.250.0.0/16' } },
  )
})
