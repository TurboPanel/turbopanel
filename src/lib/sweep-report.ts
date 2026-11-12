/**
 * One structured log line per sweep tick that did anything, and an alert line
 * when most of what it tried failed. Operators watch these two lines for the
 * failure rate of certificate renewals; nothing is stored.
 */
import { logError, logInfo } from './logger.ts'

/** Failures needed before a tick can raise the alert. */
export const ALERT_MIN_FAILURES = 3

export function reportSweep(
  component: string,
  label: string,
  counts: Readonly<Record<string, number>>,
  attempt: { tried: number; failed: number }
): void {
  const parts = Object.entries(counts).map(([key, value]) => `${key}=${value}`)
  if (!Object.values(counts).some((value) => value > 0)) return
  logInfo(component, `${label} ${parts.join(' ')}`)
  if (attempt.failed >= ALERT_MIN_FAILURES && attempt.failed * 2 >= attempt.tried) {
    logError(
      component,
      `${label} alert: ${attempt.failed} of ${attempt.tried} attempts failed ${parts.join(' ')}`
    )
  }
}
