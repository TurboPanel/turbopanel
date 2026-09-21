/**
 * Driver-agnostic conformance cases for {@link ExecutionLogStore}.
 *
 * Not a `*.test.ts` file: it is imported by the Deno suites (filesystem, S3)
 * and the Workers/Vitest suite (R2), which each register the cases with their
 * own runner. Assertions are plain throws so this module stays importable from
 * both `@std/testing/bdd` and Vitest without a shared assertion dependency.
 */

import {
  EXECUTION_LOG_TRUNCATION_MARKER,
  ExecutionLogGapError,
  ExecutionLogSealedError,
  MAX_EXECUTION_LOG_TOTAL_BYTES,
  type ExecutionLogStore,
} from './types.ts'

/** Fresh, isolated store per case. May allocate a temp dir / fake bucket. */
export type ExecutionLogStoreFactory = () => Promise<{
  store: ExecutionLogStore
  cleanup?: () => Promise<void>
}>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`conformance: ${message}`)
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`conformance: ${message} (got ${String(actual)}, want ${String(expected)})`)
  }
}

async function readAllText(
  store: ExecutionLogStore,
  commandId: string
): Promise<string> {
  const result = await store.readFrom(commandId, 0, MAX_EXECUTION_LOG_TOTAL_BYTES)
  return result ? decoder.decode(result.bytes) : ''
}

const COMMAND_ID = '00000000-0000-7000-8000-000000000001'

export type ExecutionLogConformanceCase = {
  name: string
  run(store: ExecutionLogStore): Promise<void>
}

