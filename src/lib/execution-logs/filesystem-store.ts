/**
 * Filesystem execution logs — the default driver for self-hosted (Deno)
 * installs, which have durable local state and no object store to assume.
 *
 * Layout mirrors the object drivers so the conformance suite is meaningful and
 * the retention sweep is the same shape:
 *   `<dir>/data/<yyyy>/<mm>/<dd>/<commandId>.log`     live transcript
 *   `<dir>/data/<yyyy>/<mm>/<dd>/<commandId>.log.gz`  sealed transcript
 *   `<dir>/index/<commandId>.json`                    flat, date-free index
 *
 * Unlike the object drivers a live transcript is one growing file rather than
 * one object per chunk — appends are cheap on a filesystem, and the index's
 * byte offsets already make an arbitrary `readFrom` a plain positional read.
 */

import {
  applyExecutionLogTruncation,
  applyExecutionLogWrite,
  createExecutionLogIndex,
  executionLogDatePartition,
  gunzipBytes,
  gzipBytes,
  parseExecutionLogDatePartition,
  parseExecutionLogIndex,
  planExecutionLogAppend,
  resolveExecutionLogReadWindow,
  shapeExecutionLogRead,
  type ExecutionLogIndex,
} from './index-model.ts'
import type {
  ExecutionLogAppendResult,
  ExecutionLogChunk,
  ExecutionLogReadResult,
  ExecutionLogSealResult,
  ExecutionLogStore,
  ExecutionLogSweepOptions,
} from './types.ts'

/** Owner-only: transcripts can carry command output that quotes secrets. */
const FILE_MODE = 0o600

/** Owner-only directories, matching the state-tree convention. */
const DIR_MODE = 0o700

/** Bound on how many date partitions one retention tick walks. */
const SWEEP_MAX_PARTITIONS_PER_TICK = 64

export class FilesystemExecutionLogStore implements ExecutionLogStore {
  readonly #root: string
  readonly #now: () => Date

  constructor(root: string, opts: { now?: () => Date } = {}) {
    this.#root = root.replace(/(?<!\/)\/+$/, '')
    this.#now = opts.now ?? (() => new Date())
  }

