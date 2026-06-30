import { isValidHostname } from './hostname.ts'
import type { CommandType } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export type PingCommandPayload = Record<string, never>

export type HostnameSetCommandPayload = {
  hostname: string
}

export function parsePingPayload(value: unknown): PingCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid ping payload')
  }
  return {}
}

export function parseHostnameSetPayload(value: unknown): HostnameSetCommandPayload {
  if (!isRecord(value)) {
    throw new Error('Invalid hostname set payload')
  }
  const hostname = value.hostname
  if (!isString(hostname) || hostname.length === 0 || !isValidHostname(hostname)) {
    throw new Error('Invalid hostname set payload')
  }
  return { hostname }
}

export type PingCommandResult = {
  apiAcceptedAt?: string
  queuedAt?: string
  consumerReceivedAt?: string
  cellEnqueuedAt?: string
  /** Instance-side WS send time from the cell outbox pump (`markSent`). */
  cellDispatchedAt?: string
  daemonReceivedAt?: string
  daemonRespondedAt?: string
  resultRecordedAt?: string
  daemonHostname?: string
  daemonBuild?: {
    commit?: string
    buildId?: string
    builtAt?: string
    channel?: string
  }
}

export type HostnameSetCommandResult = {
  observedHostname: string
  summary?: string
}

export function parsePingResult(value: unknown): PingCommandResult {
  if (!isRecord(value)) {
    return {}
  }
  const result: PingCommandResult = {}
  if (isString(value.apiAcceptedAt)) result.apiAcceptedAt = value.apiAcceptedAt
  if (isString(value.queuedAt)) result.queuedAt = value.queuedAt
  if (isString(value.consumerReceivedAt)) result.consumerReceivedAt = value.consumerReceivedAt
  if (isString(value.cellEnqueuedAt)) result.cellEnqueuedAt = value.cellEnqueuedAt
  if (isString(value.cellDispatchedAt)) {
    result.cellDispatchedAt = value.cellDispatchedAt
  }
  if (isString(value.daemonReceivedAt)) result.daemonReceivedAt = value.daemonReceivedAt
  if (isString(value.daemonRespondedAt)) result.daemonRespondedAt = value.daemonRespondedAt
  if (isString(value.resultRecordedAt)) result.resultRecordedAt = value.resultRecordedAt
  if (isString(value.daemonHostname)) result.daemonHostname = value.daemonHostname
  if (isRecord(value.daemonBuild)) {
    const build: NonNullable<PingCommandResult['daemonBuild']> = {}
    if (isString(value.daemonBuild.commit)) build.commit = value.daemonBuild.commit
    if (isString(value.daemonBuild.buildId)) build.buildId = value.daemonBuild.buildId
    if (isString(value.daemonBuild.builtAt)) build.builtAt = value.daemonBuild.builtAt
    if (isString(value.daemonBuild.channel)) build.channel = value.daemonBuild.channel
    if (Object.keys(build).length > 0) {
      result.daemonBuild = build
    }
  }
  return result
}

export function parseHostnameSetResult(value: unknown): HostnameSetCommandResult {
  if (!isRecord(value)) {
    throw new Error('Invalid hostname set result')
  }
  const observedHostname = value.observedHostname
  if (!isString(observedHostname) || observedHostname.length === 0) {
    throw new Error('Invalid hostname set result')
  }
  const result: HostnameSetCommandResult = { observedHostname }
  if (isString(value.summary)) {
    result.summary = value.summary
  }
  return result
}

export function parseCommandPayload(
  type: CommandType,
  value: unknown,
): PingCommandPayload | HostnameSetCommandPayload {
  switch (type) {
    case 'daemon.ping':
      return parsePingPayload(value)
    case 'server.hostname.set':
      return parseHostnameSetPayload(value)
  }
}

export function parseCommandResult(
  type: CommandType,
  value: unknown,
): PingCommandResult | HostnameSetCommandResult {
  switch (type) {
    case 'daemon.ping':
      return parsePingResult(value)
    case 'server.hostname.set':
      return parseHostnameSetResult(value)
  }
}
