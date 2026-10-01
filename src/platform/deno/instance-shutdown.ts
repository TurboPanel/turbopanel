import { logWarn } from '../../lib/logger.ts'

/**
 * Hard stop for a shutdown that is not finishing. systemd gives the unit
 * `TimeoutStopSec=10` before SIGKILL; leave it time to flush and close, but
 * exit on our own terms (status 0) rather than be killed.
 */
export const SHUTDOWN_FORCE_EXIT_MS = 6_000

export type ShutdownCloser = {
  label: string
  close: () => Promise<unknown> | unknown
}

export type InstanceShutdownDeps = {
  /** Interval timers to stop first. */
  timers: ReturnType<typeof setInterval>[]
  /** Queues, consumers and stores to close, in order. */
  closers: ShutdownCloser[]
  /** Clear the runtime ports registered at boot. */
  resetPorts: () => void
  /** Stop accepting connections (aborts `Deno.serve`). */
  stopServing: () => void
  /** End the Postgres pool. Last: it is what keeps an idle process alive. */
  endDatabase: () => Promise<unknown>
  /** Process exit; injected so tests do not exit. */
  exit?: (code: number) => void
  /** Watchdog delay; defaults to {@link SHUTDOWN_FORCE_EXIT_MS}. */
  forceExitMs?: number
}

/** One shutdown step; a failure is logged and never stops the steps after it. */
async function runStep(label: string, step: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await step()
  } catch (err) {
    logWarn('shutdown', `${label} failed: ${String(err)}`)
  }
}

async function runShutdownSteps(deps: InstanceShutdownDeps): Promise<void> {
  for (const timer of deps.timers) clearInterval(timer)
  for (const closer of deps.closers) {
    await runStep(closer.label, closer.close)
  }
  await runStep('runtime ports', deps.resetPorts)
  await runStep('server', deps.stopServing)
  await runStep('database', deps.endDatabase)
}

/**
 * The SIGINT/SIGTERM handler: close what holds data (queues, consumers, the
 * metrics store's batched samples), stop accepting connections, then **exit**.
 *
 * Aborting `Deno.serve` only stops accepting. The process stays alive on the
 * pooled Postgres connections and any upgraded daemon WebSockets, so a plain
 * `systemctl stop` used to wait out `TimeoutStopSec` and end in SIGKILL.
 * Ending the database pool and calling `Deno.exit` finishes the stop in about
 * a second; the unref'd watchdog covers a step that never returns.
 */
export function createInstanceShutdown(deps: InstanceShutdownDeps): () => void {
  const exit = deps.exit ?? ((code: number) => Deno.exit(code))
  let started = false
  return () => {
    if (started) return
    started = true
    const forceExitMs = deps.forceExitMs ?? SHUTDOWN_FORCE_EXIT_MS
    const watchdog = setTimeout(() => {
      logWarn('shutdown', `still running after ${forceExitMs} ms; exiting`)
      exit(0)
    }, forceExitMs)
    Deno.unrefTimer(watchdog)
    void runShutdownSteps(deps).then(() => {
      clearTimeout(watchdog)
      exit(0)
    })
  }
}
