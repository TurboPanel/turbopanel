import { assertEquals } from 'jsr:@std/assert'
import { describe, it } from '@std/testing/bdd'
import { parseServiceIdsField, pickSolePrincipalId } from './assignments.ts'

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

describe('pickSolePrincipalId', () => {
  it('returns none when empty', () => {
    assertEquals(pickSolePrincipalId([]), { status: 'none' })
  })

  it('returns the sole id', () => {
    assertEquals(
      pickSolePrincipalId(['00000000-0000-4000-8000-000000000001']),
      {
        status: 'one',
        principalId: '00000000-0000-4000-8000-000000000001',
      },
    )
  })

  it('returns ambiguous when more than one', () => {
    assertEquals(
      pickSolePrincipalId([
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
      ]),
      { status: 'ambiguous' },
    )
  })
})
