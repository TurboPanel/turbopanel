/**
 * What the control plane does with a daemon's recovery traffic
 * (`command-recovery-v1`), shared by both transports (`daemon/deno-ws.ts` and
 * `daemon/cell/do.ts`):
 *
 * - {@link noteReportedCommands}: a `commands.running` list on `hello` or
 *   `heartbeat` is a sign of life for those commands.
 * - {@link redeliverLostCommands}: on `hello`, a command written to the previous
 *   connection that the daemon never received is sent again.
 * - {@link settleReportedOutcome}: a final `command-outcome` is confirmed to
 *   the daemon (`command-outcome-ack`) only once it is stored. A deploy that
 *   was already given up on (`timed_out`) and whose server now reports that it
 *   succeeded is corrected to `succeeded`, never dropped.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { DaemonCell, PendingRequestRecord } from '../../contracts/cell.ts'
import {
  type CommandOutcomeAckMessage,
  type CommandRecoveryReport,
  type DaemonInboundEnvelope,
  generateDeliveryId,
} from '../../contracts/cell-protocol.ts'
import type { Db } from '../../db/connection.ts'
import { command } from '../../db/schema.ts'
import { describeErrorCauses } from '../../lib/describe-error.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { COMMAND_RECOVERY_FEATURE } from '../../lib/version-wire.ts'
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
 * The command types that are safe to run twice, the only ones sent again. A
 * daemon that restarted since it received a frame cannot list it in its first
 * hello (its journal is read after attach) and has forgotten its seen ids, so
 * a resend could run the command a second time. Every type here is a
 * reconcile (state converges to the same result) or a read-only probe. Deploy,
 * destroy, delete, rollback, rotation, restore and failover stay on their
 * current paths. Widening this needs a daemon feature that reports journal ids
 * or a process start id in the hello.
 */
export const REDELIVERABLE_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'daemon.ping',
  'server.fabric.reconcile',
  'server.tls.trust.reconcile',
  'server.principals.reconcile',
  'server.firewall.reconcile',
  'server.backups.reconcile',
  'server.tunnel.status',
  'managed.ingress.reconcile',
  'system.reconcile',
])

/** Most requests {@link redeliverLostCommands} looks at in one hello. */
const REDELIVER_REQUEST_LIMIT = 50

/** The cell calls {@link redeliverLostCommands} needs. */
export type RedeliveryCell = Pick<DaemonCell, 'getRequest' | 'listRequests' | 'redeliverSent'>

/** The database reads {@link redeliverLostCommands} makes, replaceable in a test. */
export type RedeliveryReads = {
  getCommandRecord: typeof getCommandRecord
  getCommandDispatchPayload: typeof getCommandDispatchPayload
}

const DEFAULT_REDELIVERY_READS: RedeliveryReads = { getCommandRecord, getCommandDispatchPayload }

/**
 * The ids of command requests the cell wrote to a socket that the daemon never
 * acknowledged and does not report as running or holding a result. A frame
 * written to a connection that was closing is marked delivered by the outbox
 * but never reaches the daemon, so nothing else would send it again.
 */
export function lostCommandIds(
  requests: readonly PendingRequestRecord[],
  report: CommandRecoveryReport | undefined
): string[] {
  const carried = new Set([...(report?.running ?? []), ...(report?.unacked ?? [])])
  return requests
    .filter(
      (request) =>
        request.requestKind === 'command-dispatch' &&
        request.status === 'sent' &&
        !request.ackAt &&
        !carried.has(request.requestId)
    )
    .map((request) => request.requestId)
}

/**
 * Send again, over the new connection, every command the daemon cannot have
 * received. Call it on `hello` only. A hello from a daemon without
 * `command-recovery-v1` leaves its lists out even when it is running work, so
 * nothing is sent for it.
 *
 * The command row stays `sent` and the consumer that is already waiting keeps
 * waiting on the same request: the cell re-delivers a request enqueued again
 * with a new delivery id and leaves its status alone, and the daemon drops a
 * command id it has already seen. A request that is gone or already answered,
 * or a command that is no longer `sent`, is never sent. The database is opened
 * (through `withDb`) only when the cell holds such a request, so an ordinary
 * hello costs one cell read. No timer. Best effort: a failure is logged.
 * Returns the ids sent again.
 */
