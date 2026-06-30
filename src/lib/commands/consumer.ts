/**
 * **Status projection:** The consumer is the single writer of terminal `command` rows.
 * The WS inbound path (`handleInbound` in `redis/cell.ts` and `do.ts`) only updates the
 * hot `PendingRequestRecord` in the cell. The consumer reads the terminal
 * `PendingRequestRecord` returned by `waitForRequest` and maps it to a
 * `transitionCommand` call. There is no per-server polling or cross-cell fan-out.
 */
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import { generateDeliveryId } from '../../daemon/cell/protocol.ts'
import { resolveFleetPresence } from '../../daemon/cell/server-status.ts'
import {
  getServerLicenseBinding,
  touchServerMetadata,
} from '../../server-registry.ts'
import { compatLogWarn } from '../../log-compat.ts'
import { getCommandRecord, transitionCommand } from '../db/command-records.ts'
import type { CommandEnvelope } from './envelope.ts'
import { nowIso } from './ids.ts'
import { parseHostnameSetResult, parsePingResult } from './schemas.ts'
import { TERMINAL_COMMAND_STATUSES, type CommandType } from './types.ts'

const COMMAND_TIMEOUT_MS: Record<CommandType, number> = {
  'daemon.ping': 30_000,
  'server.hostname.set': 120_000,
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000

function commandTimeoutMs(type: string): number {
  if (type === 'daemon.ping' || type === 'server.hostname.set') {
    return COMMAND_TIMEOUT_MS[type]
  }
  return DEFAULT_COMMAND_TIMEOUT_MS
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name.toLowerCase()
    if (
      name.includes('timeout') ||
      name.includes('network') ||
      name.includes('connection')
    ) {
      return true
    }
  }

  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()

  if (
    message.includes('overloaded') ||
    message.includes('invalid command envelope') ||
    message.includes('data integrity')
  ) {
    return false
  }

  return (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('failed to fetch') ||
    message.includes('connection') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('redis') ||
    message.includes('postgres') ||
    message.includes('database') ||
    message.includes('cell unavailable') ||
    message.includes('durable object')
  )
}

function extractObservedHostname(result: unknown): string | null {
  try {
    return parseHostnameSetResult(result).observedHostname
  } catch {
    return null
  }
}

function enrichPingResult(
  type: string,
  result: unknown,
  pending: { sentAt?: string },
): unknown {
  if (type !== 'daemon.ping') return result
  const parsed = parsePingResult(result)
  if (!pending.sentAt) return parsed
  return { ...parsed, cellDispatchedAt: pending.sentAt }
}

export async function processCommandEnvelope(
  db: Db,
  registry: DaemonCellRegistry,
  envelope: CommandEnvelope,
): Promise<void> {
  const record = await getCommandRecord(db, envelope.commandId)
  if (!record) {
    return
  }

  if (TERMINAL_COMMAND_STATUSES.has(record.status)) {
    return
  }

  if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) {
    await transitionCommand(db, record.id, { status: 'timed_out' })
    return
  }

  if (record.serverId !== envelope.serverId) {
    compatLogWarn(
      'command-consumer',
      `envelope mismatch for command ${envelope.commandId}: record server=${record.serverId}, envelope server=${envelope.serverId}`,
    )
    return
  }

  await transitionCommand(db, record.id, {
    status: 'dispatching',
    dispatchStartedAt: nowIso(),
    attempts: record.attempts + 1,
  })

  const serverBinding = await getServerLicenseBinding(db, envelope.serverId)
  if (!serverBinding) {
    compatLogWarn(
      'command-consumer',
      `server ${envelope.serverId} not found for command ${envelope.commandId}`,
    )
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Server not found',
    })
    return
  }

  const presenceMap = await resolveFleetPresence(db, registry, [envelope.serverId])
  const presence = presenceMap.get(envelope.serverId)
  if (!presence?.connected) {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Daemon not connected',
    })
    return
  }

  const outbound = {
    kind: 'command-dispatch' as const,
    requestId: record.id,
    deliveryId: generateDeliveryId(),
    at: nowIso(),
    commandId: record.id,
    commandType: record.type,
    payload: record.payload,
  }

  const timeoutMs = commandTimeoutMs(record.type)
  const cell = registry.getCell(envelope.serverId)
  await cell.enqueue(outbound)
  await transitionCommand(db, record.id, { status: 'sent' })

  const pending = await cell.waitForRequest(record.id, timeoutMs)
  if (!pending) {
    await transitionCommand(db, record.id, { status: 'timed_out' })
    return
  }

  switch (pending.status) {
    case 'done': {
      await transitionCommand(db, record.id, {
        status: 'succeeded',
        result: enrichPingResult(record.type, pending.result, pending),
        ackedAt: pending.ackAt ?? pending.finishedAt,
        startedAt: pending.ackAt ?? pending.finishedAt,
        finishedAt: pending.finishedAt,
      })

      if (record.type === 'server.hostname.set') {
        const observedHostname = extractObservedHostname(pending.result)
        if (observedHostname) {
          await touchServerMetadata(db, envelope.serverId, {
            hostname: observedHostname,
          })
        }
      }
      break
    }
    case 'failed': {
      await transitionCommand(db, record.id, {
        status: 'failed',
        error: pending.error ?? 'Command failed',
      })
      break
    }
    case 'expired': {
      await transitionCommand(db, record.id, { status: 'timed_out' })
      break
    }
    default: {
      await transitionCommand(db, record.id, {
        status: 'failed',
        error: `Unexpected pending request status: ${pending.status}`,
      })
      break
    }
  }
}
