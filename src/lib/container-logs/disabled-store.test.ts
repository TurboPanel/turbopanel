import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { DisabledContainerLogStore } from './disabled-store.ts'
import type { ContainerLogEvent } from './types.ts'

const event: ContainerLogEvent = {
  timestamp: '2026-01-01T00:00:00.000Z',
  organizationId: '11111111-1111-4111-8111-111111111111',
  serverId: '22222222-2222-4222-8222-222222222222',
  environmentId: null,
  serviceId: null,
  containerId: 'abc123',
  stream: 'stdout',
  message: 'hello',
}

describe('DisabledContainerLogStore', () => {
  it('accepts ingest as a no-op', async () => {
    const store = new DisabledContainerLogStore()
    assertEquals(await store.ingest([event]), undefined)
    assertEquals(await store.ingest([]), undefined)
  })

  it('returns an empty exhausted page', async () => {
    const store = new DisabledContainerLogStore()
    const page = await store.query({
      organizationId: event.organizationId,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
    })
    assertEquals(page.events, [])
    assertEquals(page.nextCursor, null)
  })
})
