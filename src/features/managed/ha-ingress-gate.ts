/**
 * Completion gate for an HA recovery's last step: every server that routes to
 * the database (its own ProxySQL ingress) must confirm the new primary before
 * the journal row says `completed`.
 *
 * After the role change, `onPromoteSucceeded` queues one
 * `managed.ingress.reconcile` per server and parks the row at
 * `reconciling-ingress`, listing the commands (`ingressCommandIds`) and the
 * servers that must confirm (`ingressServerIds`). Each command's result lands
 * here (`settleIngressCommandForRecovery`) and the row is judged from the
 * command table, so the decision is idempotent and a result that arrives
 * before the row was parked is picked up by the judgement made right after.
 *
 * Rule (bounded: the stale-command sweep times out any command that never
 * answers, and the stale-recovery sweep ends a row nothing advances):
 * - any listed command still queued, sent or running: wait;
 * - every required server has a succeeded command: exactly one writer is
 *   checked, then `completed`;
 * - otherwise terminal `failed` + `needsOperator`, naming the servers whose
 *   ingress was not repointed (`ingressNotRepointed`).
 *
 * A daemon only reports `succeeded` after reading the ProxySQL runtime table
 * back and finding the new primary there (turbopaneld `managed.ingress.reconcile`).
 */

import { inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, server } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { TERMINAL_COMMAND_STATUSES } from '../commands/types.ts'
import { nextStateAfterIngressReconcile, nextStateAfterVerify } from './ha-recovery-pure.ts'
import { listManagedMembers } from './members.ts'
import { findRecoveryById, updateRecoveryLocked } from './recovery-records.ts'
import { ingressNotRepointedMessage, type RecoveryMetadata } from './recovery.ts'

export type IngressGateCommand = {
  id: string
  serverId: string
  status: string
}

export type IngressGateDecision =
  { kind: 'wait' } | { kind: 'complete' } | { kind: 'degraded'; serverIds: string[] }

/** Pure judgement of the gate; see the file comment for the rule. */
export function decideIngressGate(input: {
  requiredServerIds: readonly string[]
  commands: readonly IngressGateCommand[]
}): IngressGateDecision {
  const live = input.commands.some(
    (entry) => !(TERMINAL_COMMAND_STATUSES as ReadonlySet<string>).has(entry.status)
  )
  if (live) return { kind: 'wait' }
  const confirmed = new Set(
    input.commands.filter((entry) => entry.status === 'succeeded').map((entry) => entry.serverId)
  )
  const missing = input.requiredServerIds.filter((serverId) => !confirmed.has(serverId))
  return missing.length === 0 ? { kind: 'complete' } : { kind: 'degraded', serverIds: missing }
}

async function loadGateCommands(db: Db, ids: readonly string[]): Promise<IngressGateCommand[]> {
  if (ids.length === 0) return []
  const rows = await db
    .select({
      id: command.id,
      serverId: command.serverId,
      status: command.status,
    })
    .from(command)
    .where(inArray(command.id, [...ids]))
  return rows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    status: row.status,
  }))
}

async function loadServerNames(db: Db, serverIds: readonly string[]): Promise<string[]> {
  if (serverIds.length === 0) return []
  const rows = await db
    .select({ id: server.id, name: server.name })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  const names = new Map(rows.map((row) => [row.id, row.name]))
  return serverIds.map((serverId) => names.get(serverId) ?? serverId)
}

function degradedMetadata(
  current: RecoveryMetadata,
  serverIds: readonly string[],
  reason: string
): RecoveryMetadata {
  return {
    ...current,
    needsOperator: true,
    failedReason: reason,
    ingressNotRepointed: [...serverIds],
  }
}

/**
 * Judge a recovery parked at `reconciling-ingress` and settle it when every
 * ingress has answered. Safe to call any number of times, from any consumer.
 */
export async function evaluateIngressGate(db: Db, recoveryId: string): Promise<void> {
  const record = await findRecoveryById(db, recoveryId)
  if (record?.state !== 'reconciling-ingress') return

  const requiredServerIds = record.metadata.ingressServerIds ?? []
  const commands = await loadGateCommands(db, record.metadata.ingressCommandIds ?? [])
  const decision = decideIngressGate({ requiredServerIds, commands })
  if (decision.kind === 'wait') return

  if (decision.kind === 'complete') {
    const members = await listManagedMembers(db, record.managedId)
    const writerCount = members.filter((row) => row.role === 'primary').length
    await updateRecoveryLocked(db, recoveryId, (current) => {
      if (current.state !== 'reconciling-ingress') return null
      const afterIngress = nextStateAfterIngressReconcile(current.metadata)
      const verified = nextStateAfterVerify({
        writerCount,
        metadata: afterIngress.metadata,
      })
      return { state: verified.state, metadata: verified.metadata }
    })
    return
  }

  const names = await loadServerNames(db, decision.serverIds)
  await updateRecoveryLocked(db, recoveryId, (current) =>
    current.state === 'reconciling-ingress'
      ? {
          state: 'failed',
          metadata: degradedMetadata(
            current.metadata,
            decision.serverIds,
            ingressNotRepointedMessage(names)
          ),
        }
      : null
  )
}

/**
 * Park a recovery at `reconciling-ingress` with the commands that were queued,
 * then judge it at once (a fast result, or nothing to wait for).
 */
export async function parkRecoveryAtIngressGate(
  db: Db,
  recoveryId: string,
  fanOut: {
    requiredServerIds: readonly string[]
    commandIds: readonly string[]
  }
): Promise<void> {
  await updateRecoveryLocked(db, recoveryId, (current) => ({
    state: 'reconciling-ingress',
    metadata: {
      ...current.metadata,
      ingressCommandIds: [...fanOut.commandIds],
      ingressServerIds: [...fanOut.requiredServerIds],
    },
  }))
  await evaluateIngressGate(db, recoveryId)
}

/**
 * The control plane could not queue the ingress repoint at all (no command
 * queue or no secrets in this context). Nothing was repointed, so the row is
 * terminal `failed` for the operator, never `completed`.
 */
export async function failRecoveryIngressNotQueued(
  db: Db,
  recoveryId: string,
  serverIds: readonly string[]
): Promise<void> {
  const names = await loadServerNames(db, serverIds)
  await updateRecoveryLocked(db, recoveryId, (current) => ({
    state: 'failed',
    metadata: degradedMetadata(current.metadata, serverIds, ingressNotRepointedMessage(names)),
  }))
}

/**
 * A command's terminal result (success, failure, timeout, daemon offline).
 * Never throws: a failure here must not break the command consumer; the
 * recovery sweep ends a row nothing advances.
 */
export async function settleIngressCommandForRecovery(
  db: Db,
  recoveryId: string | null
): Promise<void> {
  if (!recoveryId) return
  try {
    await evaluateIngressGate(db, recoveryId)
  } catch (error) {
    compatLogWarn(
      'managed-ha',
      `ingress gate judgement failed for recovery ${recoveryId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}
