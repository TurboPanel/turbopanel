import { assertEquals } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createUpgradeCoordinator, UPGRADE_LAST_RUN_VISIBLE_MS } from './coordinator.ts'
import { controlPlaneRollbackCommand } from './decisions.ts'
import { UPGRADE_TICK_STEP_BUDGET } from './run.ts'
import {
  createMemoryUpgradeStore,
  type FleetProbe,
  type FleetServerFact,
  type UpgradeRunRow,
  type UpgradeStepRow,
  type UpgradeStore,
} from './store.ts'
import type { UpgradeTarget } from './target.ts'
import { isInFlightStepStatus, isSettledStepStatus } from './transitions.ts'
import { UPGRADE_STEP_STATUSES, type UpgradeStepStatus } from './vocabulary.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * Branch pins for the coordinator, the memory store's tick window and the
 * step-status sets. They describe what the code does today so a refactor of
 * `buildPreflight`, `applyAction`, `advance`, `advanceWindow`, `noteProgress`,
 * `lastRun` or `memoryTickWindow` cannot change a decision unnoticed.
 */

const NOW = '2026-09-24T12:00:00.000Z'
const COLOCATED = 'colocated-0'

const unit = (name: string, version: string, commit: string) => ({
  version,
  commit,
  buildId: `${name}-build`,
  builtAt: '2026-09-24T00:00:00.000Z',
  manifestUrl: `https://example.test/${name}/manifest.json`,
})

const TARGET: UpgradeTarget = {
  daemon: unit('daemon', '0.1.1', 'new-daemon'),
  instance: unit('instance', '0.1.1', 'new-instance'),
  ui: unit('ui', '0.1.1', 'new-ui'),
}

function factFor(serverId: string, patch: Partial<FleetServerFact> = {}): FleetServerFact {
  return {
    serverId,
    name: serverId,
    hostname: `${serverId}.example`,
    connected: true,
    commit: 'old-daemon',
    version: '0.1.0',
    features: ['managed-upgrade-v1'],
    colocated: serverId === COLOCATED,
    ...patch,
  }
}

type Options = {
  runtime?: 'deno' | 'workers'
  channel?: 'trunk' | 'release'
  development?: boolean
  facts?: FleetServerFact[]
  target?: UpgradeTarget
  instanceInstalled?: { version: string; commit: string | null }
  colocatedServerId?: string | null
  now?: () => string
  probes?: Map<string, FleetProbe>
  /** Record every enqueue in `calls` too, so store and queue order can be compared. */
  traceEnqueue?: boolean
  /** Reject the enqueue for this server. */
  failEnqueueFor?: string
}

function build(options: Options = {}) {
  const enqueued: { serverId: string; envelope: DaemonOutboundEnvelope }[] = []
  const calls: string[] = []
  const base = createMemoryUpgradeStore({
    facts: options.facts ?? [factFor(COLOCATED)],
    latest: options.target ?? TARGET,
  })
  const probeCandidates = (ids: readonly string[]) => {
    calls.push('probeCandidates')
    const out = new Map<string, FleetProbe>()
    for (const id of ids) {
      const probe = options.probes?.get(id)
      if (probe) out.set(id, probe)
    }
    return Promise.resolve(out)
  }
  const store: UpgradeStore = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'probeCandidates') return probeCandidates
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(String(prop))
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      if (options.traceEnqueue) calls.push(`enqueue:${serverId}`)
      if (serverId === options.failEnqueueFor) return Promise.reject(new Error('queue down'))
      enqueued.push({ serverId, envelope })
      return Promise.resolve()
    },
    runtime: options.runtime ?? 'deno',
    channel: options.channel ?? 'release',
    development: options.development ?? false,
    now: options.now ?? (() => NOW),
    colocatedServerId:
      options.colocatedServerId === undefined ? COLOCATED : options.colocatedServerId,
    instanceInstalled: options.instanceInstalled ?? { version: '0.1.0', commit: 'old-instance' },
    resolveTarget: () => Promise.resolve(options.target ?? TARGET),
  })
  return { coordinator, store: base, enqueued, calls }
}

