import { assertEquals } from '@std/assert'
import {
  composeDocumentToYaml,
  yamlToComposeDocument,
} from './convert.ts'
import { mergeComposeOverlay } from './merge.ts'
import {
  COMPOSE_TAG_KEY,
  composeTagOf,
  isComposeTaggedValue,
  makeComposeTag,
  resolveComposeTags,
  unwrapComposeTag,
} from './tags.ts'
import type { ComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('YAML → sentinel → YAML round-trip for !reset null / [] and !override forms', () => {
  const source = `services:
  web:
    image: nginx
    environment: !reset null
    labels: !reset []
    ports: !override
      - "9000:80"
    volumes: !override
      data: /data
    command: !override hello
`
  const doc = yamlToComposeDocument(source)
  const web = (doc.data.services as Record<string, Record<string, unknown>>).web

  assertEquals(isComposeTaggedValue(web.environment), true)
  assertEquals(composeTagOf(web.environment), 'reset')
  assertEquals(unwrapComposeTag(web.environment), null)

  assertEquals(isComposeTaggedValue(web.labels), true)
  assertEquals(unwrapComposeTag(web.labels), [])

  assertEquals(composeTagOf(web.ports), 'override')
  assertEquals(unwrapComposeTag(web.ports), ['9000:80'])

  assertEquals(composeTagOf(web.volumes), 'override')
  assertEquals(unwrapComposeTag(web.volumes), { data: '/data' })

  assertEquals(composeTagOf(web.command), 'override')
  assertEquals(unwrapComposeTag(web.command), 'hello')

  const out = composeDocumentToYaml(doc)
  assertEquals(out.includes('environment: !reset null'), true)
  assertEquals(out.includes('labels: !reset []'), true)
  assertEquals(out.includes('ports: !override'), true)
  assertEquals(out.includes('volumes: !override'), true)
  assertEquals(out.includes('command: !override hello'), true)

  // Second hop keeps sentinels.
  const again = yamlToComposeDocument(out)
  const web2 = (again.data.services as Record<string, Record<string, unknown>>).web
  assertEquals(composeTagOf(web2.environment), 'reset')
  assertEquals(composeTagOf(web2.ports), 'override')
})

test('sentinel survives JSON stringify/parse (jsonb proxy)', () => {
  const tagged = makeComposeTag('override', { ports: ['80:80'] })
  const cycle = JSON.parse(JSON.stringify(tagged)) as unknown
  assertEquals(isComposeTaggedValue(cycle), true)
  assertEquals(composeTagOf(cycle), 'override')
  assertEquals(unwrapComposeTag(cycle), { ports: ['80:80'] })
  assertEquals(
    (cycle as Record<string, unknown>)[COMPOSE_TAG_KEY],
    'override',
  )
})

test('merge: !reset deletes, !override replaces without append, base tags unwrap', () => {
  const base: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: {
          image: 'nginx',
          // Tags in the first file have no merge effect.
          ports: makeComposeTag('override', ['80:80']),
          environment: { FOO: '1' },
        },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  }
  const overlay: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: {
          ports: makeComposeTag('override', ['443:443']),
          environment: makeComposeTag('reset', null),
        },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  }

  const merged = mergeComposeOverlay(base, overlay)
  const web = (merged.data.services as Record<string, Record<string, unknown>>).web
  // Base tag unwrapped then override replaced — not append of both tag payloads.
  assertEquals(web.ports, ['443:443'])
  assertEquals('environment' in web, false)
  assertEquals(web.image, 'nginx')
})

test('resolveComposeTags unwraps nested sentinels', () => {
  const tree = {
    a: makeComposeTag('override', {
      b: makeComposeTag('reset', null),
      c: [makeComposeTag('override', 1)],
    }),
  }
  assertEquals(resolveComposeTags(tree), { a: { b: null, c: [1] } })
})

test('null overlay early-return still unwraps base tags', () => {
  const base: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: { ports: makeComposeTag('override', ['80:80']) },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  }
  const merged = mergeComposeOverlay(base, null)
  const web = (merged.data.services as Record<string, Record<string, unknown>>).web
  assertEquals(web.ports, ['80:80'])
  assertEquals(isComposeTaggedValue(web.ports), false)
})
