import { assertEquals } from '@std/assert'
import {
  applyValidatedComposeOption,
  assertComposeDocument,
  stripComposePlacementOption,
  validateComposeDocument,
} from './validate.ts'
import { makeComposeTag } from './tags.ts'
import { emptyComposeDocument } from './types.ts'
import { yamlToComposeDocument } from './convert.ts'

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

test('validateComposeDocument accepts tagged services nodes', () => {
  const document = yamlToComposeDocument(`
services:
  web:
    image: nginx
    ports: !override
      - "9000:80"
  gone: !reset null
`)
  const result = validateComposeDocument(document)
  assertEquals(result.ok, true)
})

test('validateComposeDocument rejects malformed tag name', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: {
        web: {
          image: 'nginx',
          ports: { __turbopanelComposeTag: 'nope', value: [] },
        },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.issues.some((issue) => issue.message.includes('unknown compose tag')),
      true,
    )
  }
})

test('validateComposeDocument still rejects placement after unwrapping tags', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      'x-turbopanel': makeComposeTag('override', {
        placement: { server_id: '01989d42-9adb-7e65-bc2e-f38792c53691' },
      }),
      services: { web: { image: 'nginx' } },
    },
    presentation: { keyOrder: ['x-turbopanel', 'services'], comments: {} },
  })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.issues.some((issue) => issue.path === 'x-turbopanel.placement'),
      true,
    )
  }
})

test('validateComposeDocument layer overlay suppresses base tag advisory on lint', () => {
  const document = yamlToComposeDocument(`
services:
  web:
    image: nginx
    ports: !override
      - "9000:80"
`)
  assertEquals(validateComposeDocument(document, { layer: 'overlay' }).ok, true)
  assertEquals(validateComposeDocument(document, { layer: 'base' }).ok, true)
})
