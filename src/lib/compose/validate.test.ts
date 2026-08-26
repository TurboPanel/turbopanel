import { assertEquals, assertThrows } from '@std/assert'
import {
  applyValidatedComposeOption,
  assertComposeDocument,
  isComposeDocument,
  stripComposePlacementOption,
  stripProjectComposePlacementOption,
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

test('validateComposeDocument treats null and undefined as an empty draft', () => {
  // Bind once and narrow that: calling again inside the `if` produces a fresh
  // union the guard never narrowed, which is what `undefined` below already
  // does correctly.
  const empty = validateComposeDocument(null)
  assertEquals(empty.ok, true)
  if (empty.ok) {
    assertEquals(empty.document.data, {})
  }
  const missing = validateComposeDocument(undefined)
  assertEquals(missing.ok, true)
  if (missing.ok) {
    assertEquals(missing.document.data, emptyComposeDocument().data)
  }
})

test('assertComposeDocument throws TypeError when the document is invalid', () => {
  assertThrows(
    () => assertComposeDocument({ version: 2 }),
    TypeError,
    'must be a ComposeDocument',
  )
})

test('applyValidatedComposeOption rewrites a valid compose document in place', () => {
  const options: Record<string, unknown> = {
    compose: {
      version: 1,
      data: { services: { api: { image: 'node:22' } } },
      presentation: { keyOrder: ['services'], comments: {} },
    },
  }
  const result = applyValidatedComposeOption(options)
  assertEquals(result.ok, true)
  assertEquals(isComposeDocument(options.compose), true)
})

test('applyValidatedComposeOption forwards knownSourceIds to the linter', () => {
  const sourceId = '01989d42-9adb-7e65-bc2e-f38792c53691'
  const document = yamlToComposeDocument(`
services:
  web:
    image: nginx
    x-turbopanel:
      source:
        sourceId: ${sourceId}
`)
  const options: Record<string, unknown> = { compose: document }
  assertEquals(applyValidatedComposeOption(options).ok, true)
  const denied = applyValidatedComposeOption(options, {
    knownSourceIds: new Set(['00000000-0000-4000-8000-000000000001']),
  })
  assertEquals(denied.ok, false)
  if (!denied.ok) {
    assertEquals(
      denied.issues.some((issue) => issue.message.includes('was not found')),
      true,
    )
  }
})

test('validateComposeDocument rejects a non-mapping services value', () => {
  const result = validateComposeDocument({
    version: 1,
    data: { services: ['web'] },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.issues.some((issue) => issue.path === 'services'),
      true,
    )
  }
})

test('validateComposeDocument rejects a non-mapping x-turbopanel extension', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      'x-turbopanel': 'nope',
      services: { web: { image: 'nginx' } },
    },
    presentation: { keyOrder: ['x-turbopanel', 'services'], comments: {} },
  })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.issues.some((issue) => issue.path === 'x-turbopanel'),
      true,
    )
  }
})

test('validateComposeDocument walks malformed tags inside sequences', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: {
        web: {
          image: 'nginx',
          ports: [{ __turbopanelComposeTag: 'nope', value: '80:80' }],
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

test('validateComposeDocument walks the inner value of a well-formed tag', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: {
        web: {
          image: 'nginx',
          ports: makeComposeTag('override', ['80:80']),
        },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(result.ok, true)
})

test('validateComposeDocument surfaces per-service x-turbopanel shape errors', () => {
  const document = yamlToComposeDocument(`
services:
  web:
    image: nginx
    x-turbopanel:
      engine: nginx
`)
  const result = validateComposeDocument(document)
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.issues.length > 0, true)
  }
})

test('validateComposeDocument prefixes lint messages with the source line', () => {
  const document = yamlToComposeDocument(`
services:
  web:
    imaage: nginx
`)
  const result = validateComposeDocument(document)
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.issues.some((issue) => issue.message.startsWith('Line ')),
      true,
    )
    assertEquals(
      result.issues.some((issue) => issue.line !== undefined),
      true,
    )
  }
})

test('stripComposePlacementOption removes stored placement from a ComposeDocument', () => {
  const options: Record<string, unknown> = {
    compose: {
      version: 1,
      data: {
        'x-turbopanel': {
          placement: { server_id: '01989d42-9adb-7e65-bc2e-f38792c53691' },
        },
        services: { web: { image: 'nginx' } },
      },
      presentation: { keyOrder: ['x-turbopanel', 'services'], comments: {} },
    },
  }
  stripComposePlacementOption(options)
  const compose = options.compose
  if (!isComposeDocument(compose)) {
    throw new TypeError('expected ComposeDocument after strip')
  }
  assertEquals('x-turbopanel' in compose.data, false)
})

test('stripProjectComposePlacementOption is an alias of stripComposePlacementOption', () => {
  const options: Record<string, unknown> = { other: true }
  stripProjectComposePlacementOption(options)
  stripProjectComposePlacementOption(null)
  assertEquals(options.other, true)
})
