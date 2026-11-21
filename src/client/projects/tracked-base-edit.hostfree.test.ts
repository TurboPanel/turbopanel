import { assertEquals } from '@std/assert'
import { changesTrackedBase, keepTrackedBase } from './tracked-base-edit.ts'

const test = Deno.test

const SOURCE = {
  sourceId: 'src-1',
  path: 'compose.yaml',
  seededCommitSha: 'a'.repeat(40),
  seededDigest: 'b'.repeat(64),
  mode: 'track',
  lastReadCommitSha: 'c'.repeat(40),
  lastReadDigest: 'd'.repeat(64),
  lastReadAt: '2026-01-02T03:04:05.000Z',
}

const COMPOSE = {
  version: 1,
  data: { services: { web: { image: 'nginx:1', ports: ['80:80'] } } },
  presentation: { keyOrder: ['services'], comments: {} },
}

const STORED = { compose: COMPOSE, composeOverlays: [COMPOSE], composeSource: SOURCE }

test('settings alone, or the stored document sent back, are not a Base change', () => {
  assertEquals(changesTrackedBase({ containerNaming: 'custom' }, STORED), false)
  assertEquals(
    changesTrackedBase(
      { compose: COMPOSE, composeOverlays: [COMPOSE], composeSource: SOURCE },
      STORED
    ),
    false
  )
})

test('the same document with its keys in another order is not a change', () => {
  const reordered = {
    presentation: { comments: {}, keyOrder: ['services'] },
    data: { services: { web: { ports: ['80:80'], image: 'nginx:1' } } },
    version: 1,
  }
  assertEquals(changesTrackedBase({ compose: reordered }, STORED), false)
  assertEquals(
    changesTrackedBase(
      { compose: { ...reordered, data: { services: { web: { image: 'x' } } } } },
      STORED
    ),
    true
  )
})

test('overlays: unchanged is accepted, a changed or reordered list is a change, none equals empty', () => {
  assertEquals(changesTrackedBase({ composeOverlays: [COMPOSE] }, STORED), false)
  assertEquals(changesTrackedBase({ composeOverlays: [] }, STORED), true)
  assertEquals(changesTrackedBase({ composeOverlays: [] }, { compose: COMPOSE }), false)
  assertEquals(changesTrackedBase({ composeOverlays: [COMPOSE] }, { compose: COMPOSE }), true)
})

test('composeSource: unchanged or a different mode or last read is accepted, any other field is a change', () => {
  assertEquals(
    changesTrackedBase(
      { composeSource: { ...SOURCE, mode: 'seed', lastReadDigest: 'e'.repeat(64) } },
      STORED
    ),
    false
  )
  for (const field of [{ path: 'other.yaml' }, { ref: 'dev' }, { sourceId: 'src-2' }]) {
    assertEquals(changesTrackedBase({ composeSource: { ...SOURCE, ...field } }, STORED), true)
  }
  assertEquals(changesTrackedBase({ composeSource: null }, STORED), true)
})

test('keepTrackedBase puts the stored document back, or removes what the project does not have', () => {
  const options: Record<string, unknown> = { compose: { version: 1 }, composeOverlays: [] }
  keepTrackedBase(STORED, options)
  assertEquals(options.compose, COMPOSE)
  assertEquals(options.composeOverlays, [COMPOSE])
  keepTrackedBase({ compose: COMPOSE }, options)
  assertEquals('composeOverlays' in options, false)
})
