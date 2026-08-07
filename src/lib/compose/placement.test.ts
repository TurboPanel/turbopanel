import { assertEquals } from '@std/assert'
import {
  isPlacementServerId,
  stripComposePlacement,
  TURBOPANEL_EXTENSION_KEY,
} from './placement.ts'
import { emptyComposeDocument, normalizeCompose } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PLACEMENT_UUID = '01989d42-9adb-7e65-bc2e-f38792c53691'

test('isPlacementServerId rejects non-string values', () => {
  assertEquals(isPlacementServerId(PLACEMENT_UUID), true)
  assertEquals(isPlacementServerId(null), false)
  assertEquals(isPlacementServerId(undefined), false)
  assertEquals(isPlacementServerId(42), false)
})

test('stripComposePlacement is a no-op without placement key', () => {
  const doc = normalizeCompose({
    version: 1,
    data: {
      services: { api: { image: 'node:22' } },
      [TURBOPANEL_EXTENSION_KEY]: { future: { keep: true } },
    },
    presentation: { keyOrder: ['services', TURBOPANEL_EXTENSION_KEY], comments: {} },
  })
  assertEquals(stripComposePlacement(doc), doc)
})

test('stripComposePlacement is a no-op when x-turbopanel is absent', () => {
  const doc = emptyComposeDocument()
  doc.data = { services: { api: { image: 'node:22' } } }
  assertEquals(stripComposePlacement(doc), doc)
})

test('stripComposePlacement preserves presentation metadata when stripping placement', () => {
  const doc = normalizeCompose({
    version: 1,
    data: {
      services: {},
      [TURBOPANEL_EXTENSION_KEY]: {
        placement: { server_id: PLACEMENT_UUID },
        future: { keep: true },
      },
    },
    presentation: {
      keyOrder: ['services', TURBOPANEL_EXTENSION_KEY],
      comments: { services: { keyBefore: 'svc note' } },
      blankLines: { services: 1 },
      documentCommentBefore: 'before doc',
      documentComment: 'after doc',
      editorView: 'visual',
    },
  })
  const stripped = stripComposePlacement(doc)
  assertEquals(stripped.data[TURBOPANEL_EXTENSION_KEY], { future: { keep: true } })
  assertEquals(stripped.presentation.blankLines, { services: 1 })
  assertEquals(stripped.presentation.documentCommentBefore, 'before doc')
  assertEquals(stripped.presentation.documentComment, 'after doc')
  assertEquals(stripped.presentation.editorView, 'visual')
})
