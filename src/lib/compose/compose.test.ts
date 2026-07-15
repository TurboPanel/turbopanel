import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  ComposeParseError,
  composeDocumentToRuntimeYaml,
  composeDocumentToYaml,
  emptyComposeDocument,
  mergeComposeOverlay,
  normalizeCompose,
  readComposePlacementServerId,
  TURBOPANEL_EXTENSION_KEY,
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
  assertEquals(doc.presentation.comments.services?.keyBefore?.includes('Web frontend'), true)

  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.includes('# Web frontend'), true)
  assertEquals(roundTrip.includes('primary'), true)
  // services section appears before networks
  assertEquals(roundTrip.indexOf('services:') < roundTrip.indexOf('networks:'), true)
})

test('yaml round-trip keeps nested map comments before a service key', () => {
  const source = `services:
  # comment
  nginx:
    image: nginx:alpine
`
  const roundTrip = composeDocumentToYaml(yamlToComposeDocument(source))
  assertEquals(roundTrip.includes('# comment'), true)
  assertEquals(roundTrip.indexOf('# comment') > roundTrip.indexOf('services:'), true)
  assertEquals(roundTrip.indexOf('# comment') < roundTrip.indexOf('nginx:'), true)
  // Must not duplicate the nested comment above the top-level key.
  assertEquals(roundTrip.trimStart().startsWith('services:'), true)
})

test('yaml round-trip keeps leading document comments separated by a blank line', () => {
  const source = `# test

services:
  nginx:
    image: nginx # herpin and derpin 2
`
  const doc = yamlToComposeDocument(source)
  assertEquals(doc.presentation.documentCommentBefore?.includes('test'), true)
  assertEquals(doc.presentation.comments.services?.keyBefore, undefined)

  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.startsWith('# test\n'), true)
  assertEquals(roundTrip.includes('# test\n\nservices:'), true)
  assertEquals(roundTrip.includes('image: nginx # herpin and derpin 2'), true)
})

test('yaml round-trip keeps leading comments glued to the first key', () => {
  const source = `# test
services:
  nginx:
    image: nginx
`
  const doc = yamlToComposeDocument(source)
  assertEquals(doc.presentation.documentCommentBefore, undefined)
  assertEquals(doc.presentation.comments.services?.keyBefore?.includes('test'), true)

  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.includes('# test'), true)
  assertEquals(roundTrip.indexOf('# test') < roundTrip.indexOf('services:'), true)
})

test('yaml round-trip keeps trailing document comments', () => {
  const source = `services:
  nginx:
    image: nginx
# trailing
`
  const doc = yamlToComposeDocument(source)
  assertEquals(doc.presentation.documentComment?.includes('trailing'), true)
  assertEquals(composeDocumentToYaml(doc).includes('# trailing'), true)
})

test('yaml round-trip keeps trailing scalar comments', () => {
  const source = `services:
  nginx:
    image: nginx:alpine # line comment
`
  const roundTrip = composeDocumentToYaml(yamlToComposeDocument(source))
  assertEquals(roundTrip.includes('# line comment'), true)
  assertEquals(roundTrip.includes('image: nginx:alpine # line comment'), true)
})

test('yaml round-trip keeps sequence-item trailing comments', () => {
  const source = `services:
  uptime-kuma:
    image: louislam/uptime-kuma:2
    ports:
      - "3001:3001"  # This maps the container port
    volumes:
      - /path/to/data:/app/data  # Configuring persistent storage
    environment:
      - TZ=UTC  # Set the timezone
`
  const doc = yamlToComposeDocument(source)
  assertEquals(
    doc.presentation.comments['services.uptime-kuma.ports[0]']?.inline?.includes(
      'This maps the container port',
    ),
    true,
  )
  assertEquals(
    doc.presentation.comments['services.uptime-kuma.volumes[0]']?.inline?.includes(
      'Configuring persistent storage',
    ),
    true,
  )
  assertEquals(
    doc.presentation.comments['services.uptime-kuma.environment[0]']?.inline?.includes(
      'Set the timezone',
    ),
    true,
  )
  const roundTrip = composeDocumentToYaml(doc)
  assertEquals(roundTrip.includes('# This maps the container port'), true)
  assertEquals(roundTrip.includes('# Configuring persistent storage'), true)
  assertEquals(roundTrip.includes('# Set the timezone'), true)
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

test('emptyComposeDocument validates as a blank draft', () => {
  const empty = emptyComposeDocument()
  assertEquals(empty.data, {})
  assertEquals(empty.presentation.keyOrder, [])
  const result = validateComposeDocument(empty)
  assertEquals(result.ok, true)
  assertEquals(composeDocumentToYaml(empty), '\n')
  assertEquals(composeDocumentToRuntimeYaml(empty), '\n')
})

test('validateComposeDocument accepts blank data without services', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {},
    presentation: { keyOrder: [], comments: {} },
  })
  assertEquals(result.ok, true)
})

