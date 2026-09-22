/**
 * Keyed-object execution-log driver, shared by R2 (Workers) and S3 (Deno).
 *
 * Both backends are the same store with a different transport, so the seq /
 * seal / truncation / retention semantics live here exactly once and each
 * backend supplies only `get` / `put` / `delete` / `list`.
 */

import {
  applyExecutionLogTruncation,
  applyExecutionLogWrite,
  commandIdFromExecutionLogDataKey,
  createExecutionLogIndex,
  datePartitionFromExecutionLogDataKey,
  EXECUTION_LOG_DATA_PREFIX,
  executionLogDatePartition,
  executionLogIndexKey,
  executionLogPartKey,
  executionLogPartsPrefix,
  executionLogSealedKey,
  gunzipBytes,
  gzipBytes,
  parseExecutionLogDatePartition,
  parseExecutionLogIndex,
  planExecutionLogAppend,
  resolveExecutionLogReadWindow,
  shapeExecutionLogRead,
  type ExecutionLogIndex,
  type ExecutionLogPart,
} from './index-model.ts'
import type {
  ExecutionLogAppendResult,
  ExecutionLogChunk,
  ExecutionLogReadResult,
  ExecutionLogSealResult,
  ExecutionLogStore,
  ExecutionLogSweepOptions,
} from './types.ts'

/** Minimal object-store surface an execution-log backend must provide. */
export interface ExecutionLogObjectBackend {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  delete(keys: readonly string[]): Promise<void>
  /** Keys under `prefix`, lexically ascending. `limit` bounds one page. */
  list(prefix: string, limit: number): Promise<string[]>
}

/** Key-page size multiplier per sweep tick — one page bounds a tick's list volume. */
const SWEEP_KEY_PAGE_FACTOR = 4

const JSON_CONTENT_TYPE = 'application/json'
const PART_CONTENT_TYPE = 'application/octet-stream'
const SEALED_CONTENT_TYPE = 'application/gzip'

export class ObjectExecutionLogStore implements ExecutionLogStore {
  readonly #backend: ExecutionLogObjectBackend
  readonly #now: () => Date

  constructor(backend: ExecutionLogObjectBackend, opts: { now?: () => Date } = {}) {
    this.#backend = backend
    this.#now = opts.now ?? (() => new Date())
  }