function runRow(patch: Partial<UpgradeRunRow> = {}): UpgradeRunRow {
  return {
    id: 'upgrade-run-1',
    createdAt: NOW,
    source: 'manual',
    channel: 'release',
    status: 'running',
    phase: 'fleet',
    startedBy: null,
    startedByEmail: null,
    target: TARGET,
    batchPolicy: { mode: 'percent', value: 100 },
    counts: null,
    error: null,
    startedAt: NOW,
    finishedAt: null,
    ...patch,
  }
}

function stepRow(id: string, patch: Partial<UpgradeStepRow> = {}): UpgradeStepRow {
  return {
    id,
    upgradeId: 'upgrade-run-1',
    serverId: 'srv-a',
    unit: 'daemon',
    phase: 'fleet',
    batchIndex: 0,
    status: 'pending',
    requestId: null,
    attempts: 0,
    nextAttemptAt: null,
    fromVersion: '0.1.0',
    toVersion: '0.1.1',
    fromCommit: 'old-daemon',
    toCommit: 'new-daemon',
    lastStageAt: NOW,
    errorCode: null,
    errorMessage: null,
    detail: { phase: 'fleet' },
    ...patch,
  }
}

const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString()

// --- preflight ------------------------------------------------------------

function summarizeChecks(preflight: { checks: { id: string; passed: boolean }[] }) {
  return preflight.checks.map((check) => [check.id, check.passed])
}

test('preflight: a healthy self-hosted release lists every check and no blocker', async () => {
  const { coordinator } = build()
  const preflight = await coordinator.preflight()
  assertEquals(summarizeChecks(preflight), [
    ['channel', true],
    ['target', true],
    ['active', true],
    ['no-downgrade', true],
    ['colocated', true],
    ['managed-upgrade-v1', true],
  ])
  assertEquals(preflight.blockers, [])
  assertEquals(preflight.canStart, true)
  assertEquals(preflight.recoveryCommand, controlPlaneRollbackCommand(preflight.runId))
})

test('preflight: blockers keep their order and the first one is the start error', async () => {
  const { coordinator, enqueued } = build({
    facts: [factFor(COLOCATED, { connected: false, features: [], version: '0.1.5' })],
    instanceInstalled: { version: '0.1.5', commit: 'old-instance' },
  })
  const preflight = await coordinator.preflight()
  assertEquals(summarizeChecks(preflight), [
    ['channel', true],
    ['target', true],
    ['active', true],
    ['no-downgrade', false],
    ['colocated', false],
    ['managed-upgrade-v1', false],
  ])
  assertEquals(preflight.blockers.length, 4)
  assertEquals(preflight.blockers[0]?.startsWith("The channel's control-plane build 0.1.1"), true)
  assertEquals(preflight.blockers[1]?.startsWith("The channel's daemon build 0.1.1"), true)
  assertEquals(preflight.blockers[2], 'The co-located daemon is not connected.')
  assertEquals(
    preflight.blockers[3]?.startsWith(
      'The co-located daemon does not advertise managed-upgrade-v1.'
    ),
    true
  )
  assertEquals(preflight.recoveryCommand.includes('TURBOPANEL_DAEMON_ONLY=1'), true)
  assertEquals(
    preflight.checks.find((check) => check.id === 'managed-upgrade-v1')?.detail,
    preflight.recoveryCommand
  )
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  assertEquals(started, { ok: false, error: preflight.blockers[0], blockers: preflight.blockers })
  assertEquals(enqueued.length, 0)
})

test('preflight: an unresolved channel target blocks before any host check', async () => {
  const { coordinator } = build({ target: { daemon: null, instance: null, ui: null } })
  const preflight = await coordinator.preflight()
  assertEquals(preflight.checks[1], {
    id: 'target',
    label: 'Target build resolved',
    passed: false,
    detail: undefined,
  })
  assertEquals(preflight.blockers[0], 'The channel target could not be resolved.')
  assertEquals(preflight.blockers.length > 1, true)
  assertEquals(preflight.canStart, false)
})

test('preflight: development and Workers skip the self-hosted host checks', async () => {
  for (const options of [{ development: true }, { runtime: 'workers' as const }]) {
    const { coordinator } = build({
      ...options,
      facts: [factFor(COLOCATED, { connected: false, features: [] })],
    })
    const preflight = await coordinator.preflight()
    assertEquals(
      summarizeChecks(preflight),
      [
        ['channel', true],
        ['target', true],
        ['active', true],
      ],
      JSON.stringify(options)
    )
  }
})

