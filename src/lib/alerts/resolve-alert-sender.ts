/**
 * Turn the instance's stored webhook setting into a sender, for whichever
 * sweep is asking.
 *
 * Both runtimes' sweeps call this — the Workers cron (`offline-sweep.ts`) and
 * the self-hosted Deno/Redis timer (`control-plane-monitor.ts` via
 * `deno-server.ts`). Alerting that exists on only one of them is alerting
 * most instances do not have.
 *
 * Read per tick rather than cached, so an operator who configures a webhook
 * mid-incident gets the next sweep's alerts without a redeploy — the rule
 * every `setting`-backed value in this codebase follows. Nothing here throws:
 * a sweep's job is to demote stale servers, and it runs whether or not anyone
 * can be told about it.
 */
import { type Db, runWithDbTimeout } from '../../db.ts'
import type { DerivedSecretsConfig } from '../../client/authn/secrets.ts'
import { type AlertSender, createWebhookAlertSender, NOOP_ALERT_SENDER } from './alert-sender.ts'
import {
  type AlertWebhookPolicy,
  getAlertWebhookUrl,
  HOSTED_ALERT_WEBHOOK_POLICY,
} from './alert-webhook-settings.ts'
import { validateOutboundUrl } from '../http/outbound-url.ts'

export type AlertSenderTrace = (
  event: 'alert-webhook-refused' | 'alert-sender-resolve-failed',
  detail: Record<string, unknown>,
) => void

export async function resolveAlertSender(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
  trace?: AlertSenderTrace,
  policy: AlertWebhookPolicy = HOSTED_ALERT_WEBHOOK_POLICY,
): Promise<AlertSender> {
  try {
    // Bounded: this read sits on a sweep's critical path, and a slow — not
    // dead — Postgres must not hold a tick open over a settings lookup.
    const url = await runWithDbTimeout(
      db,
      (settingDb) => getAlertWebhookUrl(settingDb, dataEncryptionSecrets),
    )
    if (!url) return NOOP_ALERT_SENDER
    // Re-validated here, not only at write time: this is the choke point
    // where the URL becomes an outbound fetch, and the stored value may
    // predate the gate (an unsealed legacy row) or have been written by
    // something other than the settings route. Same two-layer shape
    // `git/forge-url.ts` uses.
    const rejection = validateOutboundUrl(url, {
      allowPrivate: policy.allowPrivateTargets,
    })
    if (rejection) {
      trace?.('alert-webhook-refused', { reason: rejection })
      return NOOP_ALERT_SENDER
    }
    return createWebhookAlertSender(url)
  } catch (err) {
    trace?.('alert-sender-resolve-failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return NOOP_ALERT_SENDER
  }
}
