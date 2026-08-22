import { assertEquals, assertThrows } from '@std/assert'
import {
  ComposeParseError,
  composeDocumentToRuntimeYaml,
  composeDocumentToYaml,
  emptyComposeDocument,
  mergeComposeOverlay,
  normalizeCompose,
  stripComposePlacement,
  TURBOPANEL_EXTENSION_KEY,
  validateComposeDocument,
  yamlToComposeDocument,
} from './index.ts'
import { isPlacementServerId } from './placement.ts'
import {
  applyValidatedComposeOption,
  assertComposeDocument,
  stripComposePlacementOption,
  stripProjectComposePlacementOption,
} from './validate.ts'

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
  assertEquals(composeDocumentToYaml(empty), '')
  assertEquals(composeDocumentToRuntimeYaml(empty), '')
})

test('validateComposeDocument accepts blank data without services', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {},
    presentation: { keyOrder: [], comments: {} },
  })
  assertEquals(result.ok, true)
})

test('validateComposeDocument rejects services missing image/build', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: {
        nginx: { imaage: 'nginx' },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(result.ok, false)
  if (result.ok) return
  assertEquals(result.issues.some((issue) => issue.message.includes('image')), true)
})

test('yamlToComposeDocument treats blank source as empty draft', () => {
  assertEquals(yamlToComposeDocument(''), emptyComposeDocument())
  assertEquals(yamlToComposeDocument('\n'), emptyComposeDocument())
})

test('yamlToComposeDocument treats services: {} as an empty draft', () => {
  assertEquals(yamlToComposeDocument('services: {}\n'), emptyComposeDocument())
  assertEquals(composeDocumentToYaml({
    version: 1,
    data: { services: {} },
    presentation: { keyOrder: ['services'], comments: {} },
  }), '')
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

/** Test-only helper: read `x-turbopanel.placement.server_id` for assertions. */
function placementServerId(document: ReturnType<typeof emptyComposeDocument>): unknown {
  const extension = document.data[TURBOPANEL_EXTENSION_KEY]
  if (typeof extension !== 'object' || extension === null || Array.isArray(extension)) {
    return undefined
  }
  const placement = (extension as Record<string, unknown>).placement
  if (typeof placement !== 'object' || placement === null || Array.isArray(placement)) {
    return undefined
  }
  return (placement as Record<string, unknown>).server_id
}

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

test('validateComposeDocument rejects embedded placement', () => {
  const result = validateComposeDocument(documentWithPlacement(PLACEMENT_UUID))
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.issues.some((i) => i.path === 'x-turbopanel.placement'),
      true,
    )
  }
})

test('validateComposeDocument remains valid without x-turbopanel', () => {
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
  assertEquals(placementServerId(fromYaml), PLACEMENT_UUID)
})

test('stripComposePlacement removes placement-only extension', () => {
  const stripped = stripComposePlacement(documentWithPlacement(PLACEMENT_UUID))
  assertEquals(placementServerId(stripped), undefined)
  assertEquals(TURBOPANEL_EXTENSION_KEY in stripped.data, false)
  assertEquals(stripped.presentation.keyOrder.includes(TURBOPANEL_EXTENSION_KEY), false)
})

test('stripComposePlacement preserves unrelated x-turbopanel fields', () => {
  const doc = {
    version: 1 as const,
    data: {
      services: {},
      [TURBOPANEL_EXTENSION_KEY]: {
        placement: { server_id: PLACEMENT_UUID },
        future: { keep: true },
      },
    },
    presentation: { keyOrder: ['services', TURBOPANEL_EXTENSION_KEY], comments: {} },
  }
  const stripped = stripComposePlacement(doc)
  assertEquals(placementServerId(stripped), undefined)
  assertEquals(stripped.data[TURBOPANEL_EXTENSION_KEY], { future: { keep: true } })
})

test('mergeComposeOverlay after stripComposePlacement ignores project pin', () => {
  const projectPin = crypto.randomUUID()
  const envPin = PLACEMENT_UUID
  const base = documentWithPlacement(projectPin)
  const overlay = documentWithPlacement(envPin)
  const merged = mergeComposeOverlay(stripComposePlacement(base), overlay)
  assertEquals(placementServerId(merged), envPin)
  assertEquals(composeDocumentToRuntimeYaml(merged).includes(projectPin), false)
})

