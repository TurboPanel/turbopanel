import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  EXECUTION_LOG_TRUNCATION_MARKER,
  ExecutionLogChunkTooLargeError,
  ExecutionLogGapError,
  ExecutionLogSealedError,
  MAX_EXECUTION_LOG_CHUNK_BYTES,
  MAX_EXECUTION_LOG_TOTAL_BYTES,
} from './types.ts'

describe('execution log error types', () => {
  it('carries gap sequence numbers', () => {
    const error = new ExecutionLogGapError(3, 5)
    assertEquals(error.name, 'ExecutionLogGapError')
    assertEquals(error.expectedSeq, 3)
    assertEquals(error.receivedSeq, 5)
    assertEquals(error.message, 'execution log gap: expected seq 3, received 5')
  })

  it('names sealed transcripts', () => {
    const error = new ExecutionLogSealedError('cmd-1')
    assertEquals(error.name, 'ExecutionLogSealedError')
    assertEquals(error.message, 'execution log for cmd-1 is sealed')
  })

  it('reports oversized chunks against the cap', () => {
    const error = new ExecutionLogChunkTooLargeError(MAX_EXECUTION_LOG_CHUNK_BYTES + 1)
    assertEquals(error.name, 'ExecutionLogChunkTooLargeError')
    assertEquals(
      error.message,
      `execution log chunk of ${MAX_EXECUTION_LOG_CHUNK_BYTES + 1} bytes exceeds the ${MAX_EXECUTION_LOG_CHUNK_BYTES} byte cap`,
    )
  })
})

describe('execution log constants', () => {
  it('exposes stable caps and a human truncation marker', () => {
    assertEquals(MAX_EXECUTION_LOG_CHUNK_BYTES, 256 * 1024)
    assertEquals(MAX_EXECUTION_LOG_TOTAL_BYTES, 8 * 1024 * 1024)
    assertEquals(
      EXECUTION_LOG_TRUNCATION_MARKER.includes('execution log truncated'),
      true,
    )
  })
})
