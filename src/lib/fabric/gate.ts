/**
 * Wait for `server.fabric.reconcile` commands to reach a terminal status
 * before mutating environment desired state.
 */

import type { Db } from '../../db.ts'
import { listCommandRecordsByIds } from '../db/command-records.ts'
import { TERMINAL_COMMAND_STATUSES, type CommandStatus } from '../commands/types.ts'

export const FABRIC_GATE_TIMEOUT_MS = 20_000
export const FABRIC_GATE_POLL_MS = 500

export type FabricGateCommand = {
  serverId: string
  commandId: string
}

export type FabricGateRecord = {
  id: string
  serverId: string
  status: CommandStatus
  error: string | null
}

export type FabricGateOutcome =
  | { kind: 'ready' }
  | { kind: 'failed'; serverId: string; commandId: string; error: string | null }
  | { kind: 'pending'; pending: FabricGateCommand[] }

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Classify watched reconcile rows. `succeeded` is ready; any other terminal
 * status is failed; everything else is pending. Failed wins over pending.
 */
export function classifyFabricGate(
  records: readonly FabricGateRecord[],
): FabricGateOutcome {
  const pending: FabricGateCommand[] = []
  let failed: Extract<FabricGateOutcome, { kind: 'failed' }> | null = null
  for (const row of records) {
    if (row.status === 'succeeded') continue
    if (TERMINAL_COMMAND_STATUSES.has(row.status)) {
      failed ??= {
        kind: 'failed',
        serverId: row.serverId,
        commandId: row.id,
        error: row.error,
      }
      continue
    }
    pending.push({ serverId: row.serverId, commandId: row.id })
  }
  if (failed) return failed
  if (pending.length > 0) return { kind: 'pending', pending }
  return { kind: 'ready' }
}

function padMissingCommands(
  commands: readonly FabricGateCommand[],
  records: readonly FabricGateRecord[],
): FabricGateRecord[] {
  const byId = new Map(records.map((row) => [row.id, row]))
  return commands.map((command) => {
    const row = byId.get(command.commandId)
    if (row) return row
    return {
      id: command.commandId,
      serverId: command.serverId,
      status: 'queued',
      error: null,
    }
  })
}

export async function awaitFabricReconcile(
  db: Db,
  params: {
    commands: readonly FabricGateCommand[]
    timeoutMs?: number
    pollIntervalMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  },
): Promise<FabricGateOutcome> {
  if (params.commands.length === 0) return { kind: 'ready' }

  const timeoutMs = params.timeoutMs ?? FABRIC_GATE_TIMEOUT_MS
  const pollIntervalMs = params.pollIntervalMs ?? FABRIC_GATE_POLL_MS
  const sleep = params.sleep ?? defaultSleep
  const now = params.now ?? Date.now
  const startedAt = now()
  const ids = params.commands.map((row) => row.commandId)

  while (true) {
    const records = await listCommandRecordsByIds(db, ids)
    const outcome = classifyFabricGate(padMissingCommands(params.commands, records))
    if (outcome.kind !== 'pending') return outcome
    if (now() - startedAt >= timeoutMs) return outcome
    await sleep(pollIntervalMs)
  }
}
