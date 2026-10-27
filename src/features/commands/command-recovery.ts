/**
 * What the control plane does with a daemon's recovery traffic
 * (`command-recovery-v1`), shared by both transports (`daemon/deno-ws.ts` and
 * `daemon/cell/do.ts`):
 *
 * - {@link noteReportedCommands}: a `commands.running` list on `hello` or
 *   `heartbeat` is a sign of life for those commands.
 * - {@link settleReportedOutcome}: a final `command-outcome` is confirmed to
 *   the daemon (`command-outcome-ack`) only once it is stored. A deploy that
 *   was already given up on (`timed_out`) and whose server now reports that it
 *   succeeded is corrected to `succeeded`, never dropped.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { PendingRequestRecord } from '../../contracts/cell.ts'
import type {
  CommandOutcomeAckMessage,
  CommandRecoveryReport,
  DaemonInboundEnvelope,
} from '../../contracts/cell-protocol.ts'
import type { Db } from '../../db/connection.ts'
import { command } from '../../db/schema.ts'
import { describeErrorCauses } from '../../lib/describe-error.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { markDeploymentApplied } from '../deploy/deployment-records.ts'
import { readDeployContext } from '../deploy/rollout.ts'
import { noteCommandAlive, parseStoredCommandProgress } from './command-progress.ts'
import {
  type CommandRecord,
  deleteCommandDispatch,
  getCommandDispatchPayload,
  getCommandRecord,
} from './command-records.ts'
import { applySucceededSideEffects, type DispatchableCommandRecord } from './consumer.ts'
import { serverHasCommandRecovery } from './deploy-wait-settings.ts'
import { nowIso } from './ids.ts'
import { resultSummaryForPersist } from './result-summary.ts'
import { TERMINAL_COMMAND_STATUSES } from './types.ts'

type CommandOutcomeEnvelope = Extract<DaemonInboundEnvelope, { kind: 'command-outcome' }>

/** The note kept on a command that was corrected after the control plane gave up on it. */
export const LATE_OUTCOME_NOTE =
  'The control plane lost contact with the server during this deploy and marked it timed out. The server later reported that the deploy succeeded, so the result was corrected.'

export function commandOutcomeAckMessage(id: string, at: string): CommandOutcomeAckMessage {
  return { type: 'command-outcome-ack', id, at }
}

/** The commands a daemon says it is running count as heard from now. Best effort. */
export async function noteReportedCommands(
  db: Db,
  serverId: string,
  report: CommandRecoveryReport | undefined
): Promise<void> {
  if (report === undefined) return
  await Promise.all(
    report.running.map((commandId) => noteCommandAlive(db, { serverId, commandId }))
  )
}

/**
 * The step plan of a command that was given up on, put right for a success: the
 * running step marked `failed` and the rest marked `skipped` when it timed out
 * all become `done`, as they do when a result arrives in time.
 */
function succeededProgress(progress: unknown): unknown {
  const stored = parseStoredCommandProgress(progress)
  if (stored === null) return progress
  const steps = stored.steps.map((step) =>
    step.state === 'failed' || step.state === 'skipped' ? { ...step, state: 'done' as const } : step
  )
  return { ...stored, steps }
}

/** A deploy gave up as `timed_out` that the server now says succeeded. */
async function correctTimedOutDeploy(
  db: Db,
  row: CommandRecord,
  envelope: CommandOutcomeEnvelope
): Promise<void> {
  const payload = await getCommandDispatchPayload(db, row.id)
  const finishedAt = envelope.daemonRespondedAt ?? envelope.at
  const receivedAt = envelope.daemonReceivedAt ?? finishedAt
  const flipped = await db
    .update(command)
    .set({
      status: 'succeeded',
      errorMessage: null,
      errorCode: null,
      resultSummary: resultSummaryForPersist(row.type, envelope.result),
      finishedAt,
      updatedAt: nowIso(),
      ackedAt: sql`COALESCE(${command.ackedAt}, ${receivedAt}::timestamptz)`,
      startedAt: sql`COALESCE(${command.startedAt}, ${receivedAt}::timestamptz)`,
      metadata: sql`COALESCE(${command.metadata}, '{}'::jsonb) || ${JSON.stringify({
        lateOutcome: { correctedAt: nowIso(), note: LATE_OUTCOME_NOTE },
      })}::jsonb`,
    })
    .where(and(eq(command.id, row.id), eq(command.status, 'timed_out')))
    .returning({ progress: command.progress })
  const flippedRow = flipped[0]
  if (flippedRow === undefined) return
  await db
    .update(command)
    .set({ progress: succeededProgress(flippedRow.progress) })
    .where(eq(command.id, row.id))
  const settled: CommandRecord = { ...row, status: 'succeeded' }
  // Containers, sites and placements are put right only while this deploy is
  // still the server's latest; a newer deploy's rows are never overwritten.
  const current = await markAppliedIfCurrent(db, settled)
  if (current && payload !== null) {
    const dispatchable: DispatchableCommandRecord = { ...settled, payload }
    await applySucceededSideEffects(
      db,
      dispatchable,
      {
        commandId: row.id,
        serverId: row.serverId,
        type: 'environment.deploy',
        attempt: 1,
        queuedAt: row.queuedAt ?? row.createdAt,
      },
      envelope.result
    )
  }
  await deleteCommandDispatch(db, row.id)
}

