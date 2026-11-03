/**
 * The retry policy both runtimes apply to a command whose processing failed
 * (the self-hosted RabbitMQ consumer and the Workers queue consumer), so a
 * passing outage behaves the same on both: wait, try again a few times, then
 * fail the command with a plain reason instead of spinning or dropping it.
 */
import type { CommandEnvelope } from './envelope.ts'

/**
 * Waits before each new try after a passing failure (database, cell or broker
 * briefly unreachable). Attempt 1 is the first delivery; after the last wait
 * here fails too, the command is failed.
 */
export const COMMAND_RETRY_DELAYS_SECONDS = [5, 30, 120, 600] as const

/** How long a command waits before it looks again when its server is busy. */
export const SERVER_BUSY_DELAY_SECONDS = 10

/** `command.error_code` of a command given up on after its retries. */
export const QUEUE_RETRY_EXHAUSTED_CODE = 'queue_retry_exhausted'

/** Another command of the same server runs or comes first: try again shortly. */
export class ServerBusyError extends Error {
  constructor(serverId: string) {
    super(`server ${serverId} is running another command`)
    this.name = 'ServerBusyError'
  }
}

export type RetryDecision =
  | { kind: 'later'; envelope: CommandEnvelope; delaySeconds: number }
  | { kind: 'give_up'; error: string }

/**
 * What to do with a command whose processing failed for a passing reason:
 * put it back with the next wait (counting the attempt), or give up on it.
 */
export function decideRetry(envelope: CommandEnvelope, errorText: string): RetryDecision {
  const delay = COMMAND_RETRY_DELAYS_SECONDS[envelope.attempt - 1]
  if (delay === undefined) {
    return {
      kind: 'give_up',
      error: `The control plane could not process this command after ${envelope.attempt} tries: ${errorText}`,
    }
  }
  return {
    kind: 'later',
    envelope: { ...envelope, attempt: envelope.attempt + 1 },
    delaySeconds: delay,
  }
}
