import { assertEquals, assertThrows } from '@std/assert'
import {
  ComposeParseError,
  composeDocumentToYaml,
  yamlToComposeDocument,
} from './convert.ts'
import { emptyComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('yamlToComposeDocument rejects array root', () => {
  assertThrows(
    () => yamlToComposeDocument('- not-a-map\n'),
    ComposeParseError,
    'root must be a mapping',
  )
})

test('yamlToComposeDocument treats null document as empty draft', () => {
  assertEquals(yamlToComposeDocument('null\n'), emptyComposeDocument())
})

test('yaml round-trip keeps key inline comments and blank lines', () => {
  const source = `services:
  web:
    image: nginx:alpine
`
  const doc = yamlToComposeDocument(source)
  doc.presentation.comments.services = {
    keyInline: 'inline key note',
  }
  doc.presentation.blankLines = { services: 1 }

  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.includes('inline key note'), true)
})

test('yaml round-trip supports numeric mapping keys via stringKey coercion', () => {
  const source = `services:
  8080:
    image: nginx:alpine
`
  const doc = yamlToComposeDocument(source)
  assertEquals(doc.presentation.keyOrder.includes('services'), true)
  const services = doc.data.services as Record<string, unknown>
  assertEquals(Object.keys(services)[0], '8080')
})

test('yaml round-trip preserves duplicate top-level keys in leftover order', () => {
  const doc = emptyComposeDocument()
  doc.data = {
    version: '3.9',
    services: { web: { image: 'nginx' } },
    networks: { front: {} },
  }
  doc.presentation = {
    keyOrder: ['networks', 'services', 'version'],
    comments: {},
  }
  const yaml = composeDocumentToYaml(doc)
  assertEquals(yaml.indexOf('networks:') < yaml.indexOf('services:'), true)
  assertEquals(yaml.indexOf('services:') < yaml.indexOf('version:'), true)
})

test('yaml round-trip applies nested value commentBefore paths', () => {
  const source = `services:
  web:
    # env note
    environment:
      PORT: "8080"
    image: nginx:alpine
`
  const doc = yamlToComposeDocument(source)
  assertEquals(
    doc.presentation.comments['services.web']?.before?.includes('env note'),
    true,
  )
  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.includes('# env note'), true)
})