test('yamlToComposeDocument treats blank source as empty draft', () => {
  assertEquals(yamlToComposeDocument(''), emptyComposeDocument())
  assertEquals(yamlToComposeDocument('\n'), emptyComposeDocument())
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

const PLACEMENT_UUID = '01989d42-9adb-7e65-bc2e-f38792c53691'

function documentWithPlacement(serverId: unknown): ReturnType<typeof emptyComposeDocument> {
  return {
    version: 1,
    data: {
      services: {},
      [TURBOPANEL_EXTENSION_KEY]: {
        placement: { server_id: serverId },
      },
    },
    presentation: { keyOrder: ['services', TURBOPANEL_EXTENSION_KEY], comments: {} },
  }
}

test('readComposePlacementServerId returns valid server_id', () => {
  const doc = documentWithPlacement(PLACEMENT_UUID)
  assertEquals(readComposePlacementServerId(doc), PLACEMENT_UUID)
})

test('readComposePlacementServerId returns null when absent', () => {
  assertEquals(readComposePlacementServerId(emptyComposeDocument()), null)
})

test('readComposePlacementServerId returns null for malformed shapes', () => {
  assertEquals(
    readComposePlacementServerId({
      version: 1,
      data: { services: {}, [TURBOPANEL_EXTENSION_KEY]: 'nope' },
      presentation: { keyOrder: ['services'], comments: {} },
    }),
    null,
  )
  assertEquals(
    readComposePlacementServerId({
      version: 1,
      data: {
        services: {},
        [TURBOPANEL_EXTENSION_KEY]: { placement: [] },
      },
      presentation: { keyOrder: ['services'], comments: {} },
    }),
    null,
  )
  assertEquals(readComposePlacementServerId(documentWithPlacement(123)), null)
  assertEquals(readComposePlacementServerId(documentWithPlacement('')), null)
  assertEquals(readComposePlacementServerId(documentWithPlacement('   ')), null)
})

test('validateComposeDocument rejects non-UUID server_id', () => {
  const result = validateComposeDocument(documentWithPlacement('not-a-uuid'))
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.issues.some((i) => i.path === 'x-turbopanel.placement.server_id'),
      true,
    )
  }
})

test('validateComposeDocument rejects non-string server_id', () => {
  const result = validateComposeDocument(documentWithPlacement(123))
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.issues.some((i) => i.path === 'x-turbopanel.placement.server_id'),
      true,
    )
  }
})

test('validateComposeDocument accepts valid placement', () => {
  const result = validateComposeDocument(documentWithPlacement(PLACEMENT_UUID))
  assertEquals(result.ok, true)
})

test('validateComposeDocument remains backward compatible without x-turbopanel', () => {
  const result = validateComposeDocument({
    version: 1,
    data: { services: { api: { image: 'node:22' } } },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(result.ok, true)
})

test('x-turbopanel survives YAML convert round-trip', () => {
  const doc = documentWithPlacement(PLACEMENT_UUID)
  const runtime = composeDocumentToRuntimeYaml(doc)
  assertEquals(runtime.includes('x-turbopanel:'), true)
  assertEquals(runtime.includes(PLACEMENT_UUID), true)

  const editor = composeDocumentToYaml(doc)
  assertEquals(editor.includes('x-turbopanel:'), true)
  assertEquals(editor.includes(PLACEMENT_UUID), true)

  const fromYaml = yamlToComposeDocument(`
services: {}
x-turbopanel:
  placement:
    server_id: ${PLACEMENT_UUID}
`)
  assertEquals(readComposePlacementServerId(fromYaml), PLACEMENT_UUID)
})
