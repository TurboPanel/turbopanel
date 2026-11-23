import { assert, assertEquals } from '@std/assert'
import { ALL_GATES_OPEN, type CronGates } from '../daemon/cell/cron-gates.ts'
import { DAEMON_OFFLINE_SWEEP_MS } from '../contracts/cell-protocol.ts'
import { CRON_CADENCES, type CronJob, isDue } from './registry.ts'
import {
  type JobDueInput,
  type JobId,
  JOBS,
  jobDue,
  jobsOn,
  type JobRuntime,
  RUNTIME_DIFFERENCES,
} from './table.ts'

/** Jest/Mocha-shaped alias so Sonar typescript:S2187 sees real tests. */
const test = Deno.test.bind(Deno)

const source = (relative: string) => Deno.readTextFileSync(new URL(relative, import.meta.url))

/** The ids each runtime's adapter handles, read from the adapter source. */
const WIRED: Record<JobRuntime, ReadonlySet<string>> = {
  // Deno: one handler per row, keyed by the row id.
  deno: new Set(
    [...source('../platform/deno/server.ts').matchAll(/^ {4}'([a-z-]+)': \{/gm)].map((m) => m[1])
  ),
  // Workers: every job the cron runs asks the shared rule by id.
  workers: new Set(
    [
      ...source('../daemon/cell/offline-sweep.ts').matchAll(
        /\b(?:jobDueNow|earlyJobDue)\('([a-z-]+)'\)/g
      ),
    ].map((m) => m[1])
  ),
}

const RUNTIMES: readonly JobRuntime[] = ['workers', 'deno']

test('every row is wired on each runtime it names and on no other', () => {
  for (const job of JOBS) {
    for (const runtime of RUNTIMES) {
      const named = (job.runtimes as readonly JobRuntime[]).includes(runtime)
      assertEquals(
        WIRED[runtime].has(job.id),
        named,
        `${job.id}: ${named ? 'missing from' : 'unexpectedly on'} ${runtime}`
      )
    }
  }
})

test('every job an adapter wires is a row of the table', () => {
  const ids = new Set<string>(JOBS.map((job) => job.id))
  for (const runtime of RUNTIMES) {
    for (const id of WIRED[runtime]) assert(ids.has(id), `${runtime} wires unknown job ${id}`)
  }
})

test('a row on one runtime only carries a written reason, and a shared row carries none', () => {
  for (const job of JOBS) {
    const oneSided = job.runtimes.length === 1
    const reason = 'oneSided' in job ? job.oneSided : undefined
    if (oneSided)
      assert(reason && reason.trim().length >= 20, `${job.id}: one-sided without a reason`)
    else assertEquals(reason, undefined, `${job.id}: shared row carries a one-sided reason`)
  }
})

test('row ids are unique and every cadence key exists in the registry', () => {
  assertEquals(new Set(JOBS.map((job) => job.id)).size, JOBS.length)
  for (const job of JOBS) {
    if (job.cadence !== null) assert(job.cadence in CRON_CADENCES, `${job.id}: ${job.cadence}`)
  }
})

test('every cadence key but the update check rides a row', () => {
  const used = new Set<string | null>(JOBS.map((job) => job.cadence))
  // `upgradeCheck` is read by the upgrade code, not by a tick.
  const unused = Object.keys(CRON_CADENCES).filter(
    (key) => !used.has(key) && key !== 'upgradeCheck'
  )
  assertEquals(unused, [])
})

test('the self-hosted list is the table, in table order', () => {
  assertEquals(
    jobsOn('deno').map((job) => job.id),
    JOBS.filter((job) => (job.runtimes as readonly JobRuntime[]).includes('deno')).map(
      (job) => job.id
    )
  )
})

test('the intended runtime differences are the ones written down', () => {
  assertEquals(RUNTIME_DIFFERENCES.cadenceSource, { workers: 'env', deno: 'env-then-database' })
  assertEquals(RUNTIME_DIFFERENCES.offlineCutoffMs.workers, 90_000)
  assertEquals(RUNTIME_DIFFERENCES.offlineCutoffMs.deno, DAEMON_OFFLINE_SWEEP_MS)
  assertEquals(DAEMON_OFFLINE_SWEEP_MS, 150_000)
})

const NO_GATES: CronGates = Object.fromEntries(
  Object.keys(ALL_GATES_OPEN).map((key) => [key, false])
) as CronGates

type DueOver = Partial<Omit<JobDueInput, 'gates'>> & { gates?: Partial<CronGates> }

const input = (over: DueOver = {}): JobDueInput => ({
  gates: { ...NO_GATES, ...over.gates },
  cadenceDue: over.cadenceDue ?? (() => false),
  queue: over.queue ?? true,
  secrets: over.secrets ?? true,
})

const due = (id: JobId, over?: DueOver) => jobDue(id, input(over))

test('a job with no rule runs every tick', () => {
  assertEquals(due('stale-presence'), true)
  assertEquals(due('disconnect-notice'), true)
  assertEquals(due('stale-key-socket-close'), true)
})

test('an active upgrade run makes the upgrade tick due off its slot', () => {
  assertEquals(due('upgrade-tick'), false)
  assertEquals(due('upgrade-tick', { gates: { upgradeRunActive: true } }), true)
  assertEquals(due('upgrade-tick', { cadenceDue: (job) => job === 'upgradeTick' }), true)
})

test('queue sweeps need a queue that can deliver', () => {
  const open = { gates: ALL_GATES_OPEN, cadenceDue: () => true }
  for (const id of [
    'host-loss',
    'system-reconcile',
    'network-probe-sweep',
    'principal-removal-sweep',
    'hosting-certificate-sweep',
    'tunnel-sweeps',
  ] as const) {
    assertEquals(due(id, { ...open, queue: true }), true, id)
    assertEquals(due(id, { ...open, queue: false }), false, id)
  }
})

test('sweeps that seal payloads need the secrets bundle', () => {
  const open = { gates: ALL_GATES_OPEN, cadenceDue: () => true }
  for (const id of [
    'managed-ingress-orphan-sweep',
    'managed-external-access-pending-sweep',
    'datacenter-repin-fanout-sweep',
    'leaf-renewal',
    'dns-certificate-cleanup',
    'http-certificate-issuance',
    'tunnel-sweeps',
  ] as const) {
    assertEquals(due(id, { ...open, secrets: true }), true, id)
    assertEquals(due(id, { ...open, secrets: false }), false, id)
  }
})

test('the reconnect-repair family needs a connected server', () => {
  const slot = { cadenceDue: () => true }
  for (const id of [
    'system-reconcile',
    'backups-reconcile-sweep',
    'folder-removal-sweep',
    'folder-reconcile-sweep',
    'firewall-preview-sweep',
    'managed-ingress-orphan-sweep',
    'managed-external-access-pending-sweep',
  ] as const) {
    assertEquals(due(id, slot), false, id)
    assertEquals(due(id, { ...slot, gates: { connectedServer: true } }), true, id)
  }
})

test('an urgent reconnect runs the reconcile pair off their slot, and the rest wait for it', () => {
  const urgent = { gates: { connectedServer: true, reconcileUrgent: true } }
  assertEquals(due('system-reconcile', urgent), true)
  assertEquals(due('managed-ingress-orphan-sweep', urgent), true)
  assertEquals(due('backups-reconcile-sweep', urgent), false)
  assertEquals(due('folder-reconcile-sweep', urgent), false)
})

test('urgent tunnel and certificate work runs off its slot', () => {
  assertEquals(due('tunnel-sweeps', { gates: { tunnels: true } }), false)
  assertEquals(due('tunnel-sweeps', { gates: { tunnels: true, tunnelsUrgent: true } }), true)
  assertEquals(due('http-certificate-issuance', { gates: { httpCertificates: true } }), false)
  assertEquals(due('http-certificate-issuance', { gates: { httpCertificatesActive: true } }), true)
  assertEquals(
    due('http-certificate-issuance', {
      gates: { httpCertificates: true },
      cadenceDue: (job) => job === 'httpCertificates',
    }),
    true
  )
})

test('the digest sweep needs a held delivery and its slot', () => {
  const slot = { cadenceDue: (job: CronJob) => job === 'notificationDigests' }
  assertEquals(due('notification-digest-sweep', slot), false)
  assertEquals(due('notification-digest-sweep', { gates: { notificationHeld: true } }), false)
  assertEquals(
    due('notification-digest-sweep', { ...slot, gates: { notificationHeld: true } }),
    true
  )
})

test('the retention rows follow the registry slots', () => {
  const minute = Date.parse('2026-01-01T00:15:00.000Z')
  const live: JobDueInput = {
    ...input(),
    cadenceDue: (job) => isDue(job, minute),
  }
  assertEquals(jobDue('execution-log-sweep', live), true)
  assertEquals(jobDue('history-prune', live), true)
  assertEquals(jobDue('tier-notice-sweep', live), false)
})
