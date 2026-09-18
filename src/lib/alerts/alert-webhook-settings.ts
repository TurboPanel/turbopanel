/**
 * The operator's alert webhook: one instance-wide URL the control plane POSTs
 * to when it has something an operator needs to know tonight.
 *
 * Instance-wide, not per-organization, on purpose. The things this delivers
 * are control-plane observations — a daemon stopped answering, a whole sweep
 * lost its fleet — and the audience is whoever runs this instance, not the
 * tenant whose server it happens to be. A tenant-facing notification channel
 * is a different feature with a different audience.
 *
 * Two properties this module is responsible for:
 *
 * - **The URL is a credential.** A Slack or Teams incoming-webhook URL is a
 *   bearer token with the path as the secret; anyone holding it can post as
 *   the integration. It is stored sealed (`tpsecret` envelope, the same
 *   treatment `email-settings.ts` gives an SMTP password) and never returned
 *   to a client in full — {@link describeAlertWebhook} is what a settings
 *   panel renders.
 * - **The URL is an SSRF vector.** It is typed in by an admin and then
 *   fetched server-side, so it goes through the same
 *   {@link validateOutboundUrl} gate as a forge base URL: https only, no
 *   credentials in the URL, no reserved names, and an IP literal has to be
 *   publicly routable — except on a self-hosted instance, where the operator
 *   may point it at a receiver on their own LAN (`allowPrivateTargets`,
 *   decided 2026-09-18: a hosted instance cannot reach a private address at
 *   all, so the question only ever applied to self-hosted, and an
 *   Alertmanager next to the control plane is the common shape there).
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { setting } from '../db/schema.ts'
import {
  decryptSecret,
  encryptSecret,
  isSealedEnvelope,
} from '../../client/authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../client/authn/secrets.ts'
import {
  type OutboundUrlRejection,
  resolveOutboundHostScope,
  validateOutboundUrl,
} from '../http/outbound-url.ts'

export type AlertWebhookPolicy = {
  /** Self-hosted: the webhook may target a private address or a LAN name. */
  allowPrivateTargets: boolean
}

/** Hosted (Workers) instances: public targets only — the only kind reachable from there. */
export const HOSTED_ALERT_WEBHOOK_POLICY: AlertWebhookPolicy = { allowPrivateTargets: false }
/** Self-hosted (Deno) instances: the operator's LAN is a legitimate destination. */
export const SELF_HOSTED_ALERT_WEBHOOK_POLICY: AlertWebhookPolicy = { allowPrivateTargets: true }

export const ALERT_WEBHOOK_URL_KEY = 'ALERT_WEBHOOK_URL'

export class AlertWebhookUrlError extends Error {
  readonly reason: OutboundUrlRejection
  constructor(reason: OutboundUrlRejection) {
    super(`alert webhook URL rejected: ${reason}`)
    this.name = 'AlertWebhookUrlError'
    this.reason = reason
  }
}

/**
 * Write-time validation. Pure, and then — where a resolver exists — the DNS
 * half, so a name that points at the loopback is refused before it is stored
 * rather than at the first alert.
 */
export async function assertAlertWebhookUrlAllowed(
  raw: string,
  policy: AlertWebhookPolicy = HOSTED_ALERT_WEBHOOK_POLICY,
): Promise<string> {
  const url = raw.trim()
  const gate = { allowPrivate: policy.allowPrivateTargets }
  const reason = validateOutboundUrl(url, gate)
  if (reason) throw new AlertWebhookUrlError(reason)
  const resolved = await resolveOutboundHostScope(url, gate)
  if (resolved) throw new AlertWebhookUrlError(resolved)
  return url
}

/**
 * What a settings panel shows: the origin and whether one is configured,
 * never the path. The path is the secret in every webhook scheme worth
 * naming, so returning the whole URL to a client would make every admin who
 * can open the page a holder of the credential.
 */
export function describeAlertWebhook(
  url: string | null,
): { configured: boolean; origin: string | null } {
  if (!url) return { configured: false, origin: null }
  try {
    return { configured: true, origin: new URL(url).origin }
  } catch {
    return { configured: true, origin: null }
  }
}

/**
 * Read the configured webhook, or `null` when none is set.
 *
 * Never throws: a stored value this build cannot unseal (a rotated data key,
 * a row written by a different instance) means no alerts, not a failed sweep.
 */
export async function getAlertWebhookUrl(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
): Promise<string | null> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, ALERT_WEBHOOK_URL_KEY))
    .limit(1)
  const stored = rows[0]?.value
  if (typeof stored !== 'string' || stored.length === 0) return null
  if (!isSealedEnvelope(stored)) return stored
  if (!dataEncryptionSecrets) return null
  try {
    return await decryptSecret(dataEncryptionSecrets, stored)
  } catch {
    return null
  }
}

/** Store the webhook, or clear it with `null`. */
export async function setAlertWebhookUrl(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
  url: string | null,
  policy: AlertWebhookPolicy = HOSTED_ALERT_WEBHOOK_POLICY,
): Promise<void> {
  if (url === null) {
    await db.delete(setting).where(eq(setting.key, ALERT_WEBHOOK_URL_KEY))
    return
  }
  const allowed = await assertAlertWebhookUrlAllowed(url, policy)
  if (!dataEncryptionSecrets) {
    throw new Error(
      'data encryption secrets required to store the alert webhook URL',
    )
  }
  const value = await encryptSecret(dataEncryptionSecrets, allowed)
  await db
    .insert(setting)
    .values({ key: ALERT_WEBHOOK_URL_KEY, value })
    .onConflictDoUpdate({
      target: setting.key,
      set: { value },
    })
}
