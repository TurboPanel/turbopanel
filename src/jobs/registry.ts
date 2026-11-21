/**
 * The job table shared by both runtimes: one entry per scheduled job with its
 * kind, default cadence, offset and the range an operator may move it within.
 *
 * Operators override cadences with one JSON map, for example
 * `{"executionLogs": 60, "tierNotices": 1440}`:
 * - Workers: the `TURBOPANEL_JOB_CADENCES` var of the environment (no database
 *   read; vars are not inherited between wrangler environments).
 * - Self-hosted: the `jobs.cadences` setting row, with the same env var first
 *   (`features/settings/job-cadences.ts`).
 *
 * A bad map never throws: unreadable JSON, unknown names and out-of-range or
 * non-numeric values fall back to the default or clamp into the job's range,
 * and each problem comes back as one warning for the caller to log once.
 *
 * Pure: no Workers types, no database, so Deno tests and both runtimes import it.
 */

/** `latency` jobs gate how fast a problem is noticed; `housekeeping` jobs only bound growth or retry. */
export type JobKind = 'latency' | 'housekeeping'

/** How often a job runs and on which minute of its window. */
export type CronCadence = { readonly everyMinutes: number; readonly offset: number }

export type JobSpec = CronCadence & {
  readonly kind: JobKind
  /** Shortest interval an override may set. */
  readonly min: number
  /** Longest interval an override may set. */
  readonly max: number
}

/** One day: the longest housekeeping interval. */
export const HOUSEKEEPING_MAX_MINUTES = 1440

const housekeeping = (everyMinutes: number, offset: number, max = HOUSEKEEPING_MAX_MINUTES) =>
  ({ kind: 'housekeeping', everyMinutes, offset, min: 1, max }) as const satisfies JobSpec

/** Pinned to every minute: no override can slow it. */
const latency = () => ({ kind: 'latency', everyMinutes: 1, offset: 0, min: 1, max: 1 }) as const

/**
 * Every job, in one place. Offsets spread the jobs over their window (the
 * 15-minute prune family sits on offset 0). Each check goes through
 * {@link isDue}, which takes the resolved table as a parameter.
 *
 * Why each interval is safe:
 * - `offlineDetection`, `commandRedelivery`: latency floors. Servers are marked
 *   offline and stranded commands recovered on the minute; no setting slows them.
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
 * - `executionLogs`, `historyPrune`, `notificationPrune`, `tierNotices`:
 *   retention deletes and a notice; none has a reader that depends on the grain.
 * - `edgeTrust`, `heartbeatRefresh`, `ingressTick`: self-hosted only (Workers never
 *   reads them). Edge address ranges are fetched once a day inside the pass and
 *   only a changed body reaches the daemon; the advised heartbeat is re-read from
 *   the hostname rows; the ingress pass orders certificates for the panel's own
 *   names (the update is read within a minute by default, and an operator may
 *   slow it to an hour at most).
 * - `upgradeTick`: advances a managed upgrade run. `upgradeCheck`: how often an
 *   install looks for a new build (at most hourly: the schedule slots are within
 *   an hour, `features/upgrades/schedule.ts`); it is read by the upgrade code,
 *   not by {@link isDue}.
 */
export const CRON_CADENCES = {
  offlineDetection: latency(),
  commandRedelivery: latency(),
  commandDispatchCleanup: housekeeping(15, 3),
  webhookDeliveries: housekeeping(15, 6),
  daemonNonces: housekeeping(15, 9),
  pinSilence: housekeeping(5, 2),
  orphanFolderAlerts: housekeeping(5, 2),
  systemReconcile: housekeeping(5, 0),
  backupsReconcile: housekeeping(5, 1),
  folderRemoval: housekeeping(5, 2),
  folderReconcile: housekeeping(5, 3),
  firewallPreview: housekeeping(5, 4),
  managedIngressOrphan: housekeeping(5, 2),
  leafRenewal: housekeeping(5, 0),
  dnsCertificates: housekeeping(5, 1),
  httpCertificates: housekeeping(5, 2),
  executionLogs: housekeeping(15, 0),
  historyPrune: housekeeping(15, 0),
  notificationPrune: housekeeping(15, 0),
  tierNotices: housekeeping(60, 0),
  edgeTrust: housekeeping(5, 3),
  heartbeatRefresh: housekeeping(5, 1),
  ingressTick: housekeeping(1, 0, 60),
  upgradeTick: housekeeping(15, 0),
  upgradeCheck: housekeeping(60, 0, 60),
} as const satisfies Record<string, JobSpec>

export type CronJob = keyof typeof CRON_CADENCES
export type CronCadenceTable = Readonly<Record<CronJob, CronCadence>>

/** True on every `everyMinutes`th UTC minute, shifted by `offset` minutes. */
export function onDivisor(scheduledTimeMs: number, everyMinutes: number, offset = 0): boolean {
  const minute = Math.floor(scheduledTimeMs / 60_000)
  return minute % everyMinutes === offset % everyMinutes
}

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

export type ResolvedCadences = {
  /** Defaults with the valid overrides applied (clamped). */
  table: CronCadenceTable
  /** One line per problem found in the override map; empty when it was clean. */
  warnings: string[]
}

function isJob(name: string): name is CronJob {
  return Object.hasOwn(CRON_CADENCES, name)
}

function readMinutes(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && /^\s*\d{1,9}\s*$/.test(value)) return Number(value)
  return null
}

/**
 * Apply an override map to the defaults. `raw` is the JSON text from the env
 * var or setting row (blank means no overrides). Never throws.
 */
export function resolveJobCadences(raw: string | null | undefined): ResolvedCadences {
  const text = raw?.trim() ?? ''
  if (text === '') return { table: CRON_CADENCES, warnings: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { table: CRON_CADENCES, warnings: ['override map is not valid JSON; defaults used'] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      table: CRON_CADENCES,
      warnings: ['override map is not a JSON object; defaults used'],
    }
  }
  const table: Record<string, CronCadence> = { ...CRON_CADENCES }
  const warnings: string[] = []
  for (const [name, value] of Object.entries(parsed)) {
    if (!isJob(name)) {
      warnings.push(`unknown job ${JSON.stringify(name)} ignored`)
      continue
    }
    const spec = CRON_CADENCES[name]
    const minutes = readMinutes(value)
    if (minutes === null) {
      warnings.push(`${name}: not a number of minutes, default ${spec.everyMinutes} kept`)
      continue
    }
    const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(minutes)))
    if (clamped !== minutes) {
      warnings.push(
        `${name}: ${minutes} adjusted to ${clamped} (allowed ${spec.min} to ${spec.max})`
      )
    }
    table[name] = { everyMinutes: clamped, offset: spec.offset }
  }
  return { table: table as CronCadenceTable, warnings }
}

/** Minutes between runs of a job under a resolved table. */
export function jobEveryMinutes(job: CronJob, table: CronCadenceTable = CRON_CADENCES): number {
  return table[job].everyMinutes
}
