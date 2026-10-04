/**
 * Cancel a deploy that is queued or running.
 *
 * A deploy is one `environment.deploy` command per server (one per rollout
 * batch member). Cancelling stops the whole deploy: every command of the same
 * environment and generation that has not finished, plus any rollout batch still
 * waiting. What each one needs depends on how far it got:
 *
 * - `queued`: nothing has been sent, so the row goes straight to `cancelled`
 *   with one conditional update (the consumer skips terminal rows).
 * - `dispatching` / `sent` (and `acked` / `running`): the host may be working.
 *   The control plane sends the daemon a `deploy-cancel` cell message and stamps
 *   `cancelRequestedAt` on the command. That stamp is the in-between
 *   "cancelling" state: the command stays live until the daemon's outcome
 *   arrives, so every "is a deploy in progress" check keeps working (a new
 *   command status would silently fall out of those lists). The daemon answers
 *   `cancelling` (it stopped, or will), `not_running` (it has no such deploy
 *   yet or any more; it remembers the id so a late dispatch is refused) or
 *   `too_late` (the deploy already switched over and will finish).
 * - The deploy's own outcome closes it: the daemon fails the command with an
 *   error starting `cancelled: `, which the consumer records as command status
 *   `cancelled` (see `deploy-outcome.ts`).
 *
 * The previous version keeps serving in every cancelled case: the daemon only
 * honours a cancel before it switches anything over.
 *
 * No step-up re-authentication: `step-up-actions.ts` leaves out actions a
 * re-deploy fully reverses, and a cancel keeps the staged changes.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import {
  DEPLOY_CANCEL_OUTCOMES,
  type DaemonOutboundEnvelope,
  type DeployCancelOutcome,
  generateDeliveryId,
  generateRequestId,
} from '../../contracts/cell-protocol.ts'
import type { Db } from '../../db/connection.ts'
import { command } from '../../db/schema.ts'
import { cellTrace } from '../../lib/logger.ts'
import { DEPLOY_CANCEL_FEATURE } from '../../lib/version-wire.ts'
import {
  cancelQueuedCommand,
  claimCommandMetadataFlag,
  getCommandRecord,
} from '../commands/command-records.ts'
import { TERMINAL_COMMAND_STATUSES } from '../commands/types.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import { CANCELLED_ERROR_PREFIX, DEPLOY_CANCELLED_ERROR_CODE } from './deploy-outcome.ts'
import { markDeploymentFailed } from './deployment-records.ts'
import { haltRollout, readDeployContext } from './rollout.ts'

/** `command.metadata` key stamped when a cancel was requested (ISO timestamp). */
export const CANCEL_REQUESTED_FLAG = 'cancelRequestedAt'

/** How long the route waits for the daemon's answer before it settles for "asked". */
export const CANCEL_ANSWER_TIMEOUT_MS = 8000

const DEPLOY_COMMAND_NAME = 'environment.deploy'

export type CancelDeployState = 'cancelled' | 'cancelling' | 'already_cancelled'

export type CancelDeployResult =
  | {
      ok: true
      state: CancelDeployState
      /** Servers whose deploy was stopped, or told to stop. */
      serverIds: string[]
    }
  | {
      ok: false
      status: 404 | 409 | 503
      error:
        | 'Not found'
        | 'deploy_not_cancellable'
        | 'deploy_too_late'
        | 'cancel_unsupported'
        | 'daemon_unavailable'
    }

export type CancelDeployDeps = {
  /** Advertised daemon features for a server; defaults to the stored projection. */
  daemonFeatures?: (serverId: string) => Promise<readonly string[]>
  /**
   * Send `deploy-cancel` and wait for the answer. `no_answer` means the daemon
   * did not reply in time (offline, or slow): the request stays queued for it.
   */
  requestCancel?: (
    serverId: string,
    commandId: string
  ) => Promise<DeployCancelOutcome | 'no_answer'>
}

type SiblingRow = { id: string; serverId: string; status: string }

async function listLiveDeployCommands(
  db: Db,
  environmentId: string,
  generation: number
): Promise<SiblingRow[]> {
  const rows = await db
    .select({ id: command.id, serverId: command.serverId, status: command.status })
    .from(command)
    .where(
      and(
        eq(command.name, DEPLOY_COMMAND_NAME),
        sql`${command.context} ->> 'environmentId' = ${environmentId}`,
        sql`${command.context} ->> 'generation' = ${String(generation)}`
      )
    )
  return rows.filter((row) => !(TERMINAL_COMMAND_STATUSES as ReadonlySet<string>).has(row.status))
}

const noDaemon: NonNullable<CancelDeployDeps['requestCancel']> = () => Promise.resolve('no_answer')

function defaultRequestCancel(
  registry: DaemonCellRegistry
): NonNullable<CancelDeployDeps['requestCancel']> {
  return async (serverId, commandId) => {
    const requestId = generateRequestId()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'deploy-cancel',
      deliveryId: generateDeliveryId(),
      requestId,
      commandId,
      at: new Date().toISOString(),
    }
    cellTrace('request-start', { requestId, serverId, kind: 'deploy-cancel' })
    try {
      const record = await registry
        .getCell(serverId)
        .createRequestAndWait(envelope, CANCEL_ANSWER_TIMEOUT_MS)
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'deploy-cancel',
        pendingStatus: record.status,
      })
      return readCancelOutcome(record.status, record.result)
    } catch (err) {
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'deploy-cancel',
        resultStatus: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
      return 'no_answer'
    }
  }
}

