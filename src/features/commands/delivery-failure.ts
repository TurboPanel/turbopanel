/**
 * What a runtime's queue consumer does with a delivery whose processing threw.
 * Shared by the self-hosted consumer (`deno-consumer.ts`) and the Workers
 * `queue()` handler so both treat a busy server, a passing outage and a
 * broken message the same way. See `delivery-retry.ts` for the policy.
 */
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import { compatLogError, compatLogWarn } from '../../lib/log-compat.ts'
import { type CommandConsumerDeps, failCommandAfterRetries, isTransientError } from './consumer.ts'
import { decideRetry, SERVER_BUSY_DELAY_SECONDS, ServerBusyError } from './delivery-retry.ts'
import type { CommandEnvelope } from './envelope.ts'
import type { CommandQueue } from './queue.ts'

export type DeliveryOutcome =
  /** Handled: a new message was queued, or the command was failed. Ack this one. */
  | 'ack'
  /** Cannot be processed at all: send it to the dead-letter queue. */
  | 'dead_letter'
  /** Could not queue the retry: hand this message back to the queue to deliver again. */
  | 'redeliver'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function putBack(
  queue: CommandQueue | undefined,
  envelope: CommandEnvelope,
  delaySeconds: number
): Promise<boolean> {
  if (!queue) return false
  try {
    await queue.enqueue(envelope, { delaySeconds })
    return true
  } catch (error) {
    compatLogWarn('command-consumer', `could not queue a retry: ${errorText(error)}`)
    return false
  }
}

export async function settleFailedDelivery(input: {
  db: Db
  queue: CommandQueue | undefined
  /** `null` when the message did not parse. */
  envelope: CommandEnvelope | null
  error: unknown
  deps?: CommandConsumerDeps
  /** Lets a command given up on be taken back from its server's outbox first. */
  registry?: DaemonCellRegistry
  /** Test seam: how a command is failed after its retries. */
  failCommand?: typeof failCommandAfterRetries
}): Promise<DeliveryOutcome> {
  const { envelope, error } = input
  if (envelope === null) {
    compatLogError('command-consumer', `permanent error, dead-lettering: ${errorText(error)}`)
    return 'dead_letter'
  }
  if (error instanceof ServerBusyError) {
    // Not a failure: the command waits its turn and the attempt is not counted.
    const queued = await putBack(input.queue, envelope, SERVER_BUSY_DELAY_SECONDS)
    return queued ? 'ack' : 'redeliver'
  }
  if (!isTransientError(error)) {
    compatLogError(
      'command-consumer',
      `permanent error on command ${envelope.commandId}, dead-lettering: ${errorText(error)}`
    )
    return 'dead_letter'
  }
  const decision = decideRetry(envelope, errorText(error))
  if (decision.kind === 'later') {
    compatLogWarn(
      'command-consumer',
      `passing error on command ${envelope.commandId} (attempt ${envelope.attempt}), ` +
        `trying again in ${decision.delaySeconds}s: ${errorText(error)}`
    )
    const queued = await putBack(input.queue, decision.envelope, decision.delaySeconds)
    return queued ? 'ack' : 'redeliver'
  }
  try {
    const failCommand = input.failCommand ?? failCommandAfterRetries
    const result = await failCommand(input.db, envelope, decision.error, input.deps, input.registry)
    compatLogError(
      'command-consumer',
      result === 'left_running'
        ? `stopped waiting on command ${envelope.commandId} (it may be running on its server; ` +
            `the stale-command sweep ends it): ${decision.error}`
        : `gave up on command ${envelope.commandId}: ${decision.error}`
    )
    return 'ack'
  } catch (failError) {
    // The database is still out: nothing can record the failure now. The
    // dead-letter queue keeps the message and the stale sweep ends the command.
    compatLogError(
      'command-consumer',
      `could not fail command ${envelope.commandId} after its retries: ${errorText(failError)}`
    )
    return 'dead_letter'
  }
}
