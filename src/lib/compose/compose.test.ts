import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  ComposeParseError,
  composeDocumentToRuntimeYaml,
  composeDocumentToYaml,
  emptyComposeDocument,
  mergeComposeOverlay,
  normalizeCompose,
  validateComposeDocument,
  yamlToComposeDocument,
} from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SAMPLE = `version: "3.9"

# Web frontend
services:
  web: # primary
    image: nginx:alpine
    ports:
      - "8080:80"

networks:
  front: {}
`

test('yamlToComposeDocument preserves top-level key order and comments', () => {
  const doc = yamlToComposeDocument(SAMPLE)
  assertEquals(doc.version, 1)
  assertEquals(doc.presentation.keyOrder[0], 'version')
  assertEquals(doc.presentation.keyOrder.includes('services'), true)
  assertEquals(doc.presentation.keyOrder.includes('networks'), true)
  assertEquals(Object.keys(doc.presentation.comments).length > 0, true)

  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.includes('# Web frontend') || roundTrip.includes('primary'), true)
  // services section appears before networks
  assertEquals(roundTrip.indexOf('services:') < roundTrip.indexOf('networks:'), true)
})

test('composeDocumentToRuntimeYaml drops presentation-only concerns but keeps data', () => {
  const doc = yamlToComposeDocument(SAMPLE)
  const runtime = composeDocumentToRuntimeYaml(doc)
  assertEquals(runtime.includes('nginx:alpine'), true)
  assertEquals(runtime.includes('front:'), true)
})

test('normalizeCompose does not lift bare compose objects', () => {
  const bare = { services: { api: { image: 'node:22' } } }
  const doc = normalizeCompose(bare)
  assertEquals(doc, emptyComposeDocument())
})

test('validateComposeDocument rejects bare compose objects', () => {
  const bare = { services: { api: { image: 'node:22' } } }
  const result = validateComposeDocument(bare)
  assertEquals(result.ok, false)
})

test('validateComposeDocument accepts ComposeDocument and null', () => {
  const empty = emptyComposeDocument()
  assertEquals(validateComposeDocument(empty).ok, true)
  assertEquals(validateComposeDocument(null).ok, true)
  const accepted = validateComposeDocument({
    version: 1,
    data: { services: { api: { image: 'node:22' } } },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(accepted.ok, true)
  if (accepted.ok) {
    assertEquals((accepted.document.data.services as Record<string, unknown>).api, {
      image: 'node:22',
    })
  }
})

test('emptyComposeDocument validates', () => {
  const empty = emptyComposeDocument()
  const result = validateComposeDocument(empty)
  assertEquals(result.ok, true)
})

test('mergeComposeOverlay deep-merges services', () => {
  const base = yamlToComposeDocument(`
services:
  web:
    image: nginx:alpine
  db:
    image: postgres:16
`)
  const overlay = yamlToComposeDocument(`
services:
  mailpit:
    image: axllent/mailpit
  web:
    ports:
      - "8080:80"
`)
  const merged = mergeComposeOverlay(base, overlay)
  const services = merged.data.services as Record<string, Record<string, unknown>>
  assertEquals(services.db.image, 'postgres:16')
  assertEquals(services.mailpit.image, 'axllent/mailpit')
  assertEquals(services.web.image, 'nginx:alpine')
  assertEquals(services.web.ports, ['8080:80'])
})

test('yamlToComposeDocument rejects invalid YAML', () => {
  assertThrows(
    () => yamlToComposeDocument('services: [\n  - broken'),
    ComposeParseError,
  )
})

test('empty overlay inherits base', () => {
  const base = emptyComposeDocument()
  base.data = { services: { web: { image: 'nginx' } } }
  const merged = mergeComposeOverlay(base, emptyComposeDocument())
  assertEquals((merged.data.services as Record<string, unknown>).web, { image: 'nginx' })
})
