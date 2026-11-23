/**
 * Trace output and isolation helper shared by the offline sweep and its
 * retention sweeps (see offline-sweep.ts).
 */

/** Format a trace field without relying on Object's default `[object Object]`. */
function formatSweepTraceValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value)
    default:
      return JSON.stringify(value)
  }
}

export function sweepTrace(event: string, detail: Record<string, unknown> = {}): void {
  const parts = [`offline-sweep event=${event}`]
  for (const key of Object.keys(detail).sort((a, b) => a.localeCompare(b))) {
    const value = detail[key]
    if (value === undefined || value === null) continue
    parts.push(`${key}=${formatSweepTraceValue(value)}`)
  }
  console.info(parts.join(' '))
}

/**
 * The error text for a sweep trace. A failed query wraps the database's own
 * error in `cause` and only says "Failed query: <sql>", so the cause is added.
 */
export function sweepErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause instanceof Error ? err.cause.message : undefined
  return cause && cause !== err.message ? `${err.message} (cause: ${cause})` : err.message
}

/**
 * Run one isolated sweep inside the queued reconcile phase. A failure is traced
 * and never stops the others. Once the phase is out of budget (`signal`
 * aborted) no further sweep starts: the tick is about to close its database
 * connection, so a sweep started now could only fail.
 */
export async function runIsolatedSweep(
  signal: AbortSignal | undefined,
  failureEvent: string,
  sweep: () => Promise<unknown>
): Promise<void> {
  if (signal?.aborted) return
  try {
    await sweep()
  } catch (err) {
    sweepTrace(failureEvent, { error: sweepErrorMessage(err) })
  }
}
