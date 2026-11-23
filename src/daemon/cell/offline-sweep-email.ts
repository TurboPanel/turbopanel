/**
 * The mail the hosted offline sweep sends: the platform mail queue and from
 * address a tick hands the notifications pipeline, and the tier-notice phase
 * (see offline-sweep.ts).
 */
import type { Db } from '../../db/connection.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { createWorkersQueuedEmailQueue } from '../../features/email/workers-mail-queue.ts'
import type { EmailQueue } from '../../features/email/types.ts'
import { platformControlPlaneOrigin } from '../../features/install/control-plane-origins.ts'
import type { EmitEmail } from '../../features/notifications/emit.ts'
import { resolveEmailSettings } from '../../features/settings/email-settings.ts'
import { sweepTierNotices } from '../../features/tiers/tier-notice-sweep.ts'
import { cachedForEnv } from './notification-email-cache.ts'

type EmailTlsRenewal = { dataEncryptionSecrets: DerivedSecretsConfig }

/** The mail queue and from address a Workers tick hands the notifications pipeline. */
export function workersNotificationEmail(
  env: CloudflareBindings,
  db: Db,
  tlsRenewal: EmailTlsRenewal | null | undefined
): Promise<EmitEmail | undefined> {
  return cachedForEnv(env, () => resolveWorkersNotificationEmail(env, db, tlsRenewal))
}

/**
 * The mail queue a sweep enqueues to: the platform mail queue, so a sweep's
 * notice gets the same retry and dead-letter path as a request's mail. The
 * Worker refuses to start without the binding, so it is there; if a test or a
 * caller reaches this without it, fail instead of sending directly.
 */
function resolveSweepEmailQueue(env: CloudflareBindings): EmailQueue {
  if (!env.TURBOPANEL_EMAIL_QUEUE) {
    throw new Error('TURBOPANEL_EMAIL_QUEUE is not bound')
  }
  return createWorkersQueuedEmailQueue(env.TURBOPANEL_EMAIL_QUEUE)
}

async function resolveWorkersNotificationEmail(
  env: CloudflareBindings,
  db: Db,
  tlsRenewal: EmailTlsRenewal | null | undefined
): Promise<EmitEmail | undefined> {
  const platformEnv = env as unknown as Record<string, string | undefined>
  try {
    const queue = resolveSweepEmailQueue(env)
    const settings = await resolveEmailSettings(
      db,
      platformEnv,
      tlsRenewal?.dataEncryptionSecrets,
      'workers'
    )
    return {
      queue,
      from: settings.from,
      consoleBaseUrl: platformControlPlaneOrigin(platformEnv),
    }
  } catch {
    return undefined
  }
}

export async function sweepTierNoticesPhase(
  env: CloudflareBindings,
  db: Db,
  opts: { nowMs?: number }
): Promise<void> {
  const platformEnv = env as unknown as Record<string, string | undefined>
  const emailQueue = resolveSweepEmailQueue(env)
  await sweepTierNotices({
    db,
    emailQueue,
    deployment: 'hosted',
    ignoreElapsedGate: true,
    nowMs: opts.nowMs,
    consoleBaseUrl: platformControlPlaneOrigin(platformEnv) ?? undefined,
  })
}
