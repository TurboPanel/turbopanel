import { isCommandType } from './types.ts'
import type { CommandType } from './types.ts'

export type CommandEnvelope = {
  commandId: string
  serverId: string
  type: CommandType
  attempt: number
  queuedAt: string
  correlationId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function encodeCommandEnvelope(envelope: CommandEnvelope): string {
  return JSON.stringify(envelope)
}

export function parseCommandEnvelope(raw: unknown): CommandEnvelope {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Invalid command envelope')
    }
  }

  if (!isRecord(parsed)) {
    throw new Error('Invalid command envelope')
  }

  const commandId = parsed.commandId
  const serverId = parsed.serverId
  const type = parsed.type
  const attempt = parsed.attempt
  const queuedAt = parsed.queuedAt

  if (
    !isString(commandId) ||
    commandId.length === 0 ||
    !isString(serverId) ||
    serverId.length === 0 ||
    !isCommandType(type) ||
    !isPositiveInteger(attempt) ||
    !isString(queuedAt) ||
    queuedAt.length === 0
  ) {
    throw new Error('Invalid command envelope')
  }

  const envelope: CommandEnvelope = {
    commandId,
    serverId,
    type,
    attempt,
    queuedAt,
  }

  const correlationId = parsed.correlationId
  if (isString(correlationId) && correlationId.length > 0) {
    envelope.correlationId = correlationId
  }

  return envelope
}
