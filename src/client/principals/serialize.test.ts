import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { serializeProjectPrincipal } from './serialize.ts'
import type { principal } from '../../lib/db/schema.ts'

type PrincipalRow = typeof principal.$inferSelect

describe('serializeProjectPrincipal', () => {
  it('never includes password in serialized output', () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'system',
      provider: 'server',
      username: 'app',
      password: 'tpsecret.v1.must-not-leak',
      projectId: '00000000-0000-4000-8000-000000000002',
      managedId: null,
      metadata: { home: '/srv/users/app' },
      options: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as PrincipalRow

    const serialized = serializeProjectPrincipal(row, ['b-id', 'a-id'])
    assertEquals('password' in serialized, false)
    assertEquals(serialized.username, 'app')
    assertEquals(serialized.projectId, row.projectId)
    assertEquals(serialized.managedId, null)
    assertEquals(serialized.serviceIds, ['a-id', 'b-id'])
  })
})
