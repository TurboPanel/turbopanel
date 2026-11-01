import { assertEquals } from '@std/assert'
import { PINNED_BY_VALUES, resolvePinnedBy } from './pinned-by.ts'

const test = Deno.test.bind(Deno)

test('until the pin column exists every server reads as not pinned', () => {
  assertEquals(resolvePinnedBy({ id: 'srv-1' }), 'none')
  assertEquals(PINNED_BY_VALUES, ['install', 'upgrade', 'unsafe', 'none'])
})
