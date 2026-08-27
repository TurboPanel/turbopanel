import { assertEquals } from '@std/assert'
import { stripComposeTurbopanelExtensions } from './extensions.ts'
import { TURBOPANEL_EXTENSION_KEY } from './placement.ts'
import {
  composeTagOf,
  makeComposeTag,
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

function doc(
  data: Record<string, unknown>,
  presentation?: ComposeDocument['presentation'],
): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: presentation ?? {
      keyOrder: Object.keys(data),
      comments: {},
    },
  }
}

test('stripComposeTurbopanelExtensions is a no-op when nothing to strip', () => {
  const input = doc({
    services: {
      web: { image: 'nginx' },
    },
  })
  const output = stripComposeTurbopanelExtensions(input)
  assertEquals(output, input)
})

test('stripComposeTurbopanelExtensions removes top-level extension and keyOrder entry', () => {
  const input = doc({
    [TURBOPANEL_EXTENSION_KEY]: { meta: true },
    services: { web: { image: 'nginx' } },
  })
  const output = stripComposeTurbopanelExtensions(input)
  assertEquals(TURBOPANEL_EXTENSION_KEY in output.data, false)
  assertEquals(output.presentation.keyOrder.includes(TURBOPANEL_EXTENSION_KEY), false)
  assertEquals(
    (output.data.services as Record<string, Record<string, unknown>>).web.image,
    'nginx',
  )
})

test('stripComposeTurbopanelExtensions removes per-service x-turbopanel', () => {
  const input = doc({
    services: {
      web: {
        image: 'nginx',
        'x-turbopanel': { description: 'hidden', serviceKind: 'container' },
      },
    },
  })
  const output = stripComposeTurbopanelExtensions(input)
  const web = (output.data.services as Record<string, Record<string, unknown>>).web
  assertEquals('x-turbopanel' in web, false)
  assertEquals(web.image, 'nginx')
})

test('stripComposeTurbopanelExtensions strips placement before full extension removal', () => {
  const input = doc({
    [TURBOPANEL_EXTENSION_KEY]: {
      placement: { server_id: '01989d42-9adb-7e65-bc2e-f38792c53691' },
      keep: true,
    },
    services: {
      web: {
        image: 'nginx',
        'x-turbopanel': { description: 'note' },
      },
    },
  })
  const output = stripComposeTurbopanelExtensions(input)
  assertEquals(TURBOPANEL_EXTENSION_KEY in output.data, false)
  const web = (output.data.services as Record<string, Record<string, unknown>>).web
  assertEquals('x-turbopanel' in web, false)
})

test('stripComposeTurbopanelExtensions preserves unrelated presentation fields', () => {
  const input: ComposeDocument = {
    version: 1,
    data: {
      [TURBOPANEL_EXTENSION_KEY]: { meta: true },
      services: { web: { image: 'nginx' } },
    },
    presentation: {
      keyOrder: [TURBOPANEL_EXTENSION_KEY, 'services'],
      comments: { services: { keyBefore: 'svc comment' } },
      blankLines: { services: 1 },
      documentCommentBefore: 'before doc',
      documentComment: 'after doc',
      editorView: 'visual',
    },
  }
  const output = stripComposeTurbopanelExtensions(input)
  assertEquals(output.presentation.comments.services?.keyBefore, 'svc comment')
  assertEquals(output.presentation.blankLines, { services: 1 })
  assertEquals(output.presentation.documentCommentBefore, 'before doc')
  assertEquals(output.presentation.documentComment, 'after doc')
  assertEquals(output.presentation.editorView, 'visual')
})

test('stripComposeTurbopanelExtensions looks through tagged services mapping', () => {
  const input = doc({
    services: makeComposeTag('override', {
      web: {
        image: 'nginx',
        'x-turbopanel': { description: 'strip me' },
      },
    }),
  })
  const output = stripComposeTurbopanelExtensions(input)
  assertEquals(composeTagOf(output.data.services), 'override')
  const web = (unwrapComposeTag(output.data.services) as Record<string, Record<string, unknown>>)
    .web
  assertEquals('x-turbopanel' in web, false)
  assertEquals(web.image, 'nginx')
})

test('stripComposeTurbopanelExtensions looks through tagged service body', () => {
  const input = doc({
    services: {
      web: makeComposeTag('reset', {
        image: 'nginx',
        'x-turbopanel': { description: 'gone' },
      }),
    },
  })
  const output = stripComposeTurbopanelExtensions(input)
  const web = (output.data.services as Record<string, unknown>).web
  assertEquals(composeTagOf(web), 'reset')
  assertEquals(unwrapComposeTag(web), { image: 'nginx' })
})

test('stripComposeTurbopanelExtensions leaves a tagged non-mapping services value unchanged', () => {
  const input = doc({
    services: makeComposeTag('override', ['web']),
  })
  const output = stripComposeTurbopanelExtensions(input)
  assertEquals(composeTagOf(output.data.services), 'override')
  assertEquals(unwrapComposeTag(output.data.services), ['web'])
})

test('stripComposeTurbopanelExtensions leaves a tagged service body without an extension unchanged', () => {
  const input = doc({
    services: {
      web: makeComposeTag('override', { image: 'nginx' }),
    },
  })
  const output = stripComposeTurbopanelExtensions(input)
  const web = (output.data.services as Record<string, unknown>).web
  assertEquals(composeTagOf(web), 'override')
  assertEquals(unwrapComposeTag(web), { image: 'nginx' })
})
