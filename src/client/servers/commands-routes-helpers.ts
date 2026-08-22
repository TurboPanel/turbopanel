/**
 * Pure helpers for server command routes — body validation and response
 * shaping without a Hono Context or live DB client.
 */

import { assertValidHostname } from '../../lib/commands/hostname.ts'
import {
  parseNtpSetPayload,
  parseTimezoneSetPayload,
} from '../../lib/commands/schemas.ts'
import { isAllowedTimezone } from '../../lib/timezones.ts'
import { computePingLatency } from './commands-ping-latency.ts'
import { DEFAULT_EXECUTION_LOG_READ_BYTES } from '../../lib/execution-logs/types.ts'

export type CommandRouteValidationError = {
  ok: false
  error: string
  status: 400
}

export function parseHostnameCommandBody(
  body: Record<string, unknown>,
):
  | { ok: true; hostname: string }
  | CommandRouteValidationError {
  const hostname = body.hostname
  if (typeof hostname !== 'string' || hostname.length === 0) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }

  try {
    assertValidHostname(hostname)
  } catch {
    return { ok: false, error: 'Invalid hostname', status: 400 }
  }

  return { ok: true, hostname }
}

export function parseTimezoneCommandBody(
  body: Record<string, unknown>,
):
  | { ok: true; payload: ReturnType<typeof parseTimezoneSetPayload> }
  | CommandRouteValidationError {
  let payload
  try {
    payload = parseTimezoneSetPayload(body)
  } catch {
    return { ok: false, error: 'Invalid timezone', status: 400 }
  }
  if (!isAllowedTimezone(payload.timezone)) {
    return { ok: false, error: 'Invalid timezone', status: 400 }
  }
  return { ok: true, payload }
}

export function parseNtpCommandBody(
  body: Record<string, unknown>,
):
  | { ok: true; payload: ReturnType<typeof parseNtpSetPayload> }
  | CommandRouteValidationError {
  let payload
  try {
    payload = parseNtpSetPayload(body)
  } catch {
    return { ok: false, error: 'Invalid ntp payload', status: 400 }
  }
  return { ok: true, payload }
}

export function shapeCommandGetResponse<T extends { type: string }>(
  record: T,
): T | (T & { latency: ReturnType<typeof computePingLatency> }) {
  if (record.type === 'daemon.ping') {
    return { ...record, latency: computePingLatency(record as never) }
  }
  return record
}

export function commandNotFoundOnServer(
  record: { serverId: string } | null | undefined,
  serverId: string,
): boolean {
  return record?.serverId !== serverId
}

/** Maximum command ids accepted by one batched status request. */
export const COMMAND_STATUS_BATCH_LIMIT = 100

/** Lean batched status projection — never exposes dispatch payload or result. */
export type CommandStatusResponse = {
  id: string
  serverId: string
  status: string
  type: string
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  /** Whether an execution log is retained for this command. */
  hasLog: boolean
}

type CommandStatusSource = {
  id: string
  serverId: string
  status: string
  type: string
  queuedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  errorCode: string | null
  errorMessage: string | null
}

/**
 * `hasLog` is resolved store-side, not from Postgres — transcript existence
 * lives in the execution-log store (R2 / filesystem / S3) and there is no
 * column to join. Callers pass the answer in; it defaults to `false` so a
 * runtime with no configured store shapes a valid response.
 */
export function shapeCommandStatusResponse(
  record: CommandStatusSource,
  hasLog = false,
): CommandStatusResponse {
  return {
    id: record.id,
    serverId: record.serverId,
    status: record.status,
    type: record.type,
    queuedAt: record.queuedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    hasLog,
  }
}

/** Shape of `GET /servers/:id/commands/:commandId/log`. */
export type CommandLogResponse = {
  ok: true
  /** Transcript text decoded as UTF-8; empty when there is no output yet. */
  text: string
  /** Sequence to pass as `from` on the next poll. */
  nextSeq: number
  /** Whether the transcript is final (the command reached a terminal status). */
  sealed: boolean
  /** Whether output was dropped after the retained-size cap. */
  truncated: boolean
  /** Whether any transcript exists at all — `false` means "not started". */
  exists: boolean
}

export type CommandLogQuery = { from: number; max: number }

/**
 * Parse `?from=<seq>&max=<bytes>`. Both are advisory: anything unparseable
 * falls back to the defaults rather than 400-ing a poll loop.
 */
export function parseCommandLogQuery(
  from: string | undefined,
  max: string | undefined,
): CommandLogQuery {
  const parsedFrom = Number(from ?? '')
  const parsedMax = Number(max ?? '')
  return {
    from: Number.isInteger(parsedFrom) && parsedFrom > 0 ? parsedFrom : 0,
    max:
      Number.isInteger(parsedMax) && parsedMax > 0
        ? Math.min(parsedMax, DEFAULT_EXECUTION_LOG_READ_BYTES)
        : DEFAULT_EXECUTION_LOG_READ_BYTES,
  }
}

/**
 * Shape a transcript read. `null` (no transcript at all) is the "not started"
 * state — an empty response, never a 404, so a poll loop started before the
 * daemon's first chunk does not have to special-case an error status.
 */
export function shapeCommandLogResponse(
  result: { bytes: Uint8Array; nextSeq: number; sealed: boolean; truncated: boolean } | null,
  fromSeq: number,
): CommandLogResponse {
  if (!result) {
    return { ok: true, text: '', nextSeq: fromSeq, sealed: false, truncated: false, exists: false }
  }
  return {
    ok: true,
    text: new TextDecoder().decode(result.bytes),
    nextSeq: result.nextSeq,
    sealed: result.sealed,
    truncated: result.truncated,
    exists: true,
  }
}

export function parseCommandStatusBody(
  body: Record<string, unknown>,
):
  | { ok: true; ids: string[] }
  | CommandRouteValidationError {
  const ids = body.ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (ids.length > COMMAND_STATUS_BATCH_LIMIT) {
    return { ok: false, error: 'Too many command ids', status: 400 }
  }

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'Invalid request', status: 400 }
    }
    if (seen.has(id)) continue
    seen.add(id)
    deduped.push(id)
  }

  return { ok: true, ids: deduped }
}
