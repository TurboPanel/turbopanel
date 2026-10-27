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

/** A time the daemon reported, or `fallback` when it is missing or not a time. */
function reportedTime(value: string | undefined, fallback: string): string {
  return value !== undefined && Number.isFinite(Date.parse(value)) ? value : fallback
}

/** The command row put right with everything the server reported. */
function fullCorrection(row: CommandRecord, envelope: CommandOutcomeEnvelope) {
  const finishedAt = reportedTime(envelope.daemonRespondedAt ?? envelope.at, nowIso())
  const receivedAt = reportedTime(envelope.daemonReceivedAt, finishedAt)
  return {
    status: 'succeeded',
    errorMessage: null,
    errorCode: null,
    resultSummary: resultSummaryForPersist(row.type, envelope.result),
    finishedAt,
    updatedAt: nowIso(),
    ackedAt: sql`COALESCE(${command.ackedAt}, ${receivedAt}::timestamptz)`,
    startedAt: sql`COALESCE(${command.startedAt}, ${receivedAt}::timestamptz)`,
    metadata: lateOutcomeMetadata(),
  }
}

/** The status and note alone, for when the server's report itself cannot be stored. */
function bareCorrection() {
  return {
    status: 'succeeded',
    errorMessage: null,
    errorCode: null,
    updatedAt: nowIso(),
    metadata: lateOutcomeMetadata(),
  }
}

/** `command.metadata` with the late-outcome note added. */
function lateOutcomeMetadata() {
  return sql`COALESCE(${command.metadata}, '{}'::jsonb) || ${JSON.stringify({
    lateOutcome: { correctedAt: nowIso(), note: LATE_OUTCOME_NOTE },
  })}::jsonb`
}

/**
 * Flip a `timed_out` command to `succeeded`. Returns its stored progress, or
 * null when it was not `timed_out`.
 */
async function flipTimedOut(
  db: Db,
  commandId: string,
  set: ReturnType<typeof fullCorrection> | ReturnType<typeof bareCorrection>
): Promise<{ progress: unknown } | null> {
  const flipped = await db
    .update(command)
    .set(set)
    .where(and(eq(command.id, commandId), eq(command.status, 'timed_out')))
    .returning({ progress: command.progress })
  return flipped[0] ?? null
}

/** Log a late result that was confirmed although part of its correction failed. */
function warnLateCorrection(commandId: string, what: string, err: unknown): void {
  const causes = describeErrorCauses(err).replaceAll('\n', ' | ')
  const reason = causes === '' ? String(err) : causes
  compatLogWarn('command-recovery', `late result for command ${commandId}: ${what}: ${reason}`)
}

/**
 * Store the late success on the command row. Only this decides whether the
 * daemon may drop its copy: when the full report cannot be written (a value the
 * database refuses), the status alone is corrected so the result is still
 * confirmed. A failure of both (the database is down) throws, and the daemon
 * sends the result again.
 */
async function storeLateSuccess(
  db: Db,
  row: CommandRecord,
  envelope: CommandOutcomeEnvelope
): Promise<{ progress: unknown } | null> {
  try {
    return await flipTimedOut(db, row.id, fullCorrection(row, envelope))
  } catch (err) {
    warnLateCorrection(row.id, 'the report could not be stored, only the status was corrected', err)
    return await flipTimedOut(db, row.id, bareCorrection())
  }
}

/**
 * A deploy gave up as `timed_out` that the server now says succeeded. Once the
 * command row is corrected, the rest (step plan, deployment, containers, the
 * kept payload) is best effort: a failure there is logged with the command id
 * and never keeps the result unconfirmed. It is not retried either; a resend
 * finds the command already `succeeded` and would skip it anyway, and the next
 * deploy writes those rows afresh.
 */
async function correctTimedOutDeploy(
  db: Db,
  row: CommandRecord,
  envelope: CommandOutcomeEnvelope
): Promise<void> {
  const flipped = await storeLateSuccess(db, row, envelope)
  if (flipped === null) return
  try {
    await finishLateSuccess(db, row, envelope, flipped.progress)
  } catch (err) {
    warnLateCorrection(row.id, 'the deploy records were not updated', err)
  }
}

/** Everything a corrected deploy puts right besides its command row. */
async function finishLateSuccess(
  db: Db,
  row: CommandRecord,
  envelope: CommandOutcomeEnvelope,
  progress: unknown
): Promise<void> {
  await db
    .update(command)
    .set({ progress: succeededProgress(progress) })
    .where(eq(command.id, row.id))
  const settled: CommandRecord = { ...row, status: 'succeeded' }
  // Containers, sites and placements are put right only while this deploy is
  // still the server's latest; a newer deploy's rows are never overwritten. An
  // environment deleted since has no deployment row, so nothing is written for it.
  const current = await markAppliedIfCurrent(db, settled)
  const payload = current ? await getCommandDispatchPayload(db, row.id) : null
  if (payload !== null) {
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
  const row = await getCommandRecord(db, input.envelope.requestId)
  if (row?.serverId !== input.serverId) return true
  if (!TERMINAL_COMMAND_STATUSES.has(row.status)) return input.record !== null
  if (row.status === 'timed_out' && row.type === 'environment.deploy' && input.envelope.ok) {
    await correctTimedOutDeploy(db, row, input.envelope)
  }
  return true
}

/**
 * After a `command-outcome` frame has been applied: the ack to send back, or
 * `null` when the daemon should keep its copy (an older daemon that does not
 * know the ack, or an outcome that is not stored yet). Never throws.
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
  try {
    if (!(await serverHasCommandRecovery(db, input.serverId))) return null
    const stored = await settleReportedOutcome(db, input)
    return stored ? commandOutcomeAckMessage(input.envelope.requestId, input.at ?? nowIso()) : null
  } catch {
    return null
  }
}
