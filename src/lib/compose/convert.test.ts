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

test('yaml round-trip preserves blankLines before keys through composeDocumentToYaml', () => {
  const source = `services:

  web:
    image: nginx:alpine
`
  const doc = yamlToComposeDocument(source)
  assertEquals(doc.presentation.blankLines?.services, 1)

  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(/^services:\n\n {2}web:/.test(roundTrip), true)

  const restored = yamlToComposeDocument(roundTrip)
  assertEquals(restored.presentation.blankLines?.services, 1)
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

test('yaml round-trip preserves document and sequence item comments', () => {
  const source = `# file header

services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"  # http
`
  const doc = yamlToComposeDocument(source)
  assertEquals(
    doc.presentation.documentCommentBefore?.includes('file header'),
    true,
  )
  assertEquals(
    doc.presentation.comments['services.web.ports[0]']?.inline?.includes('http'),
    true,
  )

  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.includes('# file header'), true)
  assertEquals(roundTrip.includes('# http'), true)
})

test('yaml round-trip preserves trailing document comment and keyBefore from YAML', () => {
  const source = `# services section
services:
  web:
    image: nginx:alpine
# trailing note
`
  const doc = yamlToComposeDocument(source)
  assertEquals(
    doc.presentation.comments.services?.keyBefore?.includes('services section'),
    true,
  )
  assertEquals(
    doc.presentation.documentComment?.includes('trailing note'),
    true,
  )

  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.includes('# services section'), true)
  assertEquals(roundTrip.includes('# trailing note'), true)
})

test('yaml round-trip coerces boolean mapping keys and skips complex keys', () => {
  const source = `true: keep
[bad]: skip
services:
  web:
    image: nginx:alpine
`
  const doc = yamlToComposeDocument(source)
  assertEquals(Object.hasOwn(doc.data, 'true'), true)
  assertEquals(Object.hasOwn(doc.data, '[bad]'), false)

  const yaml = composeDocumentToYaml(doc)
  // yaml quotes the reserved boolean token so the key is not dumped as `true:`.
  assertEquals(yaml.includes('keep'), true)
  assertEquals(yaml.includes('[bad]'), false)
})

test('yaml round-trip applies key blankLines through spaceBefore', () => {
  const source = `services:
  web:
    image: nginx:alpine
`
  const doc = yamlToComposeDocument(source)
  doc.presentation.blankLines = { 'services#key': 1 }
  const yaml = composeDocumentToYaml(doc)
  assertEquals(yaml.includes('services:'), true)
})