  #indexPath(commandId: string): string {
    return `${this.#root}/index/${commandId}.json`
  }

  #partitionDir(datePartition: string): string {
    return `${this.#root}/data/${datePartition}`
  }

  #logPath(datePartition: string, commandId: string): string {
    return `${this.#partitionDir(datePartition)}/${commandId}.log`
  }

  #sealedPath(datePartition: string, commandId: string): string {
    return `${this.#logPath(datePartition, commandId)}.gz`
  }

  async #readIndex(commandId: string): Promise<ExecutionLogIndex | null> {
    try {
      return parseExecutionLogIndex(await Deno.readTextFile(this.#indexPath(commandId)))
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null
      throw err
    }
  }

  async #writeIndex(index: ExecutionLogIndex): Promise<void> {
    await Deno.mkdir(`${this.#root}/index`, { recursive: true, mode: DIR_MODE })
    await Deno.writeTextFile(this.#indexPath(index.commandId), JSON.stringify(index), {
      mode: FILE_MODE,
    })
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
        await this.#appendBytes(index, plan.marker)
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

    await this.#appendBytes(index, plan.bytes)
    const next = applyExecutionLogWrite(index, plan.part, at)
    await this.#writeIndex(next)
    return { nextSeq: next.nextSeq }
  }

  async #appendBytes(index: ExecutionLogIndex, bytes: Uint8Array): Promise<void> {
    await Deno.mkdir(this.#partitionDir(index.datePartition), {
      recursive: true,
      mode: DIR_MODE,
    })
    const file = await Deno.open(this.#logPath(index.datePartition, index.commandId), {
      create: true,
      write: true,
      mode: FILE_MODE,
    })
    try {
      // The index is authoritative for length, not the file. Cutting back to
      // the recorded size first makes an append idempotent: a crash between the
      // write and the index update leaves trailing bytes that the retry drops,
      // instead of double-appending and desyncing every later offset.
      await file.truncate(index.totalBytes)
      await file.seek(index.totalBytes, Deno.SeekMode.Start)
      let written = 0
      while (written < bytes.byteLength) {
        written += await file.write(bytes.subarray(written))
      }
    } finally {
      file.close()
    }
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
      const compressed = await this.#readFileOrNull(
        this.#sealedPath(index.datePartition, commandId)
      )
      if (!compressed) return shapeExecutionLogRead(index, window, new Uint8Array(0))
      const plain = await gunzipBytes(compressed)
      return shapeExecutionLogRead(index, window, plain.slice(window.start, window.end))
    }

    const slice = await this.#readSlice(
      this.#logPath(index.datePartition, commandId),
      window.start,
      window.end - window.start
    )
    return shapeExecutionLogRead(index, window, slice)
  }

  async #readSlice(path: string, start: number, length: number): Promise<Uint8Array> {
    let file: Deno.FsFile
    try {
      file = await Deno.open(path, { read: true })
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return new Uint8Array(0)
      throw err
    }
    try {
      await file.seek(start, Deno.SeekMode.Start)
      const buffer = new Uint8Array(length)
      let filled = 0
      while (filled < length) {
        const read = await file.read(buffer.subarray(filled))
        if (read === null) break
        filled += read
      }
      return buffer.subarray(0, filled)
    } finally {
      file.close()
    }
  }

  async #readFileOrNull(path: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(path)
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null
      throw err
    }
  }

  async exists(commandId: string): Promise<boolean> {
    return (await this.#readIndex(commandId)) !== null
  }

  async seal(commandId: string): Promise<ExecutionLogSealResult | null> {
    const index = await this.#readIndex(commandId)
    if (!index) return null
    if (index.sealed) return { bytes: index.totalBytes }

    const logPath = this.#logPath(index.datePartition, commandId)
    const transcript = (await this.#readFileOrNull(logPath)) ?? new Uint8Array(0)
    await Deno.writeFile(
      this.#sealedPath(index.datePartition, commandId),
      await gzipBytes(transcript),
      { mode: FILE_MODE }
    )
    await this.#writeIndex({ ...index, sealed: true, updatedAt: this.#now().toISOString() })
    await this.#removeIfPresent(logPath)
    return { bytes: transcript.byteLength }
  }

  async delete(commandId: string): Promise<void> {
    const index = await this.#readIndex(commandId)
    if (!index) return
    await this.#deleteTranscript(index.datePartition, commandId)
  }

  async #deleteTranscript(datePartition: string, commandId: string): Promise<void> {
    await this.#removeIfPresent(this.#logPath(datePartition, commandId))
    await this.#removeIfPresent(this.#sealedPath(datePartition, commandId))
    await this.#removeIfPresent(this.#indexPath(commandId))
  }

  async #removeIfPresent(path: string): Promise<void> {
    try {
      await Deno.remove(path)
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err
    }
  }

  async sweepExpired(opts: ExecutionLogSweepOptions): Promise<number> {
    const now = opts.now ?? this.#now()
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), 1000)
    const cutoffPartition = executionLogDatePartition(
      new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000)
    )
    return await this.#sweepFromOldestPartition(cutoffPartition, limit)
  }

  /**
   * Walk the date tree in ascending order starting at the oldest partition on
   * disk, rather than probing a fixed band of days behind the cutoff. Every
   * expired partition is therefore reached eventually — including ones far
   * older than the current cutoff (long downtime, a shortened retention
   * window) — while a tick stays bounded by `limit` and
   * {@link SWEEP_MAX_PARTITIONS_PER_TICK}.
   */
  async #sweepFromOldestPartition(
    cutoffPartition: string,
    limit: number
  ): Promise<number> {
    const dataRoot = `${this.#root}/data`
    const progress = { removed: 0, partitionsScanned: 0 }

    for (const year of await this.#sortedSubdirs(dataRoot, /^\d{4}$/)) {
      for (const month of await this.#sortedSubdirs(`${dataRoot}/${year}`, /^\d{2}$/)) {
        const exhausted = await this.#sweepMonthPartitions(
          `${dataRoot}/${year}/${month}`,
          `${year}/${month}`,
          cutoffPartition,
          limit,
          progress
        )
        if (exhausted) return progress.removed
        await this.#removeIfEmptyDir(`${dataRoot}/${year}/${month}`)
      }
      await this.#removeIfEmptyDir(`${dataRoot}/${year}`)
    }
    return progress.removed
  }

  /**
   * Sweep one month's day partitions in ascending order, accumulating into
   * `progress`. Resolves true when the whole tick must stop — either the first
   * unexpired partition was reached or the row / partition budget is spent.
   */
  async #sweepMonthPartitions(
    monthDir: string,
    monthPartition: string,
    cutoffPartition: string,
    limit: number,
    progress: { removed: number; partitionsScanned: number }
  ): Promise<boolean> {
    for (const day of await this.#sortedSubdirs(monthDir, /^\d{2}$/)) {
      const partition = `${monthPartition}/${day}`
      // Ascending order: the first unexpired partition ends the sweep.
      if (partition > cutoffPartition) return true
      if (parseExecutionLogDatePartition(partition) === null) continue
      if (
        progress.removed >= limit ||
        progress.partitionsScanned >= SWEEP_MAX_PARTITIONS_PER_TICK
      ) {
        return true
      }
      progress.partitionsScanned++
      progress.removed += await this.#sweepPartition(partition, limit - progress.removed)
    }
    return false
  }

  /** Delete up to `budget` transcripts in one partition, dropping the dir when it empties. */
  async #sweepPartition(partition: string, budget: number): Promise<number> {
    const commandIds = new Set<string>()
    try {
      for await (const entry of Deno.readDir(this.#partitionDir(partition))) {
        if (!entry.isFile) continue
        const commandId = entry.name.replace(/\.log(\.gz)?$/, '')
        if (commandId !== entry.name) commandIds.add(commandId)
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return 0
      throw err
    }

    let removed = 0
    for (const commandId of commandIds) {
      if (removed >= budget) break
      await this.#deleteTranscript(partition, commandId)
      removed++
    }
    // Drop the drained partition so later ticks do not re-walk empty days.
    await this.#removeIfEmptyDir(this.#partitionDir(partition))
    return removed
  }

  /** Directory names under `path` matching `pattern`, ascending. Missing dir → none. */
  async #sortedSubdirs(path: string, pattern: RegExp): Promise<string[]> {
    const names: string[] = []
    try {
      for await (const entry of Deno.readDir(path)) {
        if (!entry.isDirectory) continue
        if (!pattern.test(entry.name)) continue
        names.push(entry.name)
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return []
      throw err
    }
    return names.sort((a, b) => a.localeCompare(b))
  }

  /** Best effort: removing a non-empty (or already-gone) directory is a no-op. */
  async #removeIfEmptyDir(path: string): Promise<void> {
    try {
      await Deno.remove(path)
    } catch {
      // Non-empty or concurrently removed — nothing to clean up.
    }
  }
}