test('mergeComposeOverlay merges presentation metadata from overlay', () => {
  const base = emptyComposeDocument()
  base.data = { services: { web: { image: 'nginx' } } }
  base.presentation = {
    keyOrder: ['services'],
    comments: { services: { keyBefore: 'base comment' } },
    documentCommentBefore: 'base before',
    documentComment: 'base after',
    editorView: 'editor',
  }

  const overlay = emptyComposeDocument()
  overlay.data = { networks: { front: {} } }
  overlay.presentation = {
    keyOrder: ['networks'],
    comments: { networks: { keyBefore: 'overlay comment' } },
    blankLines: { networks: 1 },
    editorView: 'visual',
  }

  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(merged.presentation.comments.services?.keyBefore, 'base comment')
  assertEquals(merged.presentation.comments.networks?.keyBefore, 'overlay comment')
  assertEquals(merged.presentation.documentCommentBefore, 'base before')
  assertEquals(merged.presentation.documentComment, 'base after')
  assertEquals(merged.presentation.blankLines, { networks: 1 })
  assertEquals(merged.presentation.editorView, 'visual')
})

test('mergeComposeOverlay with null overlay returns base unchanged', () => {
  const base = emptyComposeDocument()
  base.data = { services: { web: { image: 'nginx' } } }
  assertEquals(mergeComposeOverlay(base, null), base)
})

test('mergeComposeOverlay deepMerge skips undefined overlay values', () => {
  const base = emptyComposeDocument()
  base.data = { services: { web: { image: 'nginx', ports: ['80:80'] } } }
  const overlay = emptyComposeDocument()
  overlay.data = { services: { web: { image: undefined, restart: 'always' } } }
  const merged = mergeComposeOverlay(base, overlay)
  const web = (merged.data.services as Record<string, Record<string, unknown>>).web!
  assertEquals(web.image, 'nginx')
  assertEquals(web.restart, 'always')
})

test('isPlacementServerId accepts UUID-shaped server ids', () => {
  assertEquals(isPlacementServerId(PLACEMENT_UUID), true)
  assertEquals(isPlacementServerId('not-a-uuid'), false)
  assertEquals(isPlacementServerId(''), false)
})

test('validateComposeDocument rejects non-mapping services', () => {
  const result = validateComposeDocument({
    version: 1,
    data: { services: ['bad'] },
    presentation: { keyOrder: ['services'], comments: {} },
  })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.issues[0]?.path, 'services')
  }
})

test('validateComposeDocument rejects non-mapping x-turbopanel extension', () => {
  const result = validateComposeDocument({
    version: 1,
    data: {
      services: { api: { image: 'node:22' } },
      [TURBOPANEL_EXTENSION_KEY]: 'bad',
    },
    presentation: { keyOrder: ['services', TURBOPANEL_EXTENSION_KEY], comments: {} },
  })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.issues.some((issue) => issue.path === 'x-turbopanel'), true)
  }
})

test('assertComposeDocument throws with joined issue messages', () => {
  assertThrows(
    () => assertComposeDocument({ version: 2 }),
    TypeError,
    'must be a ComposeDocument',
  )
})

test('applyValidatedComposeOption normalizes compose in options', () => {
  const options: Record<string, unknown> = {
    compose: {
      version: 1,
      data: { services: { api: { image: 'node:22' } } },
      presentation: { keyOrder: ['services'], comments: {} },
    },
  }
  const result = applyValidatedComposeOption(options)
  assertEquals(result.ok, true)
  assertEquals((options.compose as { version: number }).version, 1)
})

test('stripComposePlacementOption removes placement from options.compose', () => {
  const options: Record<string, unknown> = {
    compose: documentWithPlacement(PLACEMENT_UUID),
  }
  stripComposePlacementOption(options)
  assertEquals(placementServerId(options.compose as ReturnType<typeof emptyComposeDocument>), undefined)
  stripProjectComposePlacementOption(null)
  stripComposePlacementOption({ other: true })
})
