/**
 * The one list of scheduled jobs, read by both runtimes.
 *
 * A row names the job, the cadence key it rides (`registry.ts`), the runtimes
 * that run it and the rule that decides whether it runs on a tick. The rule
 * ({@link JobDef.due}) is shared: the Deno tick (`platform/deno/server.ts`)
 * builds its list from these rows, and the Workers cron
 * (`daemon/cell/offline-sweep.ts`) asks {@link jobDue} before each phase, so a
 * gate cannot be added to one runtime only. Each runtime keeps only its
 * adapter: the handler that does the work with that runtime's connections.
 *
 * Rows are in the order the self-hosted tick runs them. The Workers cron keeps
 * its own phase order (it runs under a time budget and groups phases), but
 * every job it runs is one of these rows.
 *
 * A row on one runtime only carries `oneSided`, the written reason. The test
 * `table.hostfree.test.ts` fails when a row is missing from a runtime it names
 * or present on one it does not, and when a one-sided row has no reason.
 *
 * Pure: types only from the gates module, no Workers types, no database.
 */
import type { CronGates } from '../daemon/cell/cron-gates.ts'
import { DAEMON_OFFLINE_SWEEP_MS } from '../contracts/cell-protocol.ts'
import type { CronJob } from './registry.ts'

export type JobRuntime = 'workers' | 'deno'

/** What a runtime tells the shared rule about the tick in progress. */
export type JobDueInput = {
  /** The tick's idle-check flags (every flag open when the read failed). */
  gates: CronGates
  /** Whether a cadence job has a slot in this tick. */
  cadenceDue: (job: CronJob) => boolean
  /** A command queue that can deliver; false for the no-op queue or no binding. */
  queue: boolean
  /** The secrets bundle sweeps need to seal payloads and read credentials. */
  secrets: boolean
}

export type JobDef = {
  /** Stable name: the log label on Deno, the key both adapters use. */
  readonly id: string
  /**
   * The cadence the job rides, or null when it has none. A latency job (pinned
   * to every minute) names its key too, and its `due` rule stays the gate.
   */
  readonly cadence: CronJob | null
  readonly runtimes: readonly JobRuntime[]
  /** Required when the job runs on one runtime only: why the other has no use for it. */
  readonly oneSided?: string
  /**
   * Whether the job runs this tick. Omitted: every tick, and the runtime's own
   * adapter decides anything else (the billing slots, which have no cadence key).
   */
  readonly due?: (input: JobDueInput) => boolean
}

const BOTH = ['workers', 'deno'] as const
const DENO = ['deno'] as const
const WORKERS = ['workers'] as const

const onCadence = ({ cadenceDue }: JobDueInput, job: CronJob) => cadenceDue(job)

/** A connected server and a queue that can reach it. */
const connected = (input: JobDueInput) => input.queue && input.gates.connectedServer

/**
 * System reconcile and the managed-ingress orphan pass keep a five minute
 * throttle on their own last command, so while the gate shows a candidate they
 * run every minute; otherwise on their slot.
 */
const reconcile = (input: JobDueInput, job: CronJob, urgent: boolean) =>
  connected(input) && ((urgent && input.gates.reconcileUrgent) || input.cadenceDue(job))

