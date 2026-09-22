import { assertEquals, assertThrows } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  applyExecutionLogTruncation,
  applyExecutionLogWrite,
  commandIdFromExecutionLogDataKey,
  createExecutionLogIndex,
  executionLogDatePartition,
  executionLogIndexKey,
  executionLogPartKey,
  executionLogSealedKey,
  parseExecutionLogDatePartition,
  parseExecutionLogIndex,
  planExecutionLogAppend,
  resolveExecutionLogReadWindow,
} from './index-model.ts'
import {
  ExecutionLogChunkTooLargeError,
  ExecutionLogGapError,
  ExecutionLogSealedError,
  MAX_EXECUTION_LOG_CHUNK_BYTES,
  MAX_EXECUTION_LOG_TOTAL_BYTES,
} from './types.ts'

const encoder = new TextEncoder()

function indexWithParts(lengths: number[]) {
  let index = createExecutionLogIndex('cmd', new Date('2026-08-21T00:00:00.000Z'))
  for (const [seq, length] of lengths.entries()) {
    index = applyExecutionLogWrite(
      index,
      { seq, offset: index.totalBytes, length },
      new Date('2026-08-21T00:00:00.000Z')
    )
  }
  return index
}

describe('execution log key layout', () => {
  it('partitions by UTC date, not host local time', () => {
    // 23:30 UTC-on-the-21st is the 22nd in +02:00 — the partition must not drift.
    assertEquals(executionLogDatePartition(new Date('2026-08-21T23:30:00.000Z')), '2026/08/21')
    assertEquals(executionLogDatePartition(new Date('2026-01-05T00:00:00.000Z')), '2026/01/05')
  })

  it('round-trips a partition string', () => {
    const parsed = parseExecutionLogDatePartition('2026/08/21')
    assertEquals(parsed?.toISOString(), '2026-08-21T00:00:00.000Z')
    assertEquals(parseExecutionLogDatePartition('2026-08-21'), null)
    assertEquals(parseExecutionLogDatePartition('nope'), null)
  })

  it('keys the index flat so a read never guesses the partition', () => {
    assertEquals(executionLogIndexKey('cmd-1'), 'execution-logs/index/cmd-1.json')
  })

  it('zero-pads part keys so lexical order is sequence order', () => {
    assertEquals(
      executionLogPartKey('2026/08/21', 'cmd-1', 7),
      'execution-logs/data/2026/08/21/cmd-1/000000007.part'
    )
    assertEquals(
      executionLogSealedKey('2026/08/21', 'cmd-1'),
      'execution-logs/data/2026/08/21/cmd-1.log.gz'
    )
  })

  it('recovers the command id from either data key shape', () => {
    assertEquals(
      commandIdFromExecutionLogDataKey(
        'execution-logs/data/2026/08/21/cmd-1/000000000.part',
        '2026/08/21'
      ),
      'cmd-1'
    )
    assertEquals(
      commandIdFromExecutionLogDataKey('execution-logs/data/2026/08/21/cmd-1.log.gz', '2026/08/21'),
      'cmd-1'
    )
    assertEquals(
      commandIdFromExecutionLogDataKey('execution-logs/data/2026/08/20/cmd-1.log.gz', '2026/08/21'),
      null
    )
  })
})

describe('parseExecutionLogIndex', () => {
  it('rejects anything that is not a version-1 index', () => {
    assertEquals(parseExecutionLogIndex('not json'), null)
    assertEquals(parseExecutionLogIndex('[]'), null)
    assertEquals(parseExecutionLogIndex('{"version":2}'), null)
    assertEquals(parseExecutionLogIndex('{"version":1,"commandId":"a"}'), null)
  })

  it('round-trips a written index', () => {
    const index = indexWithParts([4, 6])
    const parsed = parseExecutionLogIndex(JSON.stringify(index))
    assertEquals(parsed?.nextSeq, 2)
    assertEquals(parsed?.totalBytes, 10)
    assertEquals(parsed?.parts.length, 2)
  })
})

