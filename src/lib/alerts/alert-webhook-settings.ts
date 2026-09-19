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
 * Since 2026-09-18 the webhook *is* a notification channel (instance scope,
 * `webhook`, labelled "Operator alert webhook", rule `*`): the legacy
 * `ALERT_WEBHOOK_URL` setting is adopted into one on first touch, and the
 * admin route below is a thin face over that channel. `getAlertWebhookUrl`
 * and `setAlertWebhookUrl` read and write the legacy row only and exist for
 * the adoption and its tests.
 *
 * - **The URL is an SSRF vector, within limits.** It is typed in by an admin
 *   and then fetched server-side, so it goes through the same
 *   {@link validateOutboundUrl} gate as a forge base URL for scheme and
 *   credentials: https only, nothing in the userinfo. The *address* rule is
 *   deliberately not applied (decided 2026-09-18, "allow everywhere, no
 *   exceptions"): a notification target carries no credential of ours and
 *   its response is never returned to anyone, so the only thing a private
 *   address buys an attacker is a blind POST at something on the LAN — and
 *   the common self-hosted shape is exactly an Alertmanager on the LAN. A
 *   forge URL keeps the full rule; it is fetched with the App's credentials
 *   attached.
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
import {
  createNotificationChannel,
  deleteChannel,
  getOperatorWebhookChannel,
  type NotificationChannelRecord,
  OPERATOR_WEBHOOK_LABEL,
  replaceRulesForChannel,
  resolveChannelAddress,
  updateChannelAddress,
} from '../notifications/records.ts'

export type AlertWebhookPolicy = {
  /** The webhook may target a private address or a LAN name. */
  allowPrivateTargets: boolean
}

/**
 * The one policy, on every runtime (decided 2026-09-18). It used to follow
 * the runtime — hosted refused private targets, self-hosted allowed them —
 * and the user collapsed it: a hosted instance cannot reach a private
 * address anyway, so the refusal there bought nothing but a second rule to
 * explain. Kept as a named value so the tests can still exercise the strict
 * gate through the option.
 */
export const ALERT_WEBHOOK_POLICY: AlertWebhookPolicy = { allowPrivateTargets: true }

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
  policy: AlertWebhookPolicy = ALERT_WEBHOOK_POLICY,
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
 * Fold the legacy `ALERT_WEBHOOK_URL` setting into the notifications model:
 * one instance-scoped webhook channel labelled {@link OPERATOR_WEBHOOK_LABEL}
 * with a `*` rule at `info` — every event, the firehose the setting always
 * was. Idempotent and cheap: once the row is gone this is one indexed read.
 * Called from the admin route and from the sweep's resolver, so an instance
 * upgraded past the setting keeps alerting with nothing re-typed.
 *
 * Returns the channel the setting became (or already was), or null when
 * neither exists.
 */
export async function adoptLegacyAlertWebhook(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
): Promise<NotificationChannelRecord | null> {
  const existing = await getOperatorWebhookChannel(db)
  const legacy = await getAlertWebhookUrl(db, dataEncryptionSecrets)
  if (!legacy) return existing
  if (existing) {
    // Both exist: the channel is the truth; the setting is a leftover.
    await db.delete(setting).where(eq(setting.key, ALERT_WEBHOOK_URL_KEY))
    return existing
  }
  if (!dataEncryptionSecrets) return null
  const channel = await createNotificationChannel(db, dataEncryptionSecrets, {
    scope: 'instance',
    kind: 'webhook',
    label: OPERATOR_WEBHOOK_LABEL,
    address: legacy,
  })
  await replaceRulesForChannel(db, channel.id, [{ event: '*', minSeverity: 'info' }])
  await db.delete(setting).where(eq(setting.key, ALERT_WEBHOOK_URL_KEY))
  return channel
}

/** The operator webhook's plain URL — the channel first, the legacy setting adopted on the way. */
export async function resolveOperatorWebhookUrl(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
): Promise<string | null> {
  const channel = await adoptLegacyAlertWebhook(db, dataEncryptionSecrets)
  if (!channel) return null
  return await resolveChannelAddress(dataEncryptionSecrets, channel)
}

/**
 * Set or clear the operator webhook through the channel it now is. Kept as
 * the body of `PUT /api/admin/v1/settings/alert-webhook` so the documented
 * curl keeps working; the same channel is editable at
 * `/api/admin/v1/notification-channels` like any other.
 */
export async function setOperatorWebhookUrl(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
  url: string | null,
  policy: AlertWebhookPolicy = ALERT_WEBHOOK_POLICY,
): Promise<void> {
  const existing = await adoptLegacyAlertWebhook(db, dataEncryptionSecrets)
  if (url === null) {
    if (existing) await deleteChannel(db, existing.id)
    return
  }
  const allowed = await assertAlertWebhookUrlAllowed(url, policy)
  if (!dataEncryptionSecrets) {
    throw new Error(
      'data encryption secrets required to store the alert webhook URL',
    )
  }
  if (existing) {
    await updateChannelAddress(db, dataEncryptionSecrets, existing.id, 'webhook', allowed)
    return
  }
  const channel = await createNotificationChannel(db, dataEncryptionSecrets, {
    scope: 'instance',
    kind: 'webhook',
    label: OPERATOR_WEBHOOK_LABEL,
    address: allowed,
  })
  await replaceRulesForChannel(db, channel.id, [{ event: '*', minSeverity: 'info' }])
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
  policy: AlertWebhookPolicy = ALERT_WEBHOOK_POLICY,
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
