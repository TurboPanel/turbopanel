import { assertEquals } from '@std/assert'
import { foldMemberTies } from './members-list.ts'

const test = Deno.test.bind(Deno)

test('foldMemberTies keeps one entry per person with the highest role and earliest date', () => {
  const folded = foldMemberTies([
    { userId: 'a', at: '2026-03-01T00:00:00.000Z' },
    { userId: 'a', at: '2026-01-01T00:00:00.000Z', permission: 'organization:manage' },
    { userId: 'a', at: '2026-02-01T00:00:00.000Z', permission: 'organization:own' },
    { userId: 'b', at: '2026-02-01T00:00:00.000Z' },
  ])
  assertEquals(folded.get('a'), { role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' })
  assertEquals(folded.get('b'), { role: 'member', joinedAt: '2026-02-01T00:00:00.000Z' })
  assertEquals(folded.size, 2)
})
