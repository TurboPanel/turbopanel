/**
 * Module-scoped execution-log sink for the command terminal transition.
 *
 * Terminal transitions fire from runtimes that do not share a Hono context
 * (Workers queue consumer, Durable Object, cron isolate, the Deno AMQP
 * consumer), so — exactly as with `setServerStatusEventSink` for status
 * events — a registered sink beats threading a store through every
 * `transitionCommand` caller.
 *
 * Module scope is safe: the sink holds an R2 binding wrapper, a filesystem
 * root, or an S3 config — never a request-scoped socket.
 */

import type { ExecutionLogStore } from './types.ts'

export type ExecutionLogSealSink = Pick<ExecutionLogStore, 'seal'>

let registeredSink: ExecutionLogSealSink | null = null

export function setExecutionLogSealSink(sink: ExecutionLogSealSink | null): void {
  registeredSink = sink
}

export function getExecutionLogSealSink(): ExecutionLogSealSink | null {
  return registeredSink
}

/** Test seam: clear the registered sink between suites. */
export function resetExecutionLogSealSinkForTests(): void {
  registeredSink = null
}

/**
 * Compact a command's transcript on its terminal transition. Best effort by
 * contract — sealing must never fail an otherwise-successful (or
 * otherwise-failed) command transition, matching `finalizeCommandDispatch`.
 * An unsealed transcript is still readable; it is simply not compacted yet,
 * and the retention sweep still reaches it.
 */
export async function sealExecutionLogOnTerminal(
  commandId: string,
  sink?: ExecutionLogSealSink | null
): Promise<void> {
  const resolved = sink ?? registeredSink
  if (!resolved) return
  try {
    await resolved.seal(commandId)
  } catch {
    // Swallowed by design — see the contract note above.
  }
}