/** The daemon's `outcome`, or `no_answer` when it did not give a usable one. */
function readCancelOutcome(status: string, result: unknown): DeployCancelOutcome | 'no_answer' {
  if (status !== 'done' || typeof result !== 'object' || result === null) return 'no_answer'
  const outcome = (result as { outcome?: unknown }).outcome
  return (DEPLOY_CANCEL_OUTCOMES as readonly unknown[]).includes(outcome)
    ? (outcome as DeployCancelOutcome)
    : 'no_answer'
}

async function storedDaemonFeatures(db: Db, serverId: string): Promise<readonly string[]> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return state?.projection?.features ?? []
}

/** The first server whose daemon cannot cancel, or `null` when all can. */
async function firstUnsupportedServer(
  serverIds: readonly string[],
  daemonFeatures: NonNullable<CancelDeployDeps['daemonFeatures']>
): Promise<string | null> {
  for (const serverId of serverIds) {
    if (!(await daemonFeatures(serverId)).includes(DEPLOY_CANCEL_FEATURE)) return serverId
  }
  return null
}

type Tally = { cancelledDirect: string[]; signalled: string[]; tooLate: string[] }

async function cancelOne(
  db: Db,
  environmentId: string,
  row: SiblingRow,
  requestCancel: NonNullable<CancelDeployDeps['requestCancel']>,
  tally: Tally
): Promise<void> {
  if (row.status === 'queued') {
    const error = `${CANCELLED_ERROR_PREFIX}cancelled before it started; nothing was changed`
    const won = await cancelQueuedCommand(db, row.id, {
      error,
      errorCode: DEPLOY_CANCELLED_ERROR_CODE,
    })
    if (won) {
      await markDeploymentFailed(db, {
        environmentId,
        serverId: row.serverId,
        error,
        commandId: row.id,
        expectedCommandId: row.id,
        expectedStatus: 'applying',
        outcome: 'failed',
        cancelled: true,
      })
      tally.cancelledDirect.push(row.serverId)
      return
    }
  }
  // The daemon is asked first and the stamp follows: a `too_late` answer must
  // not leave a deploy that keeps going reading as "cancelling".
  const outcome = await requestCancel(row.serverId, row.id)
  if (outcome === 'too_late') {
    tally.tooLate.push(row.serverId)
    return
  }
  await claimCommandMetadataFlag(db, row.id, CANCEL_REQUESTED_FLAG)
  tally.signalled.push(row.serverId)
}

function summarize(tally: Tally): CancelDeployResult {
  if (tally.cancelledDirect.length + tally.signalled.length === 0) {
    return { ok: false, status: 409, error: 'deploy_too_late' }
  }
  return {
    ok: true,
    state: tally.signalled.length > 0 ? 'cancelling' : 'cancelled',
    serverIds: [...tally.cancelledDirect, ...tally.signalled],
  }
}

/**
 * Cancel the deploy `deploymentId` (a command id) belongs to. Idempotent:
 * cancelling a cancelled deploy answers `already_cancelled`, a finished one is
 * a 409 `deploy_not_cancellable`. Authorization is the caller's job.
 */
export async function cancelEnvironmentDeploy(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  params: { environmentId: string; deploymentId: string },
  deps: CancelDeployDeps = {}
): Promise<CancelDeployResult> {
  const anchor = await getCommandRecord(db, params.deploymentId)
  if (!anchor || anchor.type !== DEPLOY_COMMAND_NAME) {
    return { ok: false, status: 404, error: 'Not found' }
  }
  const deploy = readDeployContext(anchor.context)
  if (deploy === null || deploy.environmentId !== params.environmentId) {
    return { ok: false, status: 404, error: 'Not found' }
  }

  const live = await listLiveDeployCommands(db, deploy.environmentId, deploy.generation)
  if (live.length === 0) {
    return anchor.status === 'cancelled'
      ? { ok: true, state: 'already_cancelled', serverIds: [] }
      : { ok: false, status: 409, error: 'deploy_not_cancellable' }
  }

  const inFlight = live.filter((row) => row.status !== 'queued')
  const requestCancel = deps.requestCancel ?? (registry ? defaultRequestCancel(registry) : noDaemon)
  if (inFlight.length > 0 && requestCancel === noDaemon) {
    return { ok: false, status: 503, error: 'daemon_unavailable' }
  }
  const daemonFeatures = deps.daemonFeatures ?? ((serverId) => storedDaemonFeatures(db, serverId))
  const unsupported = await firstUnsupportedServer(
    inFlight.map((row) => row.serverId),
    daemonFeatures
  )
  if (unsupported !== null) return { ok: false, status: 409, error: 'cancel_unsupported' }

  // Nothing waiting in a later rollout batch may start behind a cancelled deploy.
  await haltRollout(db, {
    environmentId: deploy.environmentId,
    generation: deploy.generation,
    reason: 'the deploy was cancelled',
  })

  // Re-read: halting cancelled the commands of the batches that were waiting.
  const remaining = await listLiveDeployCommands(db, deploy.environmentId, deploy.generation)
  const tally: Tally = { cancelledDirect: [], signalled: [], tooLate: [] }
  for (const row of remaining) {
    // One at a time: a rolling deploy has a handful of servers, and the order
    // keeps the answers attributable.
    await cancelOne(db, deploy.environmentId, row, requestCancel, tally)
  }
  return summarize(tally)
}
