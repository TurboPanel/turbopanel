import { assertEquals } from '@std/assert'
import {
  applyValidatedComposeOption,
  assertComposeDocument,
  stripComposePlacementOption,
} from './validate.ts'
import { emptyComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('assertComposeDocument returns normalized document on success', () => {
  const input = {
    version: 1 as const,
    data: { services: { api: { image: 'node:22' } } },
    presentation: { keyOrder: ['services'], comments: {} },
  }
  const doc = assertComposeDocument(input)
  assertEquals(doc.version, 1)
  assertEquals((doc.data.services as Record<string, unknown>).api, { image: 'node:22' })
})

test('applyValidatedComposeOption skips when compose absent', () => {
  assertEquals(applyValidatedComposeOption(null).ok, true)
  assertEquals(applyValidatedComposeOption({ other: true }).ok, true)
})

test('applyValidatedComposeOption returns issues when compose invalid', () => {
  const options: Record<string, unknown> = { compose: { version: 2 } }
  const result = applyValidatedComposeOption(options)
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.issues.length > 0, true)
  }
})

test('stripComposePlacementOption ignores non-ComposeDocument compose values', () => {
  const options: Record<string, unknown> = { compose: { bare: true } }
  stripComposePlacementOption(options)
  assertEquals(options.compose, { bare: true })
  stripComposePlacementOption(null)
})

test('assertComposeDocument accepts validated empty draft', () => {
  assertEquals(assertComposeDocument(emptyComposeDocument()).data, {})
})
