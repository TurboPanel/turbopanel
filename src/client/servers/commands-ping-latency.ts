import type { CommandRecord } from '../../lib/db/command-records.ts'
import { parsePingResult } from '../../lib/commands/schemas.ts'

export type PingLatencyBreakdown = {
  apiToConsumerMs: number | null
  consumerToCellMs: number | null
  cellToDaemonMs: number | null
  daemonProcessingMs: number | null
  daemonToRecordedMs: number | null
  totalRoundTripMs: number | null
}

function diffMs(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null
  return Date.parse(end) - Date.parse(start)
}

/** Clamp negative deltas (clock skew) to zero for display-safe hop timings. */
function nonNegativeDiffMs(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  const ms = diffMs(start, end)
  if (ms === null) return null
  return Math.max(0, ms)
}

export function computePingLatency(record: CommandRecord): PingLatencyBreakdown {
  const pingResult = parsePingResult(record.result)
  const cellDispatchedAt = pingResult.cellDispatchedAt ?? record.sentAt
  const cellAckAt = record.ackedAt ?? record.finishedAt
  return {
    apiToConsumerMs: diffMs(record.queuedAt, record.dispatchStartedAt),
    consumerToCellMs: diffMs(record.dispatchStartedAt, cellDispatchedAt),
    cellToDaemonMs: nonNegativeDiffMs(cellDispatchedAt, cellAckAt),
    daemonProcessingMs: nonNegativeDiffMs(
      pingResult.daemonReceivedAt,
      pingResult.daemonRespondedAt,
    ),
    daemonToRecordedMs: record.ackedAt
      ? nonNegativeDiffMs(record.ackedAt, record.finishedAt)
      : nonNegativeDiffMs(cellDispatchedAt, record.finishedAt),
    totalRoundTripMs: diffMs(record.queuedAt, record.finishedAt),
  }
}
