import { assertEquals } from '@std/assert'
import {
  emptyComposeDocument,
  isBlankComposeData,
  isComposeDocument,
  isComposeEditorView,
  normalizeCompose,
  pruneBlankComposeData,
} from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isComposeDocument rejects invalid shapes', () => {
  assertEquals(isComposeDocument(null), false)
  assertEquals(isComposeDocument([]), false)
  assertEquals(isComposeDocument({ version: 2, data: {}, presentation: { keyOrder: [], comments: {} } }), false)
  assertEquals(isComposeDocument({ version: 1, data: null, presentation: { keyOrder: [], comments: {} } }), false)
  assertEquals(isComposeDocument({ version: 1, data: {}, presentation: null }), false)
  assertEquals(isComposeDocument({ version: 1, data: {}, presentation: { keyOrder: 'bad', comments: {} } }), false)
  assertEquals(isComposeDocument({ version: 1, data: {}, presentation: { keyOrder: [], comments: [] } }), false)
})

test('isComposeEditorView accepts editor and visual only', () => {
  assertEquals(isComposeEditorView('editor'), true)
  assertEquals(isComposeEditorView('visual'), true)
  assertEquals(isComposeEditorView('yaml'), false)
})

test('isBlankComposeData treats empty mappings as blank', () => {
  assertEquals(isBlankComposeData({}), true)
  assertEquals(isBlankComposeData({ services: {} }), true)
  assertEquals(isBlankComposeData({ services: { web: { image: 'nginx' } } }), false)
})

test('pruneBlankComposeData drops empty top-level mappings', () => {
  assertEquals(
    pruneBlankComposeData({ services: {}, networks: { front: {} } }),
    { networks: { front: {} } },
  )
})

test('normalizeCompose drops invalid editorView and x-turbopanel keyOrder', () => {
  const normalized = normalizeCompose({
    version: 1,
    data: { services: { api: { image: 'node:22' } } },
    presentation: {
      keyOrder: ['x-turbopanel', 'services'],
      comments: {},
      editorView: 'bad',
    },
  })
  assertEquals(normalized.presentation.keyOrder, ['services'])
  assertEquals(normalized.presentation.editorView, undefined)
})

test('normalizeCompose keeps valid editorView and presentation comments', () => {
  const normalized = normalizeCompose({
    version: 1,
    data: { services: { api: { image: 'node:22' } } },
    presentation: {
      keyOrder: ['services'],
      comments: { services: { keyBefore: 'note' } },
      editorView: 'visual',
      documentCommentBefore: '  ',
      documentComment: '',
    },
  })
  assertEquals(normalized.presentation.editorView, 'visual')
  assertEquals(normalized.presentation.comments.services?.keyBefore, 'note')
  assertEquals(normalized.presentation.documentCommentBefore, '  ')
  assertEquals(normalized.presentation.documentComment, undefined)
})