test('preflight: a channel without a control-plane package skips the managed feature check', async () => {
  const { coordinator } = build({
    channel: 'trunk',
    facts: [factFor(COLOCATED, { features: [] })],
  })
  const preflight = await coordinator.preflight()
  assertEquals(
    preflight.checks.map((check) => check.id),
    ['channel', 'target', 'active', 'no-downgrade', 'colocated']
  )
  assertEquals(preflight.recoveryCommand, controlPlaneRollbackCommand(preflight.runId))
})

test('preflight: a running upgrade blocks and its id is the recovery id', async () => {
  const { coordinator } = build()
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  const preflight = await coordinator.preflight()
  assertEquals(preflight.runId, started.runId)
  assertEquals(preflight.checks[2], {
    id: 'active',
    label: 'No upgrade is already running',
    passed: false,
  })
  assertEquals(preflight.blockers.includes('Another update is already in progress.'), true)
  assertEquals(preflight.canStart, false)
})

// --- lastRun ---------------------------------------------------------------

test('lastRun: a run stays visible up to exactly 24 hours after it finished', async () => {
  const finish = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString()
  const cases: [string, string | null, boolean][] = [
    ['just finished', finish(0), true],
    ['exactly at the limit', finish(UPGRADE_LAST_RUN_VISIBLE_MS), true],
    ['one millisecond past the limit', finish(UPGRADE_LAST_RUN_VISIBLE_MS + 1), false],
    ['finished in the future', finish(-60_000), true],
    ['unparseable finish time', 'not-a-date', false],
    ['still open', null, false],
  ]
  for (const [label, finishedAt, visible] of cases) {
    const { coordinator, store } = build()
    await store.insertRun(runRow({ status: 'failed', finishedAt }), [])
    const last = await coordinator.lastRun()
    assertEquals(last !== null, visible, label)
  }
})

// --- tick: one step through applyAction -------------------------------------

type TickResult = {
  step: UpgradeStepRow
  run: UpgradeRunRow | null
  enqueued: { serverId: string; envelope: DaemonOutboundEnvelope }[]
  calls: string[]
}

async function tickOne(
  step: Partial<UpgradeStepRow>,
  fact: Partial<FleetServerFact> = {},
  options: Options = {}
): Promise<TickResult> {
  const serverId = step.serverId ?? 'srv-a'
  const { coordinator, store, enqueued, calls } = build({
    runtime: 'workers',
    colocatedServerId: null,
    facts: [factFor(serverId, { colocated: false, ...fact })],
    ...options,
  })
  await store.insertRun(runRow(), [stepRow('step-1', step)])
  calls.length = 0
  await coordinator.tick({ resolveManifests: false })
  const stored = (await store.stepsFor('upgrade-run-1'))[0]
  if (!stored) throw new TypeError('step vanished')
  return { step: stored, run: await store.runById('upgrade-run-1'), enqueued, calls }
}

test('tick: a pending step on an online host is dispatched once', async () => {
  const { step, enqueued } = await tickOne({ status: 'pending', attempts: 0 })
  assertEquals(step.status, 'dispatched')
  assertEquals(step.attempts, 1)
  assertEquals(step.nextAttemptAt, null)
  assertEquals(step.lastStageAt, NOW)
  assertEquals(enqueued.length, 1)
  assertEquals(enqueued[0]?.envelope.kind, 'update')
  assertEquals(enqueued[0]?.envelope.requestId, step.requestId)
})

test('tick: a pending step still inside its backoff waits without dispatching', async () => {
  const later = new Date(Date.parse(NOW) + 60_000).toISOString()
  const { step, enqueued } = await tickOne({ status: 'pending', nextAttemptAt: later })
  assertEquals(step.status, 'pending')
  assertEquals(enqueued.length, 0)
})

test('tick: a host that reports the target commit marks the step done', async () => {
  const { step, enqueued } = await tickOne({ status: 'dispatched' }, { commit: 'new-daemon' })
  assertEquals(step.status, 'done')
  assertEquals(step.lastStageAt, NOW)
  assertEquals(enqueued.length, 0)
})

