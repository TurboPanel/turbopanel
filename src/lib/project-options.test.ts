import { assertEquals } from 'jsr:@std/assert'
import {
  parseContainerNamingInput,
  parseProjectOptions,
  resolveContainerNaming,
} from './project-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseProjectOptions reads containerNaming and ignores compose', () => {
  const options = parseProjectOptions({
    containerNaming: 'custom',
    compose: { services: {} },
  })
  assertEquals(options, { containerNaming: 'custom' })
})

test('parseProjectOptions drops invalid containerNaming', () => {
  assertEquals(parseProjectOptions({ containerNaming: 'random' }), {})
  assertEquals(parseProjectOptions(null), {})
})

test('parseContainerNamingInput accepts uuid and custom only', () => {
  assertEquals(parseContainerNamingInput('uuid'), { ok: true, value: 'uuid' })
  assertEquals(parseContainerNamingInput('custom'), { ok: true, value: 'custom' })
  assertEquals(parseContainerNamingInput('other'), { ok: false })
})

test('resolveContainerNaming defaults to uuid', () => {
  assertEquals(resolveContainerNaming(undefined), 'uuid')
  assertEquals(resolveContainerNaming({}), 'uuid')
  assertEquals(resolveContainerNaming({ containerNaming: 'custom' }), 'custom')
})
