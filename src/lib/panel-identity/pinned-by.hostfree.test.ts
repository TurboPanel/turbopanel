import { assertEquals } from '@std/assert'
import { PINNED_BY_VALUES, resolvePinnedBy } from './pinned-by.ts'

const test = Deno.test.bind(Deno)

test('the pin column is read as reported; anything else is not pinned', () => {
  assertEquals(resolvePinnedBy({ trustPinnedBy: 'install' }), 'install')
  assertEquals(resolvePinnedBy({ trustPinnedBy: 'upgrade' }), 'upgrade')
  assertEquals(resolvePinnedBy({ trustPinnedBy: 'unsafe' }), 'unsafe')
  assertEquals(resolvePinnedBy({ trustPinnedBy: null }), 'none')
  assertEquals(resolvePinnedBy({ trustPinnedBy: 'other' }), 'none')
  assertEquals(resolvePinnedBy({}), 'none')
  assertEquals(PINNED_BY_VALUES, ['install', 'upgrade', 'unsafe', 'none'])
})
