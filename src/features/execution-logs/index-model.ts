/**
 * Per-command transcript index — the one piece of state every driver shares.
 *
 * The index lives at a **flat, date-free key** so a read never has to guess (or
 * scan) the date partition the transcript bytes landed in; it carries the
 * partition forward instead. Bytes are date-partitioned so the retention sweep
 * can list-and-delete by prefix without a database.
 */

import {
  EXECUTION_LOG_TRUNCATION_MARKER,
  ExecutionLogChunkTooLargeError,
  ExecutionLogGapError,
  ExecutionLogSealedError,
  MAX_EXECUTION_LOG_CHUNK_BYTES,
  MAX_EXECUTION_LOG_TOTAL_BYTES,
  type ExecutionLogChunk,
  type ExecutionLogReadResult,
} from './types.ts'

/** Byte span one appended chunk occupies in the concatenated transcript. */
export type ExecutionLogPart = {
  seq: number
  /** Offset of this chunk's first byte in the concatenated transcript. */
  offset: number
  length: number
}

/** Serialized per-command index. Stored as JSON at {@link executionLogIndexKey}. */
export type ExecutionLogIndex = {
  version: 1
  commandId: string
  /** `yyyy/mm/dd` partition the transcript bytes are stored under. */
  datePartition: string
  /** Sequence number the next append must use. */
  nextSeq: number
  /** Uncompressed transcript size, including any truncation marker. */
  totalBytes: number
  sealed: boolean
  truncated: boolean
  createdAt: string
  updatedAt: string
  parts: ExecutionLogPart[]
}

/** Root prefix for every execution-log object/file. */
export const EXECUTION_LOG_PREFIX = 'execution-logs'

/** Prefix under which date-partitioned transcript bytes live. */
export const EXECUTION_LOG_DATA_PREFIX = `${EXECUTION_LOG_PREFIX}/data`

/** Prefix under which flat per-command index objects live. */
export const EXECUTION_LOG_INDEX_PREFIX = `${EXECUTION_LOG_PREFIX}/index`

