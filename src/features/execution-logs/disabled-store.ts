/**
 * Default store when no execution-log backend is configured for the runtime.
 *
 * Every method is a safe no-op so callers never branch on availability: an
 * append reports the seq it was handed as already consumed (the daemon keeps
 * streaming and finishes normally), and a read reports "no transcript".
 */

import type {
  ExecutionLogAppendResult,
  ExecutionLogChunk,
  ExecutionLogReadResult,
  ExecutionLogSealResult,
  ExecutionLogStore,
  ExecutionLogSweepOptions,
} from './types.ts'

export class DisabledExecutionLogStore implements ExecutionLogStore {
  appendChunk(
    _commandId: string,
    chunk: ExecutionLogChunk
  ): Promise<ExecutionLogAppendResult> {
    return Promise.resolve({ nextSeq: chunk.seq + 1 })
  }

  readFrom(
    _commandId: string,
    _fromSeq: number,
    _maxBytes: number
  ): Promise<ExecutionLogReadResult | null> {
    return Promise.resolve(null)
  }

  exists(_commandId: string): Promise<boolean> {
    return Promise.resolve(false)
  }

  seal(_commandId: string): Promise<ExecutionLogSealResult | null> {
    return Promise.resolve(null)
  }

  delete(_commandId: string): Promise<void> {
    return Promise.resolve()
  }

  sweepExpired(_opts: ExecutionLogSweepOptions): Promise<number> {
    return Promise.resolve(0)
  }
}
