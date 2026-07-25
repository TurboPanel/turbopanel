import { assertEquals } from 'jsr:@std/assert'
import { describe, it } from '@std/testing/bdd'
import { parseServiceIdsField } from './assignments.ts'

describe('parseServiceIdsField', () => {
  it('returns empty when serviceIds is omitted', () => {
    assertEquals(parseServiceIdsField({ username: 'app' }), [])
  })

  it('dedupes and sorts valid UUIDs', () => {
    const a = '00000000-0000-4000-8000-000000000001'
    const b = '00000000-0000-4000-8000-000000000002'
    assertEquals(parseServiceIdsField({ serviceIds: [b, a, b] }), [a, b])
  })

  it('rejects non-array serviceIds', () => {
    assertEquals(parseServiceIdsField({ serviceIds: 'nope' }), null)
  })

  it('rejects invalid UUID entries', () => {
    assertEquals(parseServiceIdsField({ serviceIds: ['not-a-uuid'] }), null)
  })
})