test('tick: an offline host parks the step as waiting and stamps when it started waiting', async () => {
  const first = await tickOne(
    { status: 'pending', lastStageAt: minutesAgo(5) },
    { connected: false }
  )
  assertEquals(first.step.status, 'waiting')
  assertEquals(first.step.lastStageAt, NOW)
  const again = await tickOne(
    { status: 'waiting', lastStageAt: minutesAgo(5) },
    { connected: false }
  )
  assertEquals(again.step.status, 'waiting')
  assertEquals(again.step.lastStageAt, minutesAgo(5))
  assertEquals(again.enqueued.length, 0)
})

test('tick: a step offline for over an hour needs attention as server_offline', async () => {
  const { step } = await tickOne(
    { status: 'waiting', lastStageAt: minutesAgo(61) },
    { connected: false }
  )
  assertEquals(step.status, 'needs_attention')
  assertEquals(step.errorCode, 'server_offline')
})

test('tick: a stalled install retries with backoff, then needs attention after the last attempt', async () => {
  const retried = await tickOne({ status: 'installing', attempts: 1, lastStageAt: minutesAgo(16) })
  assertEquals(retried.step.status, 'pending')
  assertEquals(retried.step.nextAttemptAt, new Date(Date.parse(NOW) + 60_000).toISOString())
  const spent = await tickOne({ status: 'installing', attempts: 3, lastStageAt: minutesAgo(16) })
  assertEquals(spent.step.status, 'needs_attention')
  assertEquals(spent.step.errorCode, 'step_timeout')
  const fresh = await tickOne({ status: 'installing', attempts: 1, lastStageAt: minutesAgo(1) })
  assertEquals(fresh.step.status, 'installing')
})

test('tick: a rolled-back step is redispatched once, then needs attention', async () => {
  const again = await tickOne({ status: 'rolled_back', attempts: 1 })
  assertEquals(again.step.status, 'dispatched')
  assertEquals(again.step.attempts, 2)
  const spent = await tickOne({ status: 'rolled_back', attempts: 2 })
  assertEquals(spent.step.status, 'needs_attention')
  assertEquals(spent.step.errorCode, 'rolled_back')
})

test('tick: a control-plane step needs the co-located daemon to be managed', async () => {
  const { coordinator, store, enqueued } = build({
    facts: [factFor(COLOCATED, { features: [] })],
  })
  await store.insertRun(runRow({ phase: 'control_plane' }), [
    stepRow('step-1', {
      serverId: COLOCATED,
      unit: 'instance',
      phase: 'control_plane',
      toCommit: 'new-instance',
      detail: { phase: 'control_plane' },
    }),
  ])
  await coordinator.tick({ resolveManifests: false })
  const step = (await store.stepsFor('upgrade-run-1'))[0]
  assertEquals(step?.status, 'needs_attention')
  assertEquals(step?.errorCode, 'managed_upgrade_required')
  assertEquals(step?.errorMessage?.includes('TURBOPANEL_DAEMON_ONLY=1'), true)
  assertEquals(enqueued.length, 0)
})

test('tick: a live probe overrides the stored connection state and commit', async () => {
  const probes = new Map<string, FleetProbe>([
    ['srv-a', { connected: true, commit: null, version: null }],
  ])
  const online = await tickOne({ status: 'pending' }, { connected: false }, { probes })
  assertEquals(online.step.status, 'dispatched')
  assertEquals(online.enqueued.length, 1)

  const onTarget = new Map<string, FleetProbe>([
    ['srv-a', { connected: true, commit: 'new-daemon', version: '0.1.1' }],
  ])
  const done = await tickOne({ status: 'dispatched' }, { connected: false }, { probes: onTarget })
  assertEquals(done.step.status, 'done')
})

test('tick: the store is read and written in a fixed order', async () => {
  const { calls, step } = await tickOne({ status: 'pending' })
  assertEquals(calls, [
    'activeRun',
    'readTickCursor',
    'tickWindow',
    'factsFor',
    'probeCandidates',
    'saveStep',
    'countSteps',
    'saveRun',
    'writeTickCursor',
  ])
  assertEquals(step.status, 'dispatched')
})

test('tick: a probe-free tick still asks for no probes when nothing is a candidate', async () => {
  const { coordinator, store, calls } = build({
    runtime: 'workers',
    colocatedServerId: null,
    facts: [],
  })
  await store.insertRun(runRow(), [
    stepRow('step-1', { status: 'done' }),
    stepRow('step-2', { status: 'failed' }),
  ])
  await coordinator.tick({ resolveManifests: false })
  assertEquals(calls.includes('probeCandidates'), false)
  assertEquals((await store.runById('upgrade-run-1'))?.status, 'partially_failed')
  assertEquals(await store.readTickCursor('upgrade-run-1'), null)
})

