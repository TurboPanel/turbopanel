/**
 * Cadence and "is there any work?" gates for the every-minute cron tick.
 *
 * The tick has to stay cheap when nothing is going on: every statement it sends
 * through Hyperdrive counts against a daily quota. Two tools keep it cheap:
 *
 * - A divisor (`onDivisor`): work whose correctness does not depend on minute
 *   latency (retention deletes, alarms measured in tens of minutes, catch-up
 *   passes) runs on a UTC-minute modulo with a per-job offset, so the jobs do
 *   not all land on the same minute. No stored state, so any isolate agrees.
 * - One gate query (`loadCronGates`) that answers, for every gated family at
 *   once, "can there be a candidate?". Each flag is a superset of the first
 *   read the family's sweeps make, so a false flag means the sweeps would
 *   have found nothing. A gate that cannot be read opens every flag, so a
 *   failing gate costs nothing but the old behaviour.
 *
 * Pure of Workers types: the Deno tests import this file.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  badge,
  changeover,
  command,
  datacenter,
  hosting,
  ip,
  leaf,
  managed,
  notificationDelivery,
  notificationEvent,
  portal,
  principal,
  recovery,
  server,
  tls,
  tunnel,
} from '../../db/schema.ts'
import { systemReconcileRepairableExists } from '../../features/system/reconcile.ts'

/** True on every `everyMinutes`th UTC minute, shifted by `offset` minutes. */
export function onDivisor(scheduledTimeMs: number, everyMinutes: number, offset = 0): boolean {
  const minute = Math.floor(scheduledTimeMs / 60_000)
  return minute % everyMinutes === offset % everyMinutes
}

/** How often a job runs and on which minute of its window. */
export type CronCadence = { readonly everyMinutes: number; readonly offset: number }

/**
 * Every cadence of the tick, in one place: a job name, its default interval in
 * minutes and its offset. Offsets spread the jobs over their window (the
 * 15-minute prune family sits on offset 0, see `shouldSweepUpgradeHistory`).
 * Each check goes through {@link isDue}, which takes the table as a parameter
 * so overrides can be merged into it per environment.
 *
 * Why each interval is safe:
 * - `commandDispatchCleanup`, `webhookDeliveries`, `daemonNonces`: deletes of
 *   rows that are already expired and ignored by every reader; they only bound
 *   table size, and each pass is limit-capped.
 * - `pinSilence`: its alarms fire after 30 minutes and 6 hours of silence, and
 *   the reconnect clean-up it does only clears markers; a 5 minute grain moves
 *   an alarm by at most 5 minutes.
 * - `orphanFolderAlerts`: tells people about a folder that became an orphan,
 *   once; a 5 minute delay on a notification. Same minute as `pinSilence` on
 *   purpose: both need the mail setup, resolved once for the tick.
 * - The reconcile-family jobs are repair or retry passes (each with its own
 *   throttle of five minutes or more, or working on expiry-scale dates) and run
 *   only while their gate has a candidate. One minute apart so they do not pile up.
 */
export const CRON_CADENCES = {
  commandDispatchCleanup: { everyMinutes: 15, offset: 3 },
  webhookDeliveries: { everyMinutes: 15, offset: 6 },
  daemonNonces: { everyMinutes: 15, offset: 9 },
  pinSilence: { everyMinutes: 5, offset: 2 },
  orphanFolderAlerts: { everyMinutes: 5, offset: 2 },
  systemReconcile: { everyMinutes: 5, offset: 0 },
  backupsReconcile: { everyMinutes: 5, offset: 1 },
  folderRemoval: { everyMinutes: 5, offset: 2 },
  folderReconcile: { everyMinutes: 5, offset: 3 },
  firewallPreview: { everyMinutes: 5, offset: 4 },
  managedIngressOrphan: { everyMinutes: 5, offset: 2 },
  leafRenewal: { everyMinutes: 5, offset: 0 },
  dnsCertificates: { everyMinutes: 5, offset: 1 },
  httpCertificates: { everyMinutes: 5, offset: 2 },
} as const satisfies Record<string, CronCadence>

export type CronJob = keyof typeof CRON_CADENCES
export type CronCadenceTable = Readonly<Record<CronJob, CronCadence>>

/**
 * Whether a job is due on this tick. A tick with no scheduled time (a manual
 * call) runs everything, the way it did before the cadences existed.
 */
export function isDue(
  job: CronJob,
  scheduledTimeMs: number | undefined,
  table: CronCadenceTable = CRON_CADENCES
): boolean {
  if (scheduledTimeMs === undefined) return true
  const { everyMinutes, offset } = table[job]
  return onDivisor(scheduledTimeMs, everyMinutes, offset)
}

export type CronGates = {
  /** An open command, an unfinished recovery or a managed row `applying`. */
  commandRecoveryWork: boolean
  /** A pending, failed or held delivery, or an event not yet fanned out. */
  notificationWork: boolean
  /** A connected server: the reconnect-repair sweeps start from one. */
  connectedServer: boolean
  /**
   * A connected server that reconnected in the last few minutes, or runs a
   * system ingress or panel container that is not running. System reconcile and
   * the managed-ingress orphan pass run every minute while this is true (each
   * keeps its own 5 minute throttle on its last command) and otherwise only on
   * their routine 5 minute slot.
   */
  reconcileUrgent: boolean
  /** A site waiting on DNS for a Let's Encrypt order. */
  hostingPending: boolean
  /** A membership repin waiting for its fan-out. */
  repinPending: boolean
  /** A principal whose removal was requested. */
  principalRemoval: boolean
  /** A certificate, leaf or changeover row: what leaf renewal and record clean-up read. */
  certificates: boolean
  /** An automatic Let's Encrypt certificate row. */
  httpCertificates: boolean
  /** One of them with a first order to start, a retry due, an order open, a pair to deliver or ends to send. */
  httpCertificatesActive: boolean
  /** A tunnel, portal or badge, or a server still carrying tunnel routes or connectors. */
  tunnels: boolean
  /** Two or more trusted networks: the only case the probe has work. */
  networkProbe: boolean
}

