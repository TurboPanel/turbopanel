import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { DisabledExecutionLogStore } from './disabled-store.ts'

describe('DisabledExecutionLogStore', () => {
  it('reports append seq as already consumed', async () => {
    const store = new DisabledExecutionLogStore()
    const result = await store.appendChunk('cmd-1', {
      seq: 4,
      bytes: new TextEncoder().encode('line'),
    })
    assertEquals(result, { nextSeq: 5 })
  })

  it('never retains transcripts', async () => {
    const store = new DisabledExecutionLogStore()
    assertEquals(await store.readFrom('cmd-1', 0, 1024), null)
    assertEquals(await store.exists('cmd-1'), false)
    assertEquals(await store.seal('cmd-1'), null)
    await store.delete('cmd-1')
    assertEquals(await store.sweepExpired({ retentionDays: 30, limit: 10 }), 0)
  })
})