export const JOBS = [
  // This process's own state: only the self-hosted process has any.
  {
    id: 'cell-maintain',
    cadence: null,
    runtimes: DENO,
    oneSided:
      'The in-memory cell exists only in the self-hosted process; a Durable Object keeps its own.',
  },
  {
    id: 'terminal-reap',
    cadence: null,
    runtimes: DENO,
    oneSided: 'Terminal sessions live in this process only; on Workers the cell object holds them.',
  },
  {
    id: 'terminal-revocation',
    cadence: null,
    runtimes: DENO,
    oneSided: 'Same hub as terminal-reap; the Workers cell ends revoked sessions itself.',
  },
  {
    id: 'colocated-self-repair',
    cadence: null,
    runtimes: DENO,
    oneSided: 'A panel sharing a host with a managed server exists only self-hosted.',
  },
  {
    id: 'heartbeat-refresh',
    cadence: 'heartbeatRefresh',
    runtimes: DENO,
    oneSided:
      'The advised heartbeat comes from this install hostname rows; Workers never reads it.',
    due: (input) => onCadence(input, 'heartbeatRefresh'),
  },
  // Liveness: the offline cutoff differs by design (see RUNTIME_DIFFERENCES).
  { id: 'stale-presence', cadence: 'offlineDetection', runtimes: BOTH },
  { id: 'disconnect-notice', cadence: null, runtimes: BOTH },
  {
    id: 'stale-key-socket-close',
    cadence: null,
    runtimes: WORKERS,
    oneSided:
      'Self-hosted checks the key on every inbound frame and ping; the hosted cell has no per-cell alarm, so the cron re-checks open sockets.',
  },
  {
    id: 'host-loss',
    cadence: null,
    runtimes: BOTH,
    due: (input) => input.queue,
  },
  {
    id: 'stale-command-sweep',
    cadence: 'commandRedelivery',
    runtimes: BOTH,
    due: ({ gates }) => gates.commandRecoveryWork,
  },
  {
    id: 'command-dispatch-sweep',
    cadence: 'commandDispatchCleanup',
    runtimes: BOTH,
    due: (input) => onCadence(input, 'commandDispatchCleanup'),
  },
  {
    id: 'webhook-delivery-sweep',
    cadence: 'webhookDeliveries',
    runtimes: BOTH,
    due: (input) => onCadence(input, 'webhookDeliveries'),
  },
  {
    id: 'daemon-nonce-sweep',
    cadence: 'daemonNonces',
    runtimes: BOTH,
    due: (input) => onCadence(input, 'daemonNonces'),
  },
  {
    id: 'pin-silence-sweep',
    cadence: 'pinSilence',
    runtimes: BOTH,
    due: (input) => onCadence(input, 'pinSilence'),
  },
  {
    id: 'orphan-folder-alert-sweep',
    cadence: 'orphanFolderAlerts',
    runtimes: BOTH,
    due: (input) => onCadence(input, 'orphanFolderAlerts'),
  },
  {
    id: 'notification-retry-sweep',
    cadence: null,
    runtimes: BOTH,
    due: ({ gates }) => gates.notificationWork,
  },
  {
    id: 'notification-digest-sweep',
    cadence: 'notificationDigests',
    runtimes: BOTH,
    due: (input) => input.gates.notificationHeld && onCadence(input, 'notificationDigests'),
  },
  {
    id: 'execution-log-sweep',
    cadence: 'executionLogs',
    runtimes: BOTH,
    due: (input) => onCadence(input, 'executionLogs'),
  },
  {
    id: 'history-prune',
    cadence: 'historyPrune',
    runtimes: BOTH,
    due: (input) => onCadence(input, 'historyPrune'),
  },
  {
    id: 'notification-history-prune',
    cadence: 'notificationPrune',
    runtimes: BOTH,
    due: (input) => onCadence(input, 'notificationPrune'),
  },
  {
    id: 'edge-trust-refresh',
    cadence: 'edgeTrust',
    runtimes: DENO,
    oneSided:
      'Edge address ranges for proxy modes are a self-hosted setting; hosted sits behind its own edge.',
    due: (input) => onCadence(input, 'edgeTrust'),
  },
  {
    id: 'tier-notice-sweep',
    cadence: 'tierNotices',
    runtimes: WORKERS,
    oneSided: 'Plan-tier notices exist only on the hosted product.',
    due: (input) => onCadence(input, 'tierNotices'),
  },
  {
    id: 'billing-stripe-projection',
    cadence: null,
    runtimes: WORKERS,
    oneSided: 'Billing exists only on the hosted product.',
  },
  {
    id: 'billing-reconcile',
    cadence: null,
    runtimes: WORKERS,
    oneSided: 'Billing exists only on the hosted product.',
  },
  {
    // Every minute while a run is pending or running, so it advances as fast as
    // the old minute timer did; otherwise on its slot.
    id: 'upgrade-tick',
    cadence: 'upgradeTick',
    runtimes: BOTH,
    due: (input) => input.gates.upgradeRunActive || onCadence(input, 'upgradeTick'),
  },
  {
    id: 'system-reconcile',
    cadence: 'systemReconcile',
    runtimes: BOTH,
    due: (input) => reconcile(input, 'systemReconcile', true),
  },
  {
    id: 'managed-ingress-orphan-sweep',
    cadence: 'managedIngressOrphan',
    runtimes: BOTH,
    // Teardown needs a full `managed.ingress.reconcile`, so it needs the secrets.
    due: (input) => input.secrets && reconcile(input, 'managedIngressOrphan', true),
  },
  {
    id: 'managed-external-access-pending-sweep',
    cadence: null,
    runtimes: BOTH,
    due: (input) => input.secrets && connected(input),
  },
  {
    id: 'datacenter-repin-fanout-sweep',
    cadence: null,
    runtimes: BOTH,
    due: (input) => input.secrets && input.queue && input.gates.repinPending,
  },
  {
    id: 'network-probe-sweep',
    cadence: null,
    runtimes: BOTH,
    due: (input) => input.queue && input.gates.networkProbe,
  },
  {
    id: 'backups-reconcile-sweep',
    cadence: 'backupsReconcile',
    runtimes: BOTH,
    due: (input) => reconcile(input, 'backupsReconcile', false),
  },
  {
    id: 'folder-removal-sweep',
    cadence: 'folderRemoval',
    runtimes: BOTH,
    due: (input) => reconcile(input, 'folderRemoval', false),
  },
  {
    id: 'principal-removal-sweep',
    cadence: null,
    runtimes: BOTH,
    due: (input) => input.queue && input.gates.principalRemoval,
  },
  {
    id: 'folder-reconcile-sweep',
    cadence: 'folderReconcile',
    runtimes: BOTH,
    due: (input) => reconcile(input, 'folderReconcile', false),
  },
  {
    id: 'firewall-preview-sweep',
    cadence: 'firewallPreview',
    runtimes: BOTH,
    due: (input) => reconcile(input, 'firewallPreview', false),
  },
  {
    id: 'leaf-renewal',
    cadence: 'leafRenewal',
    runtimes: BOTH,
    due: (input) =>
      input.secrets && input.queue && input.gates.certificates && onCadence(input, 'leafRenewal'),
  },
  {
    id: 'hosting-certificate-sweep',
    cadence: null,
    runtimes: BOTH,
    due: (input) => input.queue && input.gates.hostingPending,
  },
  {
    id: 'dns-certificate-cleanup',
    cadence: 'dnsCertificates',
    runtimes: BOTH,
    due: (input) =>
      input.secrets &&
      input.queue &&
      input.gates.certificates &&
      onCadence(input, 'dnsCertificates'),
  },
  {
    id: 'http-certificate-issuance',
    cadence: 'httpCertificates',
    runtimes: BOTH,
    due: (input) =>
      input.secrets &&
      input.queue &&
      (input.gates.httpCertificatesActive ||
        (input.gates.httpCertificates && onCadence(input, 'httpCertificates'))),
  },
  {
    id: 'tunnel-sweeps',
    cadence: 'tunnelSweeps',
    runtimes: BOTH,
    due: (input) =>
      input.secrets &&
      input.queue &&
      input.gates.tunnels &&
      (input.gates.tunnelsUrgent || onCadence(input, 'tunnelSweeps')),
  },
  {
    id: 'ingress-tick',
    cadence: 'ingressTick',
    runtimes: DENO,
    oneSided: 'DNS-01 orders for the panel own names and edge tunnel health are self-hosted only.',
    due: (input) => onCadence(input, 'ingressTick'),
  },
] as const satisfies readonly JobDef[]