test('tick: the fleet phase waits behind the platform gate', async () => {
  const { coordinator, store, enqueued } = build({
    facts: [factFor(COLOCATED), factFor('srv-a', { colocated: false })],
  })
  await store.insertRun(runRow({ phase: 'colocated_daemon' }), [
    stepRow('step-0', {
      serverId: COLOCATED,
      phase: 'colocated_daemon',
      status: 'done',
      detail: { phase: 'colocated_daemon' },
    }),
    stepRow('step-1', { serverId: 'srv-a' }),
  ])
  await coordinator.tick({ resolveManifests: false })
  const fleet = (await store.stepsFor('upgrade-run-1')).find((step) => step.id === 'step-1')
  assertEquals(fleet?.status, 'pending')
  assertEquals(enqueued.length, 0)
})

// --- tick window paging ------------------------------------------------------

test('tick: a full window writes a resume cursor and the next partial one clears it', async () => {
  const total = UPGRADE_TICK_STEP_BUDGET + 10
  const ids = Array.from({ length: total }, (_, i) => `srv-${String(i).padStart(3, '0')}`)
  const { coordinator, store } = build({
    runtime: 'workers',
    colocatedServerId: null,
    facts: ids.map((id) => factFor(id, { colocated: false })),
  })
  await store.insertRun(
    runRow(),
    ids.map((serverId, i) => stepRow(`step-${String(i).padStart(3, '0')}`, { serverId }))
  )
  await coordinator.tick({ resolveManifests: false })
  const last = `step-${String(UPGRADE_TICK_STEP_BUDGET - 1).padStart(3, '0')}`
  assertEquals(await store.readTickCursor('upgrade-run-1'), {
    phase: 'fleet',
    batchIndex: 0,
    afterId: last,
  })
  await coordinator.tick({ resolveManifests: false })
  assertEquals(await store.readTickCursor('upgrade-run-1'), {
    phase: 'fleet',
    batchIndex: 0,
    afterId: null,
  })
  const statuses = new Set((await store.stepsFor('upgrade-run-1')).map((step) => step.status))
  assertEquals([...statuses], ['dispatched'])
  assertEquals((await store.runById('upgrade-run-1'))?.counts?.inProgress, total)
})

test('tick: a failed platform step ends the run and clears the cursor', async () => {
  const { coordinator, store } = build()
  await store.insertRun(runRow({ phase: 'colocated_daemon' }), [
    stepRow('step-0', {
      serverId: COLOCATED,
      phase: 'colocated_daemon',
      status: 'needs_attention',
      detail: { phase: 'colocated_daemon' },
    }),
    stepRow('step-1', { serverId: 'srv-a' }),
  ])
  await store.writeTickCursor('upgrade-run-1', { phase: 'fleet', batchIndex: 0, afterId: 'x' })
  await coordinator.tick({ resolveManifests: false })
  const run = await store.runById('upgrade-run-1')
  assertEquals(run?.status, 'failed')
  assertEquals(run?.phase, null)
  assertEquals(await store.readTickCursor('upgrade-run-1'), null)
})

// --- progress reports --------------------------------------------------------

async function progress(
  step: Partial<UpgradeStepRow>,
  input: {
    stage: 'installing' | 'failed' | 'rolled-back' | 'done'
    detail?: string
    errorCode?: string
  }
) {
  const { coordinator, store } = build({ runtime: 'workers', colocatedServerId: null })
  await store.insertRun(runRow(), [
    stepRow('step-1', { status: 'dispatched', requestId: 'req-1', ...step }),
  ])
  await coordinator.noteProgress({
    serverId: 'srv-a',
    unit: 'daemon',
    at: '2026-09-24T12:05:00.000Z',
    requestId: 'req-1',
    ...input,
  })
  const stored = (await store.stepsFor('upgrade-run-1'))[0]
  if (!stored) throw new TypeError('step vanished')
  return stored
}

