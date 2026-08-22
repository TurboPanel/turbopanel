import { describe, expect, it } from 'vitest'
import { executionLogStoreConformanceCases } from './execution-log-store.conformance.ts'
import { createFakeR2Bucket } from './fake-r2-bucket.ts'
import { R2ExecutionLogStore } from './r2-store.ts'

/**
 * Workers-pool run of the shared conformance suite.
 *
 * The point of running it here as well as under Deno is the runtime, not the
 * bucket: `seal()` depends on workerd's `CompressionStream`/`DecompressionStream`
 * and its `Blob`/`Response` byte handling, none of which the Deno run exercises.
 */
describe('R2ExecutionLogStore (workerd)', () => {
  for (const testCase of executionLogStoreConformanceCases) {
    it(testCase.name, async () => { // NOSONAR typescript:S2699 — assertions live inside the shared conformance case
      await testCase.run(new R2ExecutionLogStore(createFakeR2Bucket()))
    })
  }

  it('round-trips a sealed transcript through workerd gzip', async () => {
    const store = new R2ExecutionLogStore(createFakeR2Bucket())
    const line = 'workerd gzip round-trip\n'
    await store.appendChunk('cmd-gzip', { seq: 0, bytes: new TextEncoder().encode(line) })
    await store.seal('cmd-gzip')

    const read = await store.readFrom('cmd-gzip', 0, 4096)
    expect(read).not.toBeNull()
    expect(new TextDecoder().decode(read!.bytes)).toBe(line)
    expect(read!.sealed).toBe(true)
  })
})