type Row = (typeof JOBS)[number]

export type JobId = Row['id']

/** The ids of the rows a runtime runs; its adapter must handle exactly these. */
export type JobIdOn<R extends JobRuntime> = Row extends infer J
  ? J extends { readonly id: infer I; readonly runtimes: readonly (infer RT)[] }
    ? R extends RT
      ? I
      : never
    : never
  : never

const BY_ID = new Map<string, JobDef>(JOBS.map((job) => [job.id, job]))

/** The rows a runtime runs, in table order. */
export function jobsOn(runtime: JobRuntime): readonly JobDef[] {
  return JOBS.filter((job) => (job.runtimes as readonly JobRuntime[]).includes(runtime))
}

/** Whether a job runs on this tick. */
export function jobDue(id: JobId, input: JobDueInput): boolean {
  const job = BY_ID.get(id)
  return job?.due ? job.due(input) : true
}

/**
 * The differences between the runtimes that are intended and stay. Each is a
 * value the two adapters read, so the test can pin them.
 */
export const RUNTIME_DIFFERENCES = {
  /** Where cadence overrides are read from. Workers: env only, no database read per tick. */
  cadenceSource: { workers: 'env', deno: 'env-then-database' },
  /** Silence after which a server counts as offline. */
  offlineCutoffMs: { workers: 90_000, deno: DAEMON_OFFLINE_SWEEP_MS },
} as const