describe('planExecutionLogAppend', () => {
  it('accepts the next sequence and records its byte span', () => {
    const plan = planExecutionLogAppend(indexWithParts([4]), {
      seq: 1,
      bytes: encoder.encode('abc'),
    })
    assertEquals(plan.kind, 'write')
    if (plan.kind !== 'write') throw new TypeError('expected a write plan')
    assertEquals(plan.part, { seq: 1, offset: 4, length: 3 })
  })

  it('treats an already-consumed sequence as a replay', () => {
    const plan = planExecutionLogAppend(indexWithParts([4, 4]), {
      seq: 0,
      bytes: encoder.encode('abc'),
    })
    assertEquals(plan, { kind: 'replay', nextSeq: 2 })
  })

  it('rejects a gap, a negative sequence, and an oversized chunk', () => {
    const index = indexWithParts([4])
    assertThrows(
      () => planExecutionLogAppend(index, { seq: 3, bytes: encoder.encode('x') }),
      ExecutionLogGapError
    )
    assertThrows(
      () => planExecutionLogAppend(index, { seq: -1, bytes: encoder.encode('x') }),
      ExecutionLogGapError
    )
    assertThrows(
      () =>
        planExecutionLogAppend(index, {
          seq: 1,
          bytes: new Uint8Array(MAX_EXECUTION_LOG_CHUNK_BYTES + 1),
        }),
      ExecutionLogChunkTooLargeError
    )
  })

  it('rejects any append once the transcript is sealed', () => {
    const index = { ...indexWithParts([4]), sealed: true }
    assertThrows(
      () => planExecutionLogAppend(index, { seq: 1, bytes: encoder.encode('x') }),
      ExecutionLogSealedError
    )
  })

  it('drops output past the total cap and emits the marker exactly once', () => {
    const full = { ...indexWithParts([4]), totalBytes: MAX_EXECUTION_LOG_TOTAL_BYTES }
    const first = planExecutionLogAppend(full, { seq: 1, bytes: encoder.encode('x') })
    assertEquals(first.kind, 'truncated')
    if (first.kind !== 'truncated') throw new TypeError('expected a truncated plan')
    assertEquals(first.marker !== null, true)

    const alreadyTruncated = { ...full, truncated: true }
    const second = planExecutionLogAppend(alreadyTruncated, { seq: 1, bytes: encoder.encode('x') })
    if (second.kind !== 'truncated') throw new TypeError('expected a truncated plan')
    assertEquals(second.marker, null)
  })
})

describe('applyExecutionLogTruncation', () => {
  it('stores the marker as a readable part', () => {
    const next = applyExecutionLogTruncation(indexWithParts([4]), 1, 12, new Date())
    assertEquals(next.truncated, true)
    assertEquals(next.nextSeq, 2)
    assertEquals(next.totalBytes, 16)
    assertEquals(next.parts.at(-1), { seq: 1, offset: 4, length: 12 })
  })

  it('advances the sequence without a part when the marker was already written', () => {
    const next = applyExecutionLogTruncation(indexWithParts([4]), 1, null, new Date())
    assertEquals(next.parts.length, 1)
    assertEquals(next.totalBytes, 4)
    assertEquals(next.nextSeq, 2)
  })
})

describe('resolveExecutionLogReadWindow', () => {
  it('returns whole chunks that fit the budget', () => {
    const window = resolveExecutionLogReadWindow(indexWithParts([4, 4, 4]), 0, 8)
    assertEquals(window, { start: 0, end: 8, nextSeq: 2 })
  })

  it('never re-emits a chunk the caller already read', () => {
    const window = resolveExecutionLogReadWindow(indexWithParts([4, 4, 4]), 2, 1024)
    assertEquals(window, { start: 8, end: 12, nextSeq: 3 })
  })

  it('reports nothing pending once the caller is caught up', () => {
    const window = resolveExecutionLogReadWindow(indexWithParts([4, 4]), 2, 1024)
    assertEquals(window, { start: 8, end: 8, nextSeq: 2 })
  })

  it('returns a partial slice rather than stalling on an over-budget chunk', () => {
    // Budget smaller than the next chunk: the reader still makes progress, and
    // `nextSeq` stays on that chunk so its remainder is not skipped.
    const window = resolveExecutionLogReadWindow(indexWithParts([10]), 0, 4)
    assertEquals(window, { start: 0, end: 4, nextSeq: 0 })
  })

  it('treats a zero or negative budget as an existence probe', () => {
    const window = resolveExecutionLogReadWindow(indexWithParts([10]), 0, 0)
    assertEquals(window, { start: 0, end: 0, nextSeq: 0 })
  })
})