export async function redeliverLostCommands(
  cell: RedeliveryCell,
  withDb: (fn: (db: Db) => Promise<void>) => Promise<void>,
  input: {
    serverId: string
    features: readonly string[] | undefined
    report: CommandRecoveryReport | undefined
  },
  reads: RedeliveryReads = DEFAULT_REDELIVERY_READS
): Promise<string[]> {
  const resent: string[] = []
  if (input.features?.includes(COMMAND_RECOVERY_FEATURE) !== true) return resent
  try {
    const requests = await cell.listRequests(REDELIVER_REQUEST_LIMIT, {
      requestKind: 'command-dispatch',
    })
    const lost = lostCommandIds(requests, input.report)
    if (lost.length === 0) return resent
    await withDb(async (db) => {
      const outcomes = await Promise.all(
        lost.map((commandId) => redeliverOne(db, cell, reads, input.serverId, commandId))
      )
      lost.forEach((commandId, i) => {
        if (outcomes[i]) resent.push(commandId)
      })
    })
  } catch (err) {
    compatLogWarn(
      'command-recovery',
      `could not send lost commands again to server ${input.serverId}: ${unconfirmedErrorText(err)}`
    )
  }
  return resent
}

async function redeliverOne(
  db: Db,
  cell: RedeliveryCell,
  reads: RedeliveryReads,
  serverId: string,
  commandId: string
): Promise<boolean> {
  try {
    const row = await reads.getCommandRecord(db, commandId)
    if (row?.serverId !== serverId || row.status !== 'sent' || row.ackedAt !== null) return false
    if (!REDELIVERABLE_COMMAND_TYPES.has(row.type)) return false
    const payload = await reads.getCommandDispatchPayload(db, commandId)
    if (payload === null) return false
    // The database reads are done; the cell checks the request again, in one
    // step, and only replaces the delivery of a request still `sent` and unacked.
    if (cell.redeliverSent === undefined) return false
    return await cell.redeliverSent({
      kind: 'command-dispatch',
      requestId: commandId,
      deliveryId: generateDeliveryId(),
      at: nowIso(),
      commandId,
      commandType: row.type,
      payload,
    })
  } catch (err) {
    compatLogWarn(
      'command-recovery',
      `could not send command ${commandId} again: ${unconfirmedErrorText(err)}`
    )
    return false
  }
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
  compatLogWarn(
    'command-recovery',
    `late result for command ${commandId}: ${what}: ${unconfirmedErrorText(err)}`
  )
}

/** Most wrapped errors {@link isRefusedValue} looks through. */
const MAX_REFUSAL_DEPTH = 4

/**
 * Did the database refuse a value (SQLSTATE class 22, data, or 23, integrity)?
 * Anything else, such as a lost connection, is worth the daemon's resend.
 */
function isRefusedValue(err: unknown): boolean {
  let current = err
  for (let depth = 0; depth < MAX_REFUSAL_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) return false
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'))) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Store the late success on the command row. Only this decides whether the
 * daemon may drop its copy: when the database refuses a value in the full
 * report, the status alone is corrected so the result is still confirmed. Any
 * other failure (the database is down) throws, and the daemon sends the result
 * again.
 */
async function storeLateSuccess(
  db: Db,
  row: CommandRecord,
  envelope: CommandOutcomeEnvelope
): Promise<{ progress: unknown } | null> {
  try {
    return await flipTimedOut(db, row.id, fullCorrection(row, envelope))
  } catch (err) {
    if (!isRefusedValue(err)) throw err
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
  const message = err instanceof Error ? err.message : String(err)
  const paramsAt = message.indexOf('\nparams:')
  const head = paramsAt === -1 ? message : message.slice(0, paramsAt).trimEnd()
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