test('noteProgress: a non-empty detail merges into the step detail, an empty one is ignored', async () => {
  const merged = await progress(
    { detail: { phase: 'fleet', priorRequestIds: ['old'] } },
    { stage: 'installing', detail: 'downloading files' }
  )
  assertEquals(merged.status, 'installing')
  assertEquals(merged.detail, {
    phase: 'fleet',
    priorRequestIds: ['old'],
    progressDetail: 'downloading files',
  })
  assertEquals(merged.errorMessage, null)
  assertEquals(merged.lastStageAt, '2026-09-24T12:05:00.000Z')

  const empty = await progress(
    { detail: { phase: 'fleet', kept: true } },
    { stage: 'installing', detail: '' }
  )
  assertEquals(empty.detail, { phase: 'fleet', kept: true })
})

test('noteProgress: a non-object detail is replaced', async () => {
  for (const detail of ['text', null, 7]) {
    const step = await progress({ detail }, { stage: 'installing', detail: 'x' })
    assertEquals(step.detail, { phase: 'fleet', progressDetail: 'x' })
  }
})

test('noteProgress: a terminal failure copies the detail into errorMessage, success does not', async () => {
  const failed = await progress(
    {},
    { stage: 'failed', detail: 'disk full', errorCode: 'update_failed' }
  )
  assertEquals(failed.status, 'failed')
  assertEquals(failed.errorMessage, 'disk full')
  assertEquals(failed.errorCode, 'update_failed')

  const rolledBack = await progress({}, { stage: 'rolled-back', detail: 'health check' })
  assertEquals(rolledBack.status, 'rolled_back')
  assertEquals(rolledBack.errorMessage, 'health check')

  const done = await progress({}, { stage: 'done', detail: 'ok' })
  assertEquals(done.status, 'done')
  assertEquals(done.errorMessage, null)
})

test('noteProgress: a signed URL in a failure detail never reaches errorMessage or detail', async () => {
  const signed = 'https://objects.example/a.tar?X-Amz-Signature=deadbeef&token=s3cr3t'
  const failed = await progress({}, { stage: 'failed', detail: `GET ${signed} failed: EAI_AGAIN` })
  assertEquals(
    failed.errorMessage,
    'GET https://objects.example/a.tar?[redacted] failed: EAI_AGAIN'
  )
  assertEquals(JSON.stringify(failed).includes('deadbeef'), false)
  assertEquals(JSON.stringify(failed).includes('s3cr3t'), false)
})

test('noteProgress: an empty error code leaves the recorded one', async () => {
  const step = await progress({ errorCode: 'earlier' }, { stage: 'installing', errorCode: '' })
  assertEquals(step.errorCode, 'earlier')
})

test('noteProgress: a late failure from a superseded dispatch applies only after a refusal', async () => {
  const ignored = await progress(
    { requestId: 'req-2', detail: { phase: 'fleet', priorRequestIds: ['req-1'] } },
    { stage: 'failed', detail: 'late' }
  )
  assertEquals(ignored.status, 'dispatched')
  const applied = await progress(
    {
      requestId: 'req-2',
      detail: { phase: 'fleet', priorRequestIds: ['req-1'], inProgressRefused: true },
    },
    { stage: 'failed', detail: 'late' }
  )
  assertEquals(applied.status, 'failed')
})

// --- memory store tick window -------------------------------------------------

function windowSteps() {
  return [
    stepRow('a1', { phase: 'fleet', batchIndex: 1, status: 'pending', serverId: 's1' }),
    stepRow('a2', { phase: 'fleet', batchIndex: 0, status: 'pending', serverId: 's2' }),
    stepRow('a3', { phase: 'fleet', batchIndex: 0, status: 'installing', serverId: 's3' }),
    stepRow('a4', { phase: 'fleet', batchIndex: 0, status: 'done', serverId: 's4' }),
    stepRow('a5', { phase: 'fleet', batchIndex: 0, status: 'pending', serverId: 's5' }),
    stepRow('b1', { upgradeId: 'other-run', status: 'pending', serverId: 's6' }),
  ]
}

async function windowOf(cursor: Parameters<UpgradeStore['tickWindow']>[1], limit: number) {
  const store = createMemoryUpgradeStore()
  await store.insertRun(
    runRow(),
    windowSteps().filter((step) => step.upgradeId === 'upgrade-run-1')
  )
  const window = await store.tickWindow('upgrade-run-1', cursor, limit)
  return {
    ids: window.steps.map((step) => step.id),
    phase: window.phase,
    batchIndex: window.batchIndex,
    allTerminal: window.allTerminal,
    failedPlatformPhase: window.failedPlatformPhase,
  }
}

