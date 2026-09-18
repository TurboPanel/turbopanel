/**
 * The seam between "the control plane noticed something" and "an operator
 * found out".
 *
 * Everything that wants to alert takes an {@link AlertSender} and calls it.
 * Nothing that wants to alert knows what a webhook is, whether one is
 * configured, or that Slack exists. That matters for one reason above all:
 * **an alert must never be able to fail the thing it is reporting on.** The
 * offline sweep's job is to demote stale servers; if a webhook POST could
 * throw into that loop, an unreachable Slack would stop the fleet from being
 * marked offline — the failure mode alerting exists to prevent.
 *
 * So {@link createWebhookAlertSender} never rejects, bounds its own time, and
 * logs what it could not deliver. The only thing a caller may assume is that
 * awaiting it terminates.
 */
import { compatLogWarn } from '../../log-compat.ts'

export type AlertKind = 'server.offline' | 'fleet.mass_disconnect'

export type Alert = {
  kind: AlertKind
  /** One line, already written for a human — this is what lands in the channel. */
  text: string
  /** Small, non-secret facts; rendered as `key=value` after the text. */
  detail?: Record<string, string | number | null | undefined>
}

export type AlertSender = (alert: Alert) => Promise<void>

/** The default everywhere no webhook is configured. */
export const NOOP_ALERT_SENDER: AlertSender = () => Promise.resolve()

/** How long one delivery attempt may take before it is abandoned. */
export const ALERT_DELIVERY_TIMEOUT_MS = 5_000

/**
 * Render an alert as the body every common incoming-webhook accepts.
 *
 * `text` is the field Slack, Mattermost, Rocket.Chat and Discord (with
 * `?wait=`-less POSTs) all read, so one shape reaches all of them without a
 * per-provider adapter. The structured fields ride alongside for anything
 * that parses JSON.
 */
export function alertPayload(alert: Alert): Record<string, unknown> {
  const detail = alert.detail ?? {}
  const parts = Object.keys(detail)
    .sort((a, b) => a.localeCompare(b))
    .filter((key) => detail[key] !== undefined && detail[key] !== null)
    .map((key) => `${key}=${detail[key]}`)
  return {
    text: parts.length > 0 ? `${alert.text} (${parts.join(' ')})` : alert.text,
    kind: alert.kind,
    detail,
  }
}

/**
 * POST every alert to one webhook URL. Never rejects and never throws — a
 * delivery failure is logged and dropped.
 */
export function createWebhookAlertSender(
  url: string,
  fetchImpl: typeof fetch = fetch,
): AlertSender {
  return async (alert) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ALERT_DELIVERY_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alertPayload(alert)),
        signal: controller.signal,
      })
      if (!response.ok) {
        // The URL is a credential, so it is never logged — only its origin.
        compatLogWarn(
          'alerts',
          `webhook rejected ${alert.kind}: HTTP ${response.status} from ${originOf(url)}`,
        )
      }
      // Drain the body so the connection can be reused rather than hang.
      await response.text().catch(() => undefined)
    } catch (error) {
      compatLogWarn(
        'alerts',
        `webhook delivery failed for ${alert.kind} to ${originOf(url)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return '<unparsable webhook URL>'
  }
}
