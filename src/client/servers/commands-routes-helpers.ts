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
