/**
 * Storage-agnostic execution-log (command transcript) contract.
 *
 * A transcript is an append-only sequence of byte chunks produced by the daemon
 * while a command runs, addressed by `(commandId, seq)`. Chunks are written as
 * individual objects/parts while the command is live, then compacted into one
 * gzipped object by {@link ExecutionLogStore.seal} on the command's terminal
 * transition.
 *
 * Deliberately a **keyed-object GET**, not an analytics table: a transcript is
 * only ever read whole (or resumed from an offset) for one command id, so an
 * object store with a per-command index is both cheaper and simpler than a
 * columnar/Iceberg layout that exists to answer cross-row queries nobody asks
 * of execution logs. See `AGENTS.md` in this directory.
 */

/** One appended transcript fragment. `seq` is 0-based and gap-free per command. */
export type ExecutionLogChunk = {
  seq: number
  bytes: Uint8Array
}

/** Result of {@link ExecutionLogStore.appendChunk}. */
export type ExecutionLogAppendResult = {
  /** Sequence number the daemon should send next. */
  nextSeq: number
}

/** Result of {@link ExecutionLogStore.readFrom}. */
export type ExecutionLogReadResult = {
  /** Transcript bytes starting at the requested `fromSeq`, capped by `maxBytes`. */
  bytes: Uint8Array
  /** Sequence to resume from; equals the requested `fromSeq` when nothing was returned. */
  nextSeq: number
  /** Whether the transcript has been compacted and is final. */
  sealed: boolean
  /** Whether the total-byte cap was hit and later output was dropped. */
  truncated: boolean
}

/** Result of {@link ExecutionLogStore.seal}. */
export type ExecutionLogSealResult = {
  /** Uncompressed transcript size in bytes. */
  bytes: number
}

/** Options for a bounded retention sweep tick. */
export type ExecutionLogSweepOptions = {
  /** Transcripts older than this many days are removed. */
  retentionDays: number
  /** Hard cap on transcripts removed in one tick — cleanup must never dominate the sweep. */
  limit: number
  /** Test seam; defaults to now. */
  now?: Date
}

/**
 * Append-only transcript storage for one command.
 *
 * Every method is idempotent under daemon retry: a replayed `seq` is a no-op, a
 * repeated `seal` returns the already-sealed size, and `delete` on a missing
 * transcript resolves.
 */
export interface ExecutionLogStore {
  /**
   * Append one chunk. Idempotent on `(commandId, seq)`:
   * - `seq < nextSeq` (replay) → no-op, returns the current `nextSeq`.
   * - `seq > nextSeq` (gap) → throws {@link ExecutionLogGapError}.
   * - after {@link seal} → throws {@link ExecutionLogSealedError}.
   * - past {@link MAX_EXECUTION_LOG_TOTAL_BYTES} → no-op that flips `truncated`.
   */
  appendChunk(
    commandId: string,
    chunk: ExecutionLogChunk
  ): Promise<ExecutionLogAppendResult>

  /**
   * Read transcript bytes from `fromSeq`, returning at most `maxBytes`.
   * Returns `null` when no transcript exists for `commandId` at all — callers
   * render "not started" for `null` and "no output yet" for an empty read.
   */
  readFrom(
    commandId: string,
    fromSeq: number,
    maxBytes: number
  ): Promise<ExecutionLogReadResult | null>

  /** Whether a retained transcript exists. Cheaper than a zero-byte `readFrom`. */
  exists(commandId: string): Promise<boolean>

  /**
   * Compact the transcript into one final gzipped object and mark it sealed.
   * Returns `null` when no transcript exists. Repeat calls are no-ops that
   * return the sealed size.
   */
  seal(commandId: string): Promise<ExecutionLogSealResult | null>

  /** Remove a transcript and its index. Resolves when nothing exists. */
  delete(commandId: string): Promise<void>

  /**
   * Bounded removal of transcripts past their retention window. Returns the
   * number of transcripts removed (tracing only).
   */
  sweepExpired(opts: ExecutionLogSweepOptions): Promise<number>
}

/** Per-chunk byte cap. Larger fragments must be split by the daemon. */
export const MAX_EXECUTION_LOG_CHUNK_BYTES = 256 * 1024

/**
 * Whole-transcript byte cap. A runaway command must not be able to fill the
 * bucket; output past this point is dropped and the transcript is flagged
 * `truncated` with {@link EXECUTION_LOG_TRUNCATION_MARKER} appended once.
 */
export const MAX_EXECUTION_LOG_TOTAL_BYTES = 8 * 1024 * 1024

/** Appended exactly once when the total-byte cap is reached. */
export const EXECUTION_LOG_TRUNCATION_MARKER =
  '\n[turbopanel] execution log truncated: output exceeded the retained size limit\n'

/** Default read window for one `readFrom` call when the caller does not cap it. */
export const DEFAULT_EXECUTION_LOG_READ_BYTES = 512 * 1024

/** Default retention window for stored transcripts. */
export const EXECUTION_LOG_RETENTION_DAYS = 90

/** Bounded per maintenance tick — parity with `COMMAND_DISPATCH_SWEEP_LIMIT`. */
export const EXECUTION_LOG_SWEEP_LIMIT = 200

/** Thrown when an append skips a sequence number (daemon must resend from `nextSeq`). */
export class ExecutionLogGapError extends Error {
  readonly expectedSeq: number
  readonly receivedSeq: number

  constructor(expectedSeq: number, receivedSeq: number) {
    super(`execution log gap: expected seq ${expectedSeq}, received ${receivedSeq}`)
    this.name = 'ExecutionLogGapError'
    this.expectedSeq = expectedSeq
    this.receivedSeq = receivedSeq
  }
}

/** Thrown when an append arrives after the transcript was sealed. */
export class ExecutionLogSealedError extends Error {
  constructor(commandId: string) {
    super(`execution log for ${commandId} is sealed`)
    this.name = 'ExecutionLogSealedError'
  }
}

/** Thrown when a chunk exceeds {@link MAX_EXECUTION_LOG_CHUNK_BYTES}. */
export class ExecutionLogChunkTooLargeError extends Error {
  constructor(byteLength: number) {
    super(
      `execution log chunk of ${byteLength} bytes exceeds the ${MAX_EXECUTION_LOG_CHUNK_BYTES} byte cap`
    )
    this.name = 'ExecutionLogChunkTooLargeError'
  }
}
