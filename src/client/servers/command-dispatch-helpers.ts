/**
 * Pure helpers extracted from command-dispatch for host-free coverage.
 */

import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandType } from '../../lib/commands/types.ts'

export function buildUserCommandExpiresAt(
  ttlMs: number,
  nowMs = Date.now(),
): string {
  return new Date(nowMs + ttlMs).toISOString()
}

export function buildCommandEnqueueEnvelope(params: Readonly<{
  commandId: string
  serverId: string
  type: CommandType
  queuedAt: string
  attempt?: number
}>): CommandEnvelope {
  return {
    commandId: params.commandId,
    serverId: params.serverId,
    type: params.type,
    attempt: params.attempt ?? 1,
    queuedAt: params.queuedAt,
  }
}

export function queuedCommandResponseBody(commandId: string): {
  ok: true
  commandId: string
  status: 'queued'
} {
  return { ok: true, commandId, status: 'queued' }
}