export const ALL_GATES_OPEN: CronGates = {
  commandRecoveryWork: true,
  notificationWork: true,
  connectedServer: true,
  reconcileUrgent: true,
  hostingPending: true,
  repinPending: true,
  principalRemoval: true,
  certificates: true,
  httpCertificates: true,
  httpCertificatesActive: true,
  tunnels: true,
  networkProbe: true,
}

const GATE_KEYS = Object.keys(ALL_GATES_OPEN) as (keyof CronGates)[]

/** One statement: every gate of the tick. Column names are the `CronGates` keys. */
export async function loadCronGates(
  db: Db,
  options: { now?: Date; onError?: (err: unknown) => void } = {}
): Promise<CronGates> {
  const at = (options.now ?? new Date()).toISOString()
  // Longer than the 5 minute window the reconcile sweep itself uses for a reconnect,
  // so a late tick still sees the reconnect while the sweep can act on it.
  const reconnectedSince = new Date(
    (options.now ?? new Date()).getTime() - 6 * 60_000
  ).toISOString()
  try {
    const rows = (await db.execute(sql`
      select
        (exists (select 1 from ${command} where ${command.status} in ('queued', 'dispatching', 'sent', 'acked', 'running'))
          or exists (select 1 from ${recovery} where ${recovery.state} not in ('completed', 'failed', 'blocked'))
          or exists (select 1 from ${recovery} where ${recovery.state} = 'blocked'
            and coalesce(${recovery.metadata} -> 'abortRestartTodo', '[]'::jsonb) <> '[]'::jsonb)
          or exists (select 1 from ${managed} where ${managed.status} = 'applying')) as "commandRecoveryWork",
        (exists (select 1 from ${notificationDelivery} where ${notificationDelivery.status} in ('pending', 'failed', 'held'))
          or exists (select 1 from ${notificationEvent} where ${notificationEvent.fannedOutAt} is null)) as "notificationWork",
        (exists (select 1 from ${tls}) or exists (select 1 from ${leaf}) or exists (select 1 from ${changeover})) as "certificates",
        exists (select 1 from ${server} where ${server.isConnected}) as "connectedServer",
        exists (select 1 from ${server} srv where srv.is_connected
          and (srv.status_changed_at >= ${reconnectedSince}::timestamptz
            or ${systemReconcileRepairableExists(sql`srv.id`, sql`srv.organization_id`)})) as "reconcileUrgent",
        exists (select 1 from ${hosting} where ${hosting.pendingAt} is not null) as "hostingPending",
        exists (select 1 from ${ip} where ${ip.repinPendingFanoutAt} is not null) as "repinPending",
        exists (select 1 from ${principal} where ${principal.removalRequestedAt} is not null) as "principalRemoval",
        exists (select 1 from ${tls} where ${tls.source} = 'lets_encrypt' and ${tls.status} = 'automatic') as "httpCertificates",
        exists (select 1 from ${tls} where ${tls.source} = 'lets_encrypt' and ${tls.status} = 'automatic'
          and (
            -- A first order waiting to start (the sweep is the only thing that starts it).
            (${tls.metadata} -> 'httpCert' is null and ${tls.privateKeyPem} is null)
            -- A failed order whose retry time has come.
            or (${tls.metadata} -> 'httpCert' ->> 'phase' = 'failed'
              and (${tls.metadata} -> 'httpCert' ->> 'nextAttemptAt' is null
                or ${tls.metadata} -> 'httpCert' ->> 'nextAttemptAt' <= ${at}))
            or (${tls.metadata} -> 'httpCert' is not null and (${tls.metadata} -> 'httpCert' ->> 'endedAt' is null
            or (${tls.metadata} -> 'httpCert' ->> 'phase' = 'issued' and ${tls.metadata} -> 'httpCert' ->> 'deliveredAt' is null)
            or (${tls.metadata} -> 'httpCert' ->> 'endsSentAt' is null
              and jsonb_array_length(coalesce(${tls.metadata} -> 'httpCert' -> 'forwards', '[]'::jsonb)) > 0))))) as "httpCertificatesActive",
        (exists (select 1 from ${tunnel})
          or exists (select 1 from ${portal})
          or exists (select 1 from ${badge})
          or exists (select 1 from ${server} where ${server.metadata} -> 'tunnelRoutes' is not null or ${server.metadata} -> 'tunnelConnectors' is not null)) as "tunnels",
        (select count(*) from ${datacenter} where ${datacenter.isTrusted}) >= 2 as "networkProbe"
    `)) as unknown as Record<string, unknown>[]
    const row = rows[0]
    if (!row) return ALL_GATES_OPEN
    const gates = { ...ALL_GATES_OPEN }
    for (const key of GATE_KEYS) {
      // Anything but an explicit false keeps the gate open.
      gates[key] = row[key] !== false
    }
    return gates
  } catch (err) {
    options.onError?.(err)
    return ALL_GATES_OPEN
  }
}