/** `yyyy/mm/dd` partition for a timestamp (UTC — partitions must not drift by host tz). */
export function executionLogDatePartition(at: Date): string {
  const year = String(at.getUTCFullYear()).padStart(4, '0')
  const month = String(at.getUTCMonth() + 1).padStart(2, '0')
  const day = String(at.getUTCDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

/** Parse a `yyyy/mm/dd` partition back to its UTC midnight, or `null` when malformed. */
export function parseExecutionLogDatePartition(partition: string): Date | null {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(partition)
  if (!match) return null
  const at = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  )
  return Number.isNaN(at.getTime()) ? null : at
}

/** Flat index key for a command — resolvable without knowing the date partition. */
export function executionLogIndexKey(commandId: string): string {
  return `${EXECUTION_LOG_INDEX_PREFIX}/${commandId}.json`
}

/** Directory prefix holding a live (unsealed) transcript's parts. */
export function executionLogPartsPrefix(
  datePartition: string,
  commandId: string
): string {
  return `${EXECUTION_LOG_DATA_PREFIX}/${datePartition}/${commandId}/`
}

/** Key of one unsealed part. Zero-padded so lexical list order matches seq order. */
export function executionLogPartKey(
  datePartition: string,
  commandId: string,
  seq: number
): string {
  return `${executionLogPartsPrefix(datePartition, commandId)}${String(seq).padStart(9, '0')}.part`
}

/** Key of the compacted, gzipped transcript written by `seal()`. */
export function executionLogSealedKey(
  datePartition: string,
  commandId: string
): string {
  return `${EXECUTION_LOG_DATA_PREFIX}/${datePartition}/${commandId}.log.gz`
}

/** Prefix covering every transcript stored in one date partition. */
export function executionLogPartitionPrefix(datePartition: string): string {
  return `${EXECUTION_LOG_DATA_PREFIX}/${datePartition}/`
}

/**
 * Recover the `yyyy/mm/dd` partition from any data key. Data keys sort
 * lexically in partition order, so the retention sweep can page the whole data
 * prefix from the oldest key forward instead of guessing which days to probe.
 */
export function datePartitionFromExecutionLogDataKey(key: string): string | null {
  const prefix = `${EXECUTION_LOG_DATA_PREFIX}/`
  if (!key.startsWith(prefix)) return null
  const match = /^(\d{4}\/\d{2}\/\d{2})\//.exec(key.slice(prefix.length))
  return match ? match[1] : null
}

/**
 * Recover the command id from any data key in a partition, so the retention
 * sweep can delete the matching flat index without a second listing.
 */
export function commandIdFromExecutionLogDataKey(
  key: string,
  datePartition: string
): string | null {
  const prefix = executionLogPartitionPrefix(datePartition)
  if (!key.startsWith(prefix)) return null
  const rest = key.slice(prefix.length)
  if (!rest) return null
  const slash = rest.indexOf('/')
  if (slash > 0) return rest.slice(0, slash)
  return rest.endsWith('.log.gz') ? rest.slice(0, -'.log.gz'.length) : null
}

/** Fresh index for a command's first chunk. */
export function createExecutionLogIndex(
  commandId: string,
  at: Date
): ExecutionLogIndex {
  const iso = at.toISOString()
  return {
    version: 1,
    commandId,
    datePartition: executionLogDatePartition(at),
    nextSeq: 0,
    totalBytes: 0,
    sealed: false,
    truncated: false,
    createdAt: iso,
    updatedAt: iso,
    parts: [],
  }
}

/** Parse a stored index, returning `null` for anything unrecognized. */
export function parseExecutionLogIndex(text: string): ExecutionLogIndex | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Partial<ExecutionLogIndex>
  if (candidate.version !== 1) return null
  if (typeof candidate.commandId !== 'string') return null
  if (typeof candidate.datePartition !== 'string') return null
  if (!Number.isInteger(candidate.nextSeq)) return null
  if (!Array.isArray(candidate.parts)) return null
  return {
    version: 1,
    commandId: candidate.commandId,
    datePartition: candidate.datePartition,
    nextSeq: candidate.nextSeq as number,
    totalBytes: Number.isInteger(candidate.totalBytes) ? (candidate.totalBytes as number) : 0,
    sealed: candidate.sealed === true,
    truncated: candidate.truncated === true,
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
    parts: (candidate.parts as ExecutionLogPart[]).filter(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        Number.isInteger(part.seq) &&
        Number.isInteger(part.offset) &&
        Number.isInteger(part.length)
    ),
  }
}

/** Outcome of validating an append against the current index. */
export type ExecutionLogAppendPlan =
  | { kind: 'replay'; nextSeq: number }
  | { kind: 'truncated'; seq: number; marker: Uint8Array | null }
  | { kind: 'write'; part: ExecutionLogPart; bytes: Uint8Array }

/**
 * Decide what an append should do, without touching storage. Shared by every
 * driver so gap/replay/seal/truncation semantics cannot drift between them.
 */
export function planExecutionLogAppend(
  index: ExecutionLogIndex,
  chunk: ExecutionLogChunk
): ExecutionLogAppendPlan {
  if (!Number.isInteger(chunk.seq) || chunk.seq < 0) {
    throw new ExecutionLogGapError(index.nextSeq, chunk.seq)
  }
  if (chunk.bytes.byteLength > MAX_EXECUTION_LOG_CHUNK_BYTES) {
    throw new ExecutionLogChunkTooLargeError(chunk.bytes.byteLength)
  }
  if (index.sealed) {
    throw new ExecutionLogSealedError(index.commandId)
  }
  if (chunk.seq < index.nextSeq) {
    return { kind: 'replay', nextSeq: index.nextSeq }
  }
  if (chunk.seq > index.nextSeq) {
    throw new ExecutionLogGapError(index.nextSeq, chunk.seq)
  }
  if (index.truncated || index.totalBytes >= MAX_EXECUTION_LOG_TOTAL_BYTES) {
    // Cap already reached: swallow the chunk but still advance `nextSeq` so the
    // daemon keeps streaming (and finishes) instead of retrying forever.
    return {
      kind: 'truncated',
      seq: chunk.seq,
      // The marker is written once, as a normal part, so readers see *why* the
      // transcript stops rather than silently getting a short tail.
      marker: index.truncated ? null : new TextEncoder().encode(EXECUTION_LOG_TRUNCATION_MARKER),
    }
  }
  return {
    kind: 'write',
    part: { seq: chunk.seq, offset: index.totalBytes, length: chunk.bytes.byteLength },
    bytes: chunk.bytes,
  }
}