export const executionLogStoreConformanceCases: ExecutionLogConformanceCase[] = [
  {
    name: 'returns null for a command that never wrote a chunk',
    async run(store) {
      assertEquals(await store.readFrom(COMMAND_ID, 0, 1024), null, 'unwritten read is null')
      assertEquals(await store.exists(COMMAND_ID), false, 'unwritten exists is false')
      assertEquals(await store.seal(COMMAND_ID), null, 'sealing nothing returns null')
    },
  },
  {
    name: 'appends chunks in order and reads them back concatenated',
    async run(store) {
      const first = await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('alpha ') })
      assertEquals(first.nextSeq, 1, 'first append advances nextSeq')
      const second = await store.appendChunk(COMMAND_ID, { seq: 1, bytes: encoder.encode('beta') })
      assertEquals(second.nextSeq, 2, 'second append advances nextSeq')

      assertEquals(await readAllText(store, COMMAND_ID), 'alpha beta', 'full transcript')
      assertEquals(await store.exists(COMMAND_ID), true, 'exists after append')
    },
  },
  {
    name: 'resumes from a sequence without re-emitting earlier chunks',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('one\n') })
      await store.appendChunk(COMMAND_ID, { seq: 1, bytes: encoder.encode('two\n') })
      await store.appendChunk(COMMAND_ID, { seq: 2, bytes: encoder.encode('three\n') })

      const tail = await store.readFrom(COMMAND_ID, 1, 1024)
      assert(tail, 'tail read present')
      assertEquals(decoder.decode(tail.bytes), 'two\nthree\n', 'tail transcript')
      assertEquals(tail.nextSeq, 3, 'tail nextSeq')
      assertEquals(tail.sealed, false, 'tail not sealed')
    },
  },
  {
    name: 'treats a replayed sequence as a no-op',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('once') })
      const replay = await store.appendChunk(COMMAND_ID, {
        seq: 0,
        bytes: encoder.encode('once'),
      })
      assertEquals(replay.nextSeq, 1, 'replay reports the current nextSeq')
      assertEquals(await readAllText(store, COMMAND_ID), 'once', 'replay does not duplicate')
    },
  },
  {
    name: 'rejects a sequence gap with the expected sequence',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('a') })
      let thrown: unknown
      try {
        await store.appendChunk(COMMAND_ID, { seq: 5, bytes: encoder.encode('b') })
      } catch (err) {
        thrown = err
      }
      assert(thrown instanceof ExecutionLogGapError, 'gap raises ExecutionLogGapError')
      assertEquals(thrown.expectedSeq, 1, 'gap reports the expected seq')
      assertEquals(await readAllText(store, COMMAND_ID), 'a', 'gap wrote nothing')
    },
  },
  {
    name: 'seals a transcript, keeps it readable, and rejects later appends',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('start\n') })
      await store.appendChunk(COMMAND_ID, { seq: 1, bytes: encoder.encode('end\n') })

      const sealed = await store.seal(COMMAND_ID)
      assert(sealed, 'seal returns a result')
      assertEquals(sealed.bytes, 'start\nend\n'.length, 'sealed size is the uncompressed length')

      const read = await store.readFrom(COMMAND_ID, 0, 1024)
      assert(read, 'sealed read present')
      assertEquals(decoder.decode(read.bytes), 'start\nend\n', 'sealed transcript survives compaction')
      assertEquals(read.sealed, true, 'sealed flag set')

      let thrown: unknown
      try {
        await store.appendChunk(COMMAND_ID, { seq: 2, bytes: encoder.encode('late') })
      } catch (err) {
        thrown = err
      }
      assert(thrown instanceof ExecutionLogSealedError, 'append after seal is rejected')
    },
  },
  {
    name: 'reads a sealed transcript from an offset',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('head\n') })
      await store.appendChunk(COMMAND_ID, { seq: 1, bytes: encoder.encode('tail\n') })
      await store.seal(COMMAND_ID)

      const tail = await store.readFrom(COMMAND_ID, 1, 1024)
      assert(tail, 'sealed tail read present')
      assertEquals(decoder.decode(tail.bytes), 'tail\n', 'sealed tail slice')
      assertEquals(tail.nextSeq, 2, 'sealed tail nextSeq')
    },
  },
  {
    name: 'is idempotent on repeated seal',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('x') })
      const first = await store.seal(COMMAND_ID)
      const second = await store.seal(COMMAND_ID)
      assert(first && second, 'both seals return a result')
      assertEquals(second.bytes, first.bytes, 'repeat seal reports the same size')
      assertEquals(await readAllText(store, COMMAND_ID), 'x', 'repeat seal preserves the transcript')
    },
  },
  {
    name: 'truncates past the total-byte cap and marks the transcript',
    async run(store) {
      // Fill exactly to the cap with the largest chunks the contract allows.
      const chunk = new Uint8Array(256 * 1024).fill(0x61)
      const chunkCount = MAX_EXECUTION_LOG_TOTAL_BYTES / chunk.byteLength
      for (let seq = 0; seq < chunkCount; seq++) {
        await store.appendChunk(COMMAND_ID, { seq, bytes: chunk })
      }

      const overflow = await store.appendChunk(COMMAND_ID, {
        seq: chunkCount,
        bytes: encoder.encode('dropped'),
      })
      assertEquals(overflow.nextSeq, chunkCount + 1, 'overflow still advances nextSeq')

      const read = await store.readFrom(COMMAND_ID, chunkCount, 4096)
      assert(read, 'overflow read present')
      assertEquals(read.truncated, true, 'truncation flag set')
      assertEquals(
        decoder.decode(read.bytes),
        EXECUTION_LOG_TRUNCATION_MARKER,
        'truncation marker is part of the transcript'
      )

      // The marker is written exactly once, no matter how much more arrives.
      await store.appendChunk(COMMAND_ID, {
        seq: chunkCount + 1,
        bytes: encoder.encode('also dropped'),
      })
      const after = await store.readFrom(COMMAND_ID, chunkCount, 4096)
      assert(after, 'post-overflow read present')
      assertEquals(
        decoder.decode(after.bytes),
        EXECUTION_LOG_TRUNCATION_MARKER,
        'truncation marker is not repeated'
      )
    },
  },
  {
    name: 'keeps byte offsets stable when a read window starts mid-chunk',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('0123456789') })
      await store.appendChunk(COMMAND_ID, { seq: 1, bytes: encoder.encode('abcdefghij') })

      // A budget smaller than the pending chunk must still make progress, and
      // must not leave `nextSeq` past a chunk it only partially returned.
      const partial = await store.readFrom(COMMAND_ID, 0, 4)
      assert(partial, 'partial read present')
      assertEquals(decoder.decode(partial.bytes), '0123', 'partial slice starts at the window')
      assertEquals(partial.nextSeq, 0, 'partial read does not consume the chunk')

      const rest = await store.readFrom(COMMAND_ID, 1, 1024)
      assert(rest, 'second read present')
      assertEquals(decoder.decode(rest.bytes), 'abcdefghij', 'second chunk reads whole')
    },
  },
  {
    name: 'writes each sequence at the offset the index recorded',
    async run(store) {
      // Interleave sizes so a mis-assembled read (concatenating whatever came
      // back instead of honoring offsets) produces visibly wrong output.
      const chunks = ['a', 'bbbb', 'cc', 'dddddddd', 'e']
      for (const [seq, text] of chunks.entries()) {
        await store.appendChunk(COMMAND_ID, { seq, bytes: encoder.encode(text) })
      }
      assertEquals(await readAllText(store, COMMAND_ID), chunks.join(''), 'offsets are stable')

      await store.seal(COMMAND_ID)
      assertEquals(
        await readAllText(store, COMMAND_ID),
        chunks.join(''),
        'offsets survive compaction'
      )
    },
  },
  {
    name: 'is idempotent when the same sequence is written twice in a row',
    async run(store) {
      // Models a crash between the chunk write and the index update: the daemon
      // resends the same seq, which must not double-append.
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('head') })
      await store.appendChunk(COMMAND_ID, { seq: 1, bytes: encoder.encode('tail') })
      await store.appendChunk(COMMAND_ID, { seq: 1, bytes: encoder.encode('tail') })
      assertEquals(await readAllText(store, COMMAND_ID), 'headtail', 'no duplicate bytes')

      const read = await store.readFrom(COMMAND_ID, 0, 1024)
      assert(read, 'read present')
      assertEquals(read.nextSeq, 2, 'nextSeq reflects two chunks, not three')
    },
  },
  {
    name: 'deletes a transcript so it reads as never-started again',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('gone') })
      await store.delete(COMMAND_ID)
      assertEquals(await store.readFrom(COMMAND_ID, 0, 1024), null, 'deleted read is null')
      assertEquals(await store.exists(COMMAND_ID), false, 'deleted exists is false')
      // Deleting again must not throw.
      await store.delete(COMMAND_ID)
    },
  },
  {
    name: 'sweeps transcripts past the retention window and keeps fresh ones',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('fresh') })

      // Retention measured from "now": a transcript written this instant is not
      // yet expired, so a 1-day sweep must leave it alone.
      assertEquals(
        await store.sweepExpired({ retentionDays: 1, limit: 10 }),
        0,
        'fresh transcript is not swept'
      )
      assertEquals(await store.exists(COMMAND_ID), true, 'fresh transcript survives')

      // Move the sweep clock forward past retention and it is removed.
      const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      const removed = await store.sweepExpired({ retentionDays: 1, limit: 10, now: future })
      assertEquals(removed, 1, 'expired transcript is swept')
      assertEquals(await store.exists(COMMAND_ID), false, 'expired transcript is gone')
    },
  },
  {
    name: 'sweeps a transcript whose partition is far older than the cutoff',
    async run(store) {
      await store.appendChunk(COMMAND_ID, { seq: 0, bytes: encoder.encode('ancient') })

      // A sweep clock a year past the write puts this partition hundreds of
      // days behind the cutoff — far outside any fixed lookback band. It must
      // still be reached, otherwise long-idle installs (or a shortened
      // retention window) keep orphaned transcripts forever.
      const muchLater = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000)
      const removed = await store.sweepExpired({
        retentionDays: 30,
        limit: 10,
        now: muchLater,
      })
      assertEquals(removed, 1, 'far-expired transcript is swept')
      assertEquals(await store.exists(COMMAND_ID), false, 'far-expired transcript is gone')
    },
  },
]

/** Run every conformance case against a factory, for runners without per-case registration. */
export async function runExecutionLogStoreConformance(
  factory: ExecutionLogStoreFactory
): Promise<void> {
  for (const testCase of executionLogStoreConformanceCases) {
    const { store, cleanup } = await factory()
    try {
      await testCase.run(store)
    } catch (err) {
      throw new Error(`${testCase.name}: ${String(err)}`, { cause: err })
    } finally {
      await cleanup?.()
    }
  }
}