test('memory tickWindow: the lowest open batch is paged by id after the cursor', async () => {
  assertEquals(await windowOf(null, 50), {
    ids: ['a2', 'a3', 'a5'],
    phase: 'fleet',
    batchIndex: 0,
    allTerminal: false,
    failedPlatformPhase: null,
  })
  assertEquals((await windowOf(null, 2)).ids, ['a2', 'a3'])
  assertEquals((await windowOf({ phase: 'fleet', batchIndex: 0, afterId: 'a2' }, 50)).ids, [
    'a3',
    'a5',
  ])
  assertEquals((await windowOf({ phase: 'fleet', batchIndex: 0, afterId: 'a3' }, 1)).ids, ['a5'])
  assertEquals((await windowOf({ phase: 'fleet', batchIndex: 0, afterId: 'a5' }, 50)).ids, [])
})

test('memory tickWindow: a cursor for another batch or phase is ignored', async () => {
  assertEquals((await windowOf({ phase: 'fleet', batchIndex: 1, afterId: 'a3' }, 50)).ids, [
    'a2',
    'a3',
    'a5',
  ])
  assertEquals((await windowOf({ phase: 'control_plane', batchIndex: 0, afterId: 'a3' }, 50)).ids, [
    'a2',
    'a3',
    'a5',
  ])
  assertEquals((await windowOf({ phase: 'fleet', batchIndex: 0, afterId: null }, 50)).ids, [
    'a2',
    'a3',
    'a5',
  ])
})

test('memory tickWindow: an invalid limit falls back to the tick budget', async () => {
  for (const limit of [0, -3, 1.5, Number.NaN]) {
    assertEquals((await windowOf(null, limit)).ids, ['a2', 'a3', 'a5'], String(limit))
  }
})

test('memory tickWindow: a run with every step settled is all-terminal', async () => {
  const store = createMemoryUpgradeStore()
  await store.insertRun(runRow(), [
    stepRow('t1', { status: 'done' }),
    stepRow('t2', {
      status: 'needs_attention',
      phase: 'control_plane',
      detail: { phase: 'control_plane' },
    }),
  ])
  const window = await store.tickWindow('upgrade-run-1', null, 50)
  assertEquals(window.steps, [])
  assertEquals(window.allTerminal, true)
  assertEquals(window.phase, null)
  assertEquals(window.batchIndex, null)
  assertEquals(window.failedPlatformPhase, 'control_plane')
})

test('memory tickWindow: the open phase is the earliest one, whatever the batch numbers', async () => {
  const store = createMemoryUpgradeStore()
  await store.insertRun(runRow(), [
    stepRow('f1', { phase: 'fleet', batchIndex: 0 }),
    stepRow('c1', {
      phase: 'control_plane',
      batchIndex: 2,
      unit: 'instance',
      detail: { phase: 'control_plane' },
    }),
    stepRow('c2', {
      phase: 'control_plane',
      batchIndex: 1,
      unit: 'instance',
      detail: { phase: 'control_plane' },
    }),
  ])
  const window = await store.tickWindow('upgrade-run-1', null, 50)
  assertEquals(window.phase, 'control_plane')
  assertEquals(window.batchIndex, 1)
  assertEquals(
    window.steps.map((step) => step.id),
    ['c2']
  )
})

// --- step status sets --------------------------------------------------------

test('step status sets: settled and in-flight cover exactly their members', () => {
  const settled: UpgradeStepStatus[] = ['done', 'skipped', 'failed', 'needs_attention']
  const inFlight: UpgradeStepStatus[] = [
    'dispatched',
    'preparing',
    'downloading',
    'installing',
    'restarting',
    'verifying',
  ]
  for (const status of UPGRADE_STEP_STATUSES) {
    assertEquals(isSettledStepStatus(status), settled.includes(status), `settled ${status}`)
    assertEquals(isInFlightStepStatus(status), inFlight.includes(status), `in flight ${status}`)
  }
})

// --- tick and cancel: several steps in one pass ------------------------------

const THREE_HOSTS = ['srv-a', 'srv-b', 'srv-c']

