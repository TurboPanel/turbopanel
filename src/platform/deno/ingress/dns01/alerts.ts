/**
 * Who hears about a certificate that is not renewing: one alert at the first
 * failure (per cause), then a countdown at 14, 7, 3 and 1 days before the
 * current certificate expires. Both use the instance-scoped
 * `certificate.expiring` event (`kind` tells them apart); the organization
 * event `certificate.renewal_failed` cannot carry an instance alert.
 */
import type { NotificationContext } from '../../../../features/notifications/events.ts'
import type { Dns01Failure, Dns01State } from './state.ts'

export const EXPIRY_ALERT_DAYS = [14, 7, 3, 1] as const
const DAY_MS = 24 * 60 * 60 * 1000

export type Notify = (context: NotificationContext) => Promise<void>

/** First failure of a run alerts once; the same cause again stays quiet. */
export async function alertOnFailure(
  state: Dns01State,
  host: string,
  failure: Dns01Failure,
  retryAt: string | null,
  notify: Notify
): Promise<Dns01State> {
  if (state.alertedCause === failure.cause) return state
  await notify({
    kind: 'failed',
    hostname: host,
    cause: failure.cause,
    detail: failure.detail,
    retryAt,
  })
  return { ...state, alertedCause: failure.cause }
}

/** The highest threshold the remaining time has crossed, or null. */
export function crossedThreshold(notAfter: Date, now: Date): number | null {
  const daysLeft = (notAfter.getTime() - now.getTime()) / DAY_MS
  if (daysLeft <= 0) return null
  const crossed = EXPIRY_ALERT_DAYS.filter((days) => daysLeft <= days)
  return crossed.length > 0 ? Math.min(...crossed) : null
}

/**
 * Countdown for a name whose renewal is not going through. Each threshold
 * alerts once per certificate; `expiryAlerted` is cleared on a new one.
 */
export async function alertOnExpiry(
  state: Dns01State,
  host: string,
  notAfter: Date | null,
  now: Date,
  notify: Notify
): Promise<Dns01State> {
  const struggling = state.stage === 'failed' || state.stage === 'backoff'
  if (!notAfter || !struggling) return state
  const threshold = crossedThreshold(notAfter, now)
  if (threshold === null || state.expiryAlerted.includes(threshold)) return state
  await notify({
    kind: 'countdown',
    hostname: host,
    daysLeft: threshold,
    notAfter: notAfter.toISOString(),
    cause: state.lastError?.cause ?? null,
    detail: state.lastError?.detail ?? null,
  })
  return { ...state, expiryAlerted: [...state.expiryAlerted, threshold] }
}
