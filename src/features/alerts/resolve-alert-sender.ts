/**
 * Turn "the sweep noticed something" into notifications.
 *
 * Both runtimes' sweeps call this — the Workers cron (`offline-sweep.ts`) and
 * the self-hosted Deno/Redis timer (`control-plane-monitor.ts` via
 * `platform/deno/server.ts`). Alerting that exists on only one of them is alerting
 * most instances do not have.
 *
 * Since 2026-09-18 an alert is an event in the notifications pipeline
 * (`src/features/notifications/`): it lands in the inbox of everyone in the
 * server's organization (or every instance admin, for the fleet-wide
 * aggregate) and reaches every channel a rule routes it to — including the
 * operator's instance-wide webhook, which the legacy setting is folded into
 * here on first touch so an upgraded instance keeps alerting. Nothing here
 * throws: a sweep's job is to demote stale servers, and it runs whether or
 * not anyone can be told about it.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { type Db, runWithDbTimeout } from '../../db/connection.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { managed, replica, server } from '../../db/schema.ts'
import type { Alert, AlertSender } from './alert-sender.ts'
import {
  adoptLegacyAlertWebhook,
  type AlertWebhookPolicy,
  ALERT_WEBHOOK_POLICY,
} from './alert-webhook-settings.ts'
import { type EmitEmail, emitNotification } from '../notifications/emit.ts'
import type { NotificationContext, NotificationEvent } from '../notifications/events.ts'

export type AlertSenderTrace = (
  event: 'alert-sender-resolve-failed' | 'alert-server-unknown',
  detail: Record<string, unknown>
) => void

type MappedEvent = {
  event: NotificationEvent
  organizationId: string | null
  context: NotificationContext
  targetId: string | null
}

/** At most this many database names go into one alert. */
const ALERT_DATABASE_NAMES_MAX = 5

/**
 * Names of the high availability databases whose PRIMARY lives on this server
 * (a primary with at least one other member), so the offline alert can say what
 * is at stake and what happens next. Best effort: a failed lookup only means
 * the alert goes out without the sentence.
 */
export async function haPrimaryNamesOnServer(db: Db, serverId: string): Promise<string | null> {
  try {
    const primaries = await runWithDbTimeout(db, (tx) =>
      tx
        .select({ managedId: replica.managedId, name: managed.name })
        .from(replica)
        .innerJoin(managed, eq(managed.id, replica.managedId))
        .where(and(eq(replica.serverId, serverId), eq(replica.role, 'primary')))
        .limit(50)
    )
    if (primaries.length === 0) return null
    const ids = primaries.map((row) => row.managedId)
    const members = await runWithDbTimeout(db, (tx) =>
      tx
        .select({ managedId: replica.managedId })
        .from(replica)
        .where(inArray(replica.managedId, ids))
    )
    const counts = new Map<string, number>()
    for (const row of members) counts.set(row.managedId, (counts.get(row.managedId) ?? 0) + 1)
    const names = primaries
      .filter((row) => (counts.get(row.managedId) ?? 0) > 1)
      .map((row) => row.name ?? row.managedId.slice(0, 8))
    if (names.length === 0) return null
    const shown = names.slice(0, ALERT_DATABASE_NAMES_MAX).join(', ')
    return names.length > ALERT_DATABASE_NAMES_MAX
      ? `${shown} and ${names.length - ALERT_DATABASE_NAMES_MAX} more`
      : shown
  } catch {
    return null
  }
}

/** An alert's kind is an event code; its detail is the event's context, plus what the server row adds. */
async function toEvent(
  db: Db,
  alert: Alert,
  trace: AlertSenderTrace | undefined
): Promise<MappedEvent | null> {
  const context: NotificationContext = {}
  for (const [key, value] of Object.entries(alert.detail ?? {})) {
    if (value !== undefined) context[key] = value
  }
  if (alert.kind === 'fleet.mass_disconnect') {
    if (typeof context.staleCount === 'number') {
      context.count = context.staleCount
    }
    return {
      event: 'fleet.mass_disconnect',
      organizationId: null,
      context,
      targetId: null,
    }
  }
  const serverId = typeof context.serverId === 'string' ? context.serverId : null
  if (!serverId) return null
  const rows = await runWithDbTimeout(db, (tx) =>
    tx
      .select({
        organizationId: server.organizationId,
        name: server.name,
        hostname: server.hostname,
      })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
  )
  const row = rows[0]
  if (!row?.organizationId) {
    trace?.('alert-server-unknown', { serverId })
    return null
  }
  context.serverName = row.name ?? row.hostname ?? serverId
  const databases = await haPrimaryNamesOnServer(db, serverId)
  if (databases) context.databases = databases
  return {
    event: 'server.offline',
    organizationId: row.organizationId,
    context,
    targetId: serverId,
  }
}

export async function resolveAlertSender(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig | undefined,
  trace?: AlertSenderTrace,
  policy: AlertWebhookPolicy = ALERT_WEBHOOK_POLICY,
  email?: EmitEmail | (() => Promise<EmitEmail | undefined>),
  opts: { adoptLegacy?: boolean } = {}
): Promise<AlertSender> {
  // An instance upgraded past the ALERT_WEBHOOK_URL setting keeps its
  // webhook: the setting becomes an instance channel on first touch, and the
  // pipeline below reaches it like any other. Bounded, and never the reason
  // a sweep fails.
  try {
    if (opts.adoptLegacy !== false) {
      await runWithDbTimeout(db, (tx) => adoptLegacyAlertWebhook(tx, dataEncryptionSecrets))
    }
  } catch (err) {
    trace?.('alert-sender-resolve-failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return async (alert) => {
    try {
      const mapped = await toEvent(db, alert, trace)
      if (!mapped) return
      const resolvedEmail = typeof email === 'function' ? await email() : email
      await emitNotification(
        db,
        dataEncryptionSecrets,
        {
          event: mapped.event,
          organizationId: mapped.organizationId,
          context: mapped.context,
          targetType: mapped.targetId ? 'server' : null,
          targetId: mapped.targetId,
        },
        { allowPrivateTargets: policy.allowPrivateTargets, email: resolvedEmail }
      )
    } catch (err) {
      // emitNotification never throws; this guards the lookup above.
      trace?.('alert-sender-resolve-failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
