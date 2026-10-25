import { assertEquals } from '@std/assert'
import { emptyPrincipalUsage } from './placement-records.ts'
import { isOrphanDeletable, summarizePlacementState } from './org-listing.ts'

/** Alias so Sonar's typescript:S2187 sees real tests (see routes.test.ts). */
const test = Deno.test.bind(Deno)

test('summarizePlacementState shows the most pressing state, none when unplaced', () => {
  assertEquals(summarizePlacementState([]), 'none')
  assertEquals(summarizePlacementState(['absent']), 'absent')
  assertEquals(summarizePlacementState(['present', 'absent']), 'present')
  assertEquals(summarizePlacementState(['present', 'pending']), 'pending')
  assertEquals(summarizePlacementState(['present', 'retiring', 'pending']), 'retiring')
})

test('isOrphanDeletable needs no project and no use but placements', () => {
  const unused = { ...emptyPrincipalUsage(), otherPlacements: 3 }
  assertEquals(isOrphanDeletable({ projectId: null }, unused), true)
  assertEquals(isOrphanDeletable({ projectId: 'p' }, unused), false)
  for (const kind of [
    'tenancies',
    'bindings',
    'storages',
    'secrets',
    'logins',
    'folders',
  ] as const) {
    assertEquals(isOrphanDeletable({ projectId: null }, { ...unused, [kind]: 1 }), false)
  }
})