/** A run of one pending step per host in `THREE_HOSTS`, with the fleet gate open. */
async function threeHostRun(options: Options = {}) {
  const built = build({
    development: true,
    colocatedServerId: null,
    facts: THREE_HOSTS.map((id) => factFor(id, { colocated: false })),
    ...options,
  })
  await built.store.insertRun(
    runRow(),
    THREE_HOSTS.map((serverId, i) => stepRow(`step-${i}`, { serverId }))
  )
  built.calls.length = 0
  return built
}

/** The message of whatever `work` rejects with, or null when it resolves. */
function rejection(work: Promise<unknown>): Promise<string | null> {
  return work.then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
}

test('tick: several pending steps are claimed and dispatched one after another, in step order', async () => {
  const { coordinator, calls } = await threeHostRun({ traceEnqueue: true })
  await coordinator.tick({ resolveManifests: false })
  assertEquals(
    calls.filter((call) => call === 'saveStep' || call.startsWith('enqueue:')),
    ['saveStep', 'enqueue:srv-a', 'saveStep', 'enqueue:srv-b', 'saveStep', 'enqueue:srv-c']
  )
})

test('tick: a failing enqueue is recorded on that step and the later steps are still dispatched', async () => {
  const { coordinator, store, enqueued } = await threeHostRun({
    traceEnqueue: true,
    failEnqueueFor: 'srv-b',
  })
  await coordinator.tick({ resolveManifests: false })
  assertEquals(
    enqueued.map((item) => item.serverId),
    ['srv-a', 'srv-c']
  )
  const steps = await store.stepsFor('upgrade-run-1')
  assertEquals(
    steps.map((step) => step.status),
    ['dispatched', 'pending', 'dispatched']
  )
  assertEquals(steps[1]?.errorMessage?.includes('queue down'), true)
  assertEquals(steps[1]?.attempts, 1)
})

test('cancel: skips open steps in order, leaves settled ones alone, then records the run', async () => {
  const { coordinator, store, calls } = build({ colocatedServerId: null, facts: [] })
  await store.insertRun(runRow(), [
    stepRow('step-0', { status: 'pending' }),
    stepRow('step-1', { status: 'done' }),
    stepRow('step-2', { status: 'dispatched' }),
    stepRow('step-3', { status: 'failed' }),
  ])
  calls.length = 0
  assertEquals(await coordinator.cancel('upgrade-run-1'), { ok: true })
  assertEquals(calls, ['runById', 'stepsFor', 'saveStep', 'saveStep', 'saveRun'])
  const steps = await store.stepsFor('upgrade-run-1')
  assertEquals(
    steps.map((step) => step.status),
    ['skipped', 'done', 'skipped', 'failed']
  )
  const run = await store.runById('upgrade-run-1')
  assertEquals(run?.status, 'cancelled')
  assertEquals(run?.counts?.skipped, 2)
})

test('cancel: a failing save stops at that step and the run is not recorded as cancelled', async () => {
  const { coordinator, store } = await threeHostRun()
  const saved: string[] = []
  const innerSave = store.saveStep.bind(store)
  store.saveStep = (row, expectedStatus) => {
    saved.push(row.id)
    if (row.id === 'step-1') return Promise.reject(new Error('write failed'))
    return innerSave(row, expectedStatus)
  }
  assertEquals(await rejection(coordinator.cancel('upgrade-run-1')), 'write failed')
  assertEquals(saved, ['step-0', 'step-1'])
  assertEquals((await store.runById('upgrade-run-1'))?.status, 'running')
})

test('memory pageFleet: a negative, NaN or missing offset starts at the first row', async () => {
  const facts = ['srv-a', 'srv-b', 'srv-c'].map((id) => factFor(id, { colocated: false }))
  const store = createMemoryUpgradeStore({ facts, latest: TARGET })
  const ids = async (offset: number, limit: number) =>
    (await store.pageFleet({ offset, limit, status: 'all', targetCommit: null }, null)).facts.map(
      (fact) => fact.serverId
    )
  assertEquals(await ids(-3, 2), ['srv-a', 'srv-b'])
  assertEquals(await ids(Number.NaN, 2), ['srv-a', 'srv-b'])
  assertEquals(await ids(0, 2), ['srv-a', 'srv-b'])
  assertEquals(await ids(1, 2), ['srv-b', 'srv-c'])
  assertEquals(await ids(3, 2), [])
})