/**
 * Mark the deployment applied when this command is still the one it last ran.
 * Returns false when a newer deploy has replaced it, or the command carries no
 * environment and generation to place it among the deploys.
 */
async function markAppliedIfCurrent(db: Db, row: CommandRecord): Promise<boolean> {
  const deploy = readDeployContext(row.context)
  if (deploy === null) return false
  const marked = await markDeploymentApplied(db, {
    environmentId: deploy.environmentId,
    serverId: row.serverId,
    generation: deploy.generation,
    commandId: row.id,
    expectedCommandId: row.id,
  })
  return marked !== null
}

/**
 * Handle a stored final outcome. Returns whether the daemon may drop its copy:
 * true once the result is held in the cell for the consumer to settle, or the
 * command row is already final (and corrected when it was a deploy given up on
 * that really succeeded).
 */
export async function settleReportedOutcome(
  db: Db,
  input: {
    serverId: string
    envelope: CommandOutcomeEnvelope
    record: PendingRequestRecord | null
  }
): Promise<boolean> {
  return (await settleOutcome(db, input)) === null
}

/** {@link settleReportedOutcome}, with why the outcome is not stored (`null` when it is). */
async function settleOutcome(
  db: Db,
  input: {
    serverId: string
    envelope: CommandOutcomeEnvelope
    record: PendingRequestRecord | null
  }
): Promise<string | null> {
  const row = await getCommandRecord(db, input.envelope.requestId)
  if (row?.serverId !== input.serverId) return null
  if (!TERMINAL_COMMAND_STATUSES.has(row.status)) {
    return input.record === null
      ? `the command is still ${row.status} and no request in the cell is waiting for it`
      : null
  }
  if (row.status === 'timed_out' && row.type === 'environment.deploy' && input.envelope.ok) {
    await correctTimedOutDeploy(db, row, input.envelope)
  }
  return null
}

/** Longest error text {@link unconfirmedErrorText} keeps. */
const UNCONFIRMED_ERROR_MAX = 600

/**
 * Why the check threw, reason first: the cause chain (where the database's own
 * error sits under a wrapped query error), then the error itself without the
 * query's bound values, which can carry deploy data.
 */
export function unconfirmedErrorText(err: unknown): string {
  const head = (err instanceof Error ? err.message : String(err)).replace(/\s*params:[\s\S]*$/, '')
  const causes = describeErrorCauses(err).replaceAll('\n', ' | ')
  const text = causes === '' ? head : `${causes} | ${head}`
  return text.slice(0, UNCONFIRMED_ERROR_MAX)
}

/** Most distinct keys {@link warnUnconfirmedOnce} remembers before it starts over. */
const UNCONFIRMED_LOG_KEYS_MAX = 1000
const unconfirmedLogKeys = new Set<string>()

/**
 * Say why a result was not confirmed, once per key per process: the daemon
 * sends an unconfirmed result again every 30 seconds, and the first line is
 * enough to see why it stays stuck.
 */
function warnUnconfirmedOnce(key: string, message: string): void {
  if (unconfirmedLogKeys.has(key)) return
  if (unconfirmedLogKeys.size >= UNCONFIRMED_LOG_KEYS_MAX) unconfirmedLogKeys.clear()
  unconfirmedLogKeys.add(key)
  compatLogWarn('command-recovery', message)
}

/**
 * After a `command-outcome` frame has been applied: the ack to send back, or
 * `null` when the daemon should keep its copy (an older daemon that does not
 * know the ack, or an outcome that is not stored yet). Never throws. Each
 * reason for keeping it unconfirmed is logged once, so a result the server
 * keeps sending is never stuck without a trace.
 */
export async function ackForReportedOutcome(
  db: Db,
  input: {
    serverId: string
    envelope: CommandOutcomeEnvelope
    record: PendingRequestRecord | null
    at?: string
  }
): Promise<CommandOutcomeAckMessage | null> {
  const id = input.envelope.requestId
  try {
    if (!(await serverHasCommandRecovery(db, input.serverId))) {
      warnUnconfirmedOnce(
        `features:${input.serverId}`,
        `results from server ${input.serverId} are not confirmed: its stored daemon features do not list command-recovery-v1`
      )
      return null
    }
    const notStored = await settleOutcome(db, input)
    if (notStored === null) return commandOutcomeAckMessage(id, input.at ?? nowIso())
    warnUnconfirmedOnce(`kept:${id}`, `result for command ${id} not confirmed: ${notStored}`)
    return null
  } catch (err) {
    warnUnconfirmedOnce(
      `error:${id}`,
      `result for command ${id} not confirmed: ${unconfirmedErrorText(err)}`
    )
    return null
  }
}