/** Apply a `write` plan to the index (pure — the caller persists it). */
export function applyExecutionLogWrite(
  index: ExecutionLogIndex,
  part: ExecutionLogPart,
  at: Date
): ExecutionLogIndex {
  return {
    ...index,
    nextSeq: part.seq + 1,
    totalBytes: part.offset + part.length,
    updatedAt: at.toISOString(),
    parts: [...index.parts, part],
  }
}

/**
 * Apply a `truncated` plan to the index (pure — the caller persists it).
 * When a marker is written it becomes a real part at `seq`, so the truncation
 * notice is part of the readable transcript.
 */
export function applyExecutionLogTruncation(
  index: ExecutionLogIndex,
  seq: number,
  markerLength: number | null,
  at: Date
): ExecutionLogIndex {
  const base = {
    ...index,
    nextSeq: seq + 1,
    truncated: true,
    updatedAt: at.toISOString(),
  }
  if (markerLength === null) return base
  const part: ExecutionLogPart = { seq, offset: index.totalBytes, length: markerLength }
  return {
    ...base,
    totalBytes: part.offset + part.length,
    parts: [...index.parts, part],
  }
}

/**
 * Byte offset the read window starts at, and the sequence the caller resumes
 * from once `maxBytes` of transcript have been returned.
 */
export type ExecutionLogReadWindow = {
  /** Offset of the first byte to return. */
  start: number
  /** Exclusive offset of the last byte to return. */
  end: number
  nextSeq: number
}

/**
 * Resolve the byte window for a `readFrom(fromSeq, maxBytes)` call.
 *
 * `nextSeq` advances only past chunks returned in full, so a resumed read never
 * re-emits a partial chunk's tail nor skips its remainder.
 */
export function resolveExecutionLogReadWindow(
  index: ExecutionLogIndex,
  fromSeq: number,
  maxBytes: number
): ExecutionLogReadWindow {
  const requested = Number.isInteger(fromSeq) && fromSeq > 0 ? fromSeq : 0
  const budget = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0
  const pending = index.parts.filter((part) => part.seq >= requested)
  if (pending.length === 0) {
    return { start: index.totalBytes, end: index.totalBytes, nextSeq: Math.max(requested, index.nextSeq) }
  }

  const start = pending[0].offset
  let end = start
  let nextSeq = pending[0].seq
  for (const part of pending) {
    if (part.offset + part.length - start > budget) break
    end = part.offset + part.length
    nextSeq = part.seq + 1
  }

  if (end === start) {
    // The next chunk alone exceeds the budget — return a partial slice rather
    // than stalling the reader, and leave `nextSeq` on that chunk.
    return { start, end: Math.min(start + budget, index.totalBytes), nextSeq }
  }
  return { start, end, nextSeq }
}

/** Shape a read result from a resolved window and the sliced transcript bytes. */
export function shapeExecutionLogRead(
  index: ExecutionLogIndex,
  window: ExecutionLogReadWindow,
  bytes: Uint8Array
): ExecutionLogReadResult {
  return {
    bytes,
    nextSeq: window.nextSeq,
    sealed: index.sealed,
    truncated: index.truncated,
  }
}

/** gzip a buffer using the runtime's `CompressionStream` (Workers + Deno both have it). */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** gunzip a buffer using the runtime's `DecompressionStream`. */
export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