  async #readIndex(commandId: string): Promise<ExecutionLogIndex | null> {
    const raw = await this.#backend.get(executionLogIndexKey(commandId))
    if (!raw) return null
    return parseExecutionLogIndex(new TextDecoder().decode(raw))
  }

  async #writeIndex(index: ExecutionLogIndex): Promise<void> {
    await this.#backend.put(
      executionLogIndexKey(index.commandId),
      new TextEncoder().encode(JSON.stringify(index)),
      JSON_CONTENT_TYPE
    )
  }

  async appendChunk(
    commandId: string,
    chunk: ExecutionLogChunk
  ): Promise<ExecutionLogAppendResult> {
    const at = this.#now()
    const index = (await this.#readIndex(commandId)) ?? createExecutionLogIndex(commandId, at)
    const plan = planExecutionLogAppend(index, chunk)

    if (plan.kind === 'replay') {
      return { nextSeq: plan.nextSeq }
    }

    if (plan.kind === 'truncated') {
      if (plan.marker) {
        await this.#backend.put(
          executionLogPartKey(index.datePartition, commandId, plan.seq),
          plan.marker,
          PART_CONTENT_TYPE
        )
      }
      const next = applyExecutionLogTruncation(
        index,
        plan.seq,
        plan.marker?.byteLength ?? null,
        at
      )
      await this.#writeIndex(next)
      return { nextSeq: next.nextSeq }
    }

    // Part first, index second: a crash between the two replays harmlessly
    // (the part is overwritten by the identical retry), whereas the reverse
    // order would advertise a part that does not exist.
    await this.#backend.put(
      executionLogPartKey(index.datePartition, commandId, plan.part.seq),
      plan.bytes,
      PART_CONTENT_TYPE
    )
    const next = applyExecutionLogWrite(index, plan.part, at)
    await this.#writeIndex(next)
    return { nextSeq: next.nextSeq }
  }

  async readFrom(
    commandId: string,
    fromSeq: number,
    maxBytes: number
  ): Promise<ExecutionLogReadResult | null> {
    const index = await this.#readIndex(commandId)
    if (!index) return null

    const window = resolveExecutionLogReadWindow(index, fromSeq, maxBytes)
    if (window.end <= window.start) {
      return shapeExecutionLogRead(index, window, new Uint8Array(0))
    }

    if (index.sealed) {
      const sealed = await this.#backend.get(
        executionLogSealedKey(index.datePartition, commandId)
      )
      if (!sealed) return shapeExecutionLogRead(index, window, new Uint8Array(0))
      const plain = await gunzipBytes(sealed)
      return shapeExecutionLogRead(index, window, plain.slice(window.start, window.end))
    }

    const covering = index.parts.filter(
      (part) => part.offset < window.end && part.offset + part.length > window.start
    )
    if (covering.length === 0) {
      return shapeExecutionLogRead(index, window, new Uint8Array(0))
    }
    // Place each part at its *recorded* offset rather than concatenating what
    // came back: a part object that has gone missing must leave a hole, not
    // silently shift every later byte in the window.
    const assembled = await this.#assemblePartsInto(
      index,
      commandId,
      covering,
      window.start,
      window.end
    )
    return shapeExecutionLogRead(index, window, assembled)
  }

  /**
   * Read `parts` and lay them out by recorded offset into the byte range
   * `[start, end)`. Missing parts leave zero bytes rather than shifting the
   * transcript.
   */
  async #assemblePartsInto(
    index: ExecutionLogIndex,
    commandId: string,
    parts: readonly ExecutionLogPart[],
    start: number,
    end: number
  ): Promise<Uint8Array> {
    const out = new Uint8Array(Math.max(end - start, 0))
    await Promise.all(
      parts.map(async (part) => {
        const body = await this.#backend.get(
          executionLogPartKey(index.datePartition, commandId, part.seq)
        )
        if (!body) return
        const copyStart = Math.max(start, part.offset)
        const copyEnd = Math.min(end, part.offset + part.length)
        if (copyEnd <= copyStart) return
        out.set(
          body.subarray(copyStart - part.offset, copyEnd - part.offset),
          copyStart - start
        )
      })
    )
    return out
  }

  async exists(commandId: string): Promise<boolean> {
    return (await this.#readIndex(commandId)) !== null
  }

  async seal(commandId: string): Promise<ExecutionLogSealResult | null> {
    const index = await this.#readIndex(commandId)
    if (!index) return null
    if (index.sealed) return { bytes: index.totalBytes }

    const transcript = await this.#assemblePartsInto(
      index,
      commandId,
      index.parts,
      0,
      index.totalBytes
    )
    await this.#backend.put(
      executionLogSealedKey(index.datePartition, commandId),
      await gzipBytes(transcript),
      SEALED_CONTENT_TYPE
    )
    // Sealed object and index first — only then drop the parts, so a failure
    // mid-seal never leaves a transcript with neither representation.
    await this.#writeIndex({ ...index, sealed: true, updatedAt: this.#now().toISOString() })
    await this.#backend.delete(
      index.parts.map((part) =>
        executionLogPartKey(index.datePartition, commandId, part.seq)
      )
    )
    return { bytes: transcript.byteLength }
  }

  async delete(commandId: string): Promise<void> {
    const index = await this.#readIndex(commandId)
    if (!index) return
    await this.#deleteTranscript(index.datePartition, commandId, index)
  }

  async #deleteTranscript(
    datePartition: string,
    commandId: string,
    index: ExecutionLogIndex | null
  ): Promise<void> {
    const partKeys = index
      ? index.parts.map((part) => executionLogPartKey(datePartition, commandId, part.seq))
      : await this.#backend.list(executionLogPartsPrefix(datePartition, commandId), 1000)
    await this.#backend.delete([
      ...partKeys,
      executionLogSealedKey(datePartition, commandId),
      executionLogIndexKey(commandId),
    ])
  }

  async sweepExpired(opts: ExecutionLogSweepOptions): Promise<number> {
    const now = opts.now ?? this.#now()
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), 1000)
    const cutoffPartition = executionLogDatePartition(
      new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000)
    )

    // Page the whole data prefix from its lexically first key rather than
    // probing a fixed band of days behind the cutoff. Keys sort in partition
    // order, so a page always starts at the oldest partition still stored and
    // every tick makes forward progress — a partition far older than the
    // cutoff (long downtime, a shortened retention window) is reached and
    // deleted instead of being skipped past forever.
    const keys = await this.#backend.list(
      `${EXECUTION_LOG_DATA_PREFIX}/`,
      limit * SWEEP_KEY_PAGE_FACTOR
    )

    const expired = new Map<string, Set<string>>()
    for (const key of keys) {
      const partition = datePartitionFromExecutionLogDataKey(key)
      if (!partition || parseExecutionLogDatePartition(partition) === null) continue
      // Ascending order: the first unexpired partition ends the page.
      if (partition > cutoffPartition) break
      const commandId = commandIdFromExecutionLogDataKey(key, partition)
      if (!commandId) continue
      const ids = expired.get(partition) ?? new Set<string>()
      ids.add(commandId)
      expired.set(partition, ids)
    }

    let removed = 0
    for (const [partition, commandIds] of expired) {
      for (const commandId of commandIds) {
        if (removed >= limit) return removed
        await this.#deleteTranscript(partition, commandId, null)
        removed++
      }
    }
    return removed
  }
}
