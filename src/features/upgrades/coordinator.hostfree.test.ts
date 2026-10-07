import { assertEquals } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createUpgradeCoordinator } from './coordinator.ts'
import { clientUpdateBlock } from './decisions.ts'
import { compareUpgradeStepRows } from './run.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'
import { DEFAULT_UPGRADE_SETTINGS } from '../settings/upgrade-settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '11111111-1111-4111-8111-111111111111'

function fact(features: string[], commit = 'old-daemon'): FleetServerFact {
  return {
    serverId: SERVER,
    name: 'panel',
    hostname: 'panel.example',
    connected: true,
    commit,
    version: '0.1.0',
    features,
    colocated: true,
  }
}

const target = {
  daemon: {
    version: '0.1.1',
    commit: 'new-daemon',
    buildId: 'd1',
    builtAt: '2026-09-24T00:00:00.000Z',
    manifestUrl: 'https://example.test/daemon/manifest.json',
  },
  instance: {
    version: '0.1.1',
    commit: 'new-instance',
    buildId: 'i1',
    builtAt: '2026-09-24T00:00:00.000Z',
    manifestUrl: 'https://example.test/instance/manifest.json',
  },
  ui: {
    version: '0.1.1',
    commit: 'new-ui',
    buildId: 'u1',
    builtAt: '2026-09-24T00:00:00.000Z',
    manifestUrl: 'https://example.test/ui/manifest.json',
  },
}

function harness(features: string[]) {
  const enqueued: DaemonOutboundEnvelope[] = []
  const database = {
    fingerprint: '0000',
    version: '0.1.0',
    commit: 'old-instance',
  }
  const store = createMemoryUpgradeStore({
    facts: [fact(features)],
    latest: target,
  })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push(envelope)
      void serverId
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'release',
    development: false,
    now: () => '2026-09-24T12:00:00.000Z',
    colocatedServerId: SERVER,
    instanceInstalled: { version: database.version, commit: database.commit },
    resolveTarget: () => Promise.resolve(target),
  })
  return { coordinator, enqueued, database, store }
}

test('an old co-located daemon cannot start a control-plane install', async () => {
  const { coordinator, enqueued, database } = harness([])
  const preflight = await coordinator.preflight()
  assertEquals(preflight.canStart, false)
  assertEquals(
    preflight.blockers.some((line) => line.includes('managed-upgrade-v1')),
    true
  )
  assertEquals(preflight.recoveryCommand.includes('TURBOPANEL_DAEMON_ONLY=1'), true)
  const started = await coordinator.start({
    source: 'manual',
    startedBy: null,
  })
  assertEquals(started.ok, false)
  assertEquals(enqueued.length, 0)
  assertEquals(database, {
    fingerprint: '0000',
    version: '0.1.0',
    commit: 'old-instance',
  })
})

test('managed-upgrade-v1 updates the daemon before the control plane', async () => {
  const { coordinator, enqueued, database, store } = harness(['managed-upgrade-v1'])
  const preflight = await coordinator.preflight()
  assertEquals(preflight.canStart, true)
  assertEquals(
    preflight.recoveryCommand.includes(
      '/opt/turbopanel/share/orchestration/scripts/tp-orchestrate'
    ),
    true
  )
  const started = await coordinator.start({
    source: 'manual',
    startedBy: null,
  })
  if (!started.ok) throw new TypeError(started.error)
  assertEquals(
    enqueued.map((entry) => entry.kind),
    ['update']
  )
  const daemonUpdate = enqueued[0]
  if (daemonUpdate?.kind !== 'update') throw new TypeError('expected update')
  assertEquals(daemonUpdate.upgradeId, started.runId)
  assertEquals(daemonUpdate.targetCommit, 'new-daemon')
  assertEquals(database.commit, 'old-instance')

  await coordinator.noteDaemonCommit(SERVER, 'new-daemon', '2026-09-24T12:05:00.000Z')
  store.facts[0] = fact(['managed-upgrade-v1'], 'new-daemon')
  await coordinator.tick({ resolveManifests: false })
  assertEquals(
    enqueued.map((entry) => entry.kind),
    ['update', 'instance-update']
  )
  const instanceUpdate = enqueued[1]
  if (instanceUpdate?.kind !== 'instance-update') {
    throw new TypeError('expected instance-update')
  }
  assertEquals(instanceUpdate.upgradeId, started.runId)
  assertEquals(instanceUpdate.targetCommit, 'new-instance')
})

test('a missing run id is not a successful upgrade', async () => {
  const { coordinator } = harness(['managed-upgrade-v1'])
  assertEquals(await coordinator.run('missing-run'), null)
})

test('cancel records a cancelled run and retry reopens a failed step', async () => {
  const { coordinator } = harness(['managed-upgrade-v1'])
  const started = await coordinator.start({
    source: 'manual',
    startedBy: null,
  })
  if (!started.ok) throw new TypeError(started.error)
  const active = await coordinator.activeRun()
  const step = active?.steps[0]
  if (!step?.requestId) throw new TypeError('expected a dispatched step')
  await coordinator.noteProgress({
    serverId: SERVER,
    unit: 'daemon',
    stage: 'failed',
    at: '2026-09-24T12:01:00.000Z',
    detail: 'disk full',
    errorCode: 'preflight_disk',
    requestId: step.requestId,
  })
  const failed = await coordinator.activeRun()
  assertEquals(failed?.steps[0]?.status, 'failed')

  const retried = await coordinator.retry(step.id)
  assertEquals(retried, { ok: true })
  const reopened = await coordinator.activeRun()
  const again = reopened?.steps.find((item) => item.id === step.id)
  assertEquals(again?.status, 'dispatched')
  assertEquals(again?.attempts, 2)
  assertEquals(again?.errorCode, null)
  if (again?.requestId === step.requestId) {
    throw new TypeError("a manual retry reused the failed attempt's request id")
  }

  const cancelled = await coordinator.cancel(started.runId)
  assertEquals(cancelled.ok, true)
  const gone = await coordinator.activeRun()
  assertEquals(gone, null)
  const recorded = await coordinator.run(started.runId)
  assertEquals(recorded?.status, 'cancelled')
})

const FLEET_A = '33333333-3333-4333-8333-333333333333'
const FLEET_B = '44444444-4444-4444-8444-444444444444'
const FLEET_C = '55555555-5555-4555-8555-555555555555'
const FLEET_D = '66666666-6666-4666-8666-666666666666'

test('start updates connected fleet servers before offline ones', async () => {
  const fleetFact = (serverId: string, name: string, connected: boolean): FleetServerFact => ({
    ...fact(['managed-upgrade-v1'], 'old-daemon'),
    serverId,
    name,
    colocated: false,
    connected,
  })
  const enqueued: string[] = []
  const store = createMemoryUpgradeStore({
    facts: [
      fleetFact(FLEET_A, 'studio', false),
      fleetFact(FLEET_B, 'alpha', true),
      fleetFact(FLEET_C, 'io', false),
      fleetFact(FLEET_D, 'beta', true),
    ],
    latest: target,
    settings: {
      ...DEFAULT_UPGRADE_SETTINGS,
      batch: { mode: 'count', value: 1 },
    },
  })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId) => {
      enqueued.push(serverId)
      return Promise.resolve()
    },
    runtime: 'workers',
    channel: 'canary',
    development: false,
    now: () => '2026-09-24T12:00:00.000Z',
    colocatedServerId: null,
    instanceInstalled: { version: '0.1.1', commit: 'new-instance' },
    resolveTarget: () => Promise.resolve({ ...target, instance: null, ui: null }),
  })
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  const steps = (await store.stepsFor(started.runId)).filter((step) => step.phase === 'fleet')
  assertEquals(
    steps.map((step) => step.serverId),
    [FLEET_B, FLEET_D, FLEET_A, FLEET_C]
  )
  assertEquals(
    steps.map((step) => step.batchIndex),
    [0, 1, 2, 3]
  )
  assertEquals(enqueued, [FLEET_B])
})

test('a missing UI or instance manifest refuses the run', async () => {
  for (const unit of ['ui', 'instance'] as const) {
    const broken = { ...target, [unit]: null }
    const enqueued: DaemonOutboundEnvelope[] = []
    const store = createMemoryUpgradeStore({
      facts: [fact(['managed-upgrade-v1'])],
      latest: broken,
    })
    const coordinator = createUpgradeCoordinator({
      store,
      enqueue: (_serverId, envelope) => {
        enqueued.push(envelope)
        return Promise.resolve()
      },
      runtime: 'deno',
      channel: 'release',
      development: false,
      now: () => '2026-09-24T12:00:00.000Z',
      colocatedServerId: SERVER,
      instanceInstalled: { version: '0.1.0', commit: 'old-instance' },
      resolveTarget: () => Promise.resolve(broken),
    })
    const preflight = await coordinator.preflight()
    assertEquals(preflight.canStart, false)
    const label = unit === 'ui' ? 'UI' : 'instance'
    assertEquals(
      preflight.blockers.some((line) => line.includes(label)),
      true
    )
    const started = await coordinator.start({
      source: 'manual',
      startedBy: null,
    })
    assertEquals(started.ok, false)
    assertEquals(enqueued.length, 0)
  }
})

test('an already-current host is satisfied and a behind host is dispatched', async () => {
  const enqueued: Array<{ serverId: string; kind: string }> = []
  const facts: FleetServerFact[] = [
    fact(['managed-upgrade-v1'], 'new-daemon'),
    {
      ...fact(['managed-upgrade-v1'], 'new-daemon'),
      serverId: FLEET_A,
      name: 'current',
      colocated: false,
    },
    {
      ...fact(['managed-upgrade-v1'], 'old-daemon'),
      serverId: FLEET_B,
      name: 'behind',
      colocated: false,
    },
  ]
  const store = createMemoryUpgradeStore({ facts, latest: target })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, kind: envelope.kind })
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'release',
    development: false,
    now: () => '2026-09-24T12:00:00.000Z',
    colocatedServerId: SERVER,
    instanceInstalled: { version: '0.1.1', commit: 'new-instance' },
    resolveTarget: () => Promise.resolve(target),
  })
  const started = await coordinator.start({
    source: 'manual',
    startedBy: null,
  })
  if (!started.ok) throw new TypeError(started.error)
  assertEquals(enqueued, [{ serverId: FLEET_B, kind: 'update' }])
})

test('fleet rows returned first still dispatch daemon then instance then fleet', async () => {
  const enqueued: Array<{ serverId: string; kind: string }> = []
  const installed = { version: '0.1.0', commit: 'old-instance' }
  const facts: FleetServerFact[] = [
    fact(['managed-upgrade-v1'], 'old-daemon'),
    {
      ...fact(['managed-upgrade-v1'], 'old-daemon'),
      serverId: FLEET_B,
      name: 'behind',
      colocated: false,
    },
  ]
  const store = createMemoryUpgradeStore({ facts, latest: target })
  const inner = store.stepsFor.bind(store)
  store.stepsFor = (id) =>
    inner(id).then((steps) => [...steps].sort((a, b) => compareUpgradeStepRows(b, a)))
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, kind: envelope.kind })
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'release',
    development: false,
    now: () => '2026-09-24T12:00:00.000Z',
    colocatedServerId: SERVER,
    instanceInstalled: installed,
    resolveTarget: () => Promise.resolve(target),
  })
  const started = await coordinator.start({
    source: 'manual',
    startedBy: null,
  })
  if (!started.ok) throw new TypeError(started.error)
  assertEquals(enqueued, [{ serverId: SERVER, kind: 'update' }])
  await coordinator.noteDaemonCommit(SERVER, 'new-daemon', '2026-09-24T12:05:00.000Z')
  store.facts[0] = fact(['managed-upgrade-v1'], 'new-daemon')
  await coordinator.tick({ resolveManifests: false })
  assertEquals(
    enqueued.map((entry) => entry.kind),
    ['update', 'instance-update']
  )
  assertEquals(enqueued[1]?.serverId, SERVER)
  installed.commit = 'new-instance'
  installed.version = '0.1.1'
  const afterDaemon = await coordinator.activeRun()
  const instanceStep = afterDaemon?.steps.find((item) => item.unit === 'instance')
  if (!instanceStep?.requestId) {
    throw new TypeError('expected an instance dispatch')
  }
  await coordinator.noteOutcome({
    serverId: SERVER,
    unit: 'instance',
    ok: true,
    at: '2026-09-24T12:10:00.000Z',
    requestId: instanceStep.requestId,
  })
  await coordinator.tick({ resolveManifests: false })
  assertEquals(enqueued, [
    { serverId: SERVER, kind: 'update' },
    { serverId: SERVER, kind: 'instance-update' },
    { serverId: FLEET_B, kind: 'update' },
  ])
})

test('a late failed report from attempt one does not overwrite attempt two', async () => {
  const { coordinator, enqueued, store } = harness(['managed-upgrade-v1'])
  const started = await coordinator.start({
    source: 'manual',
    startedBy: null,
  })
  if (!started.ok) throw new TypeError(started.error)
  const first = enqueued[0]
  if (!first || first.kind !== 'update') throw new TypeError('expected update')
  const active = await coordinator.activeRun()
  const step = active?.steps.find((item) => item.unit === 'daemon')
  if (!step) throw new TypeError('expected a daemon step')
  step.status = 'pending'
  step.nextAttemptAt = null
  await store.saveStep(step)
  await coordinator.tick({ resolveManifests: false })
  const second = enqueued[1]
  if (!second || second.kind !== 'update') {
    throw new TypeError('expected a second update')
  }
  if (second.requestId === first.requestId) {
    throw new TypeError("attempt two reused attempt one's request id")
  }

  const replayLateFailure = async () => {
    await coordinator.noteProgress({
      serverId: SERVER,
      unit: 'daemon',
      stage: 'failed',
      at: '2026-09-24T12:02:00.000Z',
      detail: 'attempt one failed',
      errorCode: 'update_failed',
      requestId: first.requestId,
    })
    await coordinator.noteOutcome({
      serverId: SERVER,
      unit: 'daemon',
      ok: false,
      at: '2026-09-24T12:02:00.000Z',
      error: 'attempt one failed',
      errorCode: 'update_failed',
      requestId: first.requestId,
    })
  }
  await replayLateFailure()
  await replayLateFailure()
  const held = await coordinator.activeRun()
  const heldStep = held?.steps.find((item) => item.unit === 'daemon')
  assertEquals(heldStep?.status, 'dispatched')
  assertEquals(heldStep?.requestId, second.requestId)
  assertEquals(heldStep?.attempts, 2)

  await coordinator.noteDaemonCommit(SERVER, 'new-daemon', '2026-09-24T12:06:00.000Z')
  const confirmed = await coordinator.activeRun()
  assertEquals(confirmed?.steps.find((item) => item.unit === 'daemon')?.status, 'done')
})

test('preflight reserves a run id and start reuses the copied command', async () => {
  const { coordinator, store } = harness(['managed-upgrade-v1'])
  const first = await coordinator.preflight()
  assertEquals(first.recoveryCommand.includes('pending'), false)
  assertEquals(first.recoveryCommand.includes(first.runId), true)
  assertEquals(first.backupPath, `/backup/control-plane/${first.runId}`)
  const restarted = createUpgradeCoordinator({
    store,
    enqueue: () => Promise.resolve(),
    runtime: 'deno',
    channel: 'release',
    development: false,
    now: () => '2026-09-24T12:00:00.000Z',
    colocatedServerId: SERVER,
    instanceInstalled: { version: '0.1.0', commit: 'old-instance' },
    resolveTarget: () => Promise.resolve(target),
  })
  const after = await restarted.preflight()
  assertEquals(after.runId, first.runId)
  assertEquals(after.recoveryCommand, first.recoveryCommand)
  const started = await restarted.start({
    source: 'manual',
    startedBy: null,
    runId: first.runId,
  })
  if (!started.ok) throw new TypeError(started.error)
  assertEquals(started.runId, first.runId)
})

const T0 = '2026-09-24T12:00:00.000Z'

function minutesAfter(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString()
}

/** A coordinator whose clock the test moves. */
function clockHarness(input: {
  facts: FleetServerFact[]
  installed?: { version: string; commit: string | null }
}) {
  const clock = { now: T0 }
  const enqueued: Array<{ serverId: string; envelope: DaemonOutboundEnvelope }> = []
  const store = createMemoryUpgradeStore({ facts: input.facts, latest: target })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, envelope })
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'release',
    development: false,
    now: () => clock.now,
    colocatedServerId: SERVER,
    instanceInstalled: input.installed ?? { version: '0.1.0', commit: 'old-instance' },
    resolveTarget: () => Promise.resolve(target),
  })
  return { coordinator, enqueued, store, clock }
}

async function startOrThrow(
  coordinator: ReturnType<typeof createUpgradeCoordinator>
): Promise<string> {
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  return started.runId
}

test('a failed co-located daemon step ends the run instead of holding it open', async () => {
  const { coordinator, enqueued } = clockHarness({
    facts: [fact(['managed-upgrade-v1'])],
  })
  const runId = await startOrThrow(coordinator)
  const dispatched = enqueued[0]?.envelope
  if (!dispatched) throw new TypeError('expected the co-located dispatch')
  await coordinator.noteOutcome({
    serverId: SERVER,
    unit: 'daemon',
    ok: false,
    at: T0,
    error: 'update_failed: install script exited 1',
    errorCode: 'update_failed',
    requestId: dispatched.requestId,
  })
  await coordinator.tick({ resolveManifests: false })
  assertEquals(await coordinator.activeRun(), null)
  const recorded = await coordinator.run(runId)
  assertEquals(recorded?.status, 'failed')
  assertEquals(recorded?.error, 'colocated_daemon_failed')
})

test("a failed run stays readable as lastRun for a day, with the daemon's reason", async () => {
  const h = clockHarness({ facts: [fact(['managed-upgrade-v1'])] })
  const runId = await startOrThrow(h.coordinator)
  assertEquals(await h.coordinator.lastRun(), null)
  const dispatched = h.enqueued[0]?.envelope
  if (!dispatched) throw new TypeError('expected the co-located dispatch')
  await h.coordinator.noteOutcome({
    serverId: SERVER,
    unit: 'daemon',
    ok: false,
    at: T0,
    error: 'preflight_manifest: channel manifest signature is invalid (keyId c72c6744)',
    errorCode: 'preflight_manifest',
    requestId: dispatched.requestId,
  })
  await h.coordinator.tick({ resolveManifests: false })
  assertEquals(await h.coordinator.activeRun(), null)

  const last = await h.coordinator.lastRun()
  assertEquals(last?.id, runId)
  assertEquals(last?.status, 'failed')
  assertEquals(last?.error, 'colocated_daemon_failed')
  const step = last?.steps.find((item) => item.phase === 'colocated_daemon')
  assertEquals(step?.status, 'failed')
  assertEquals(step?.errorCode, 'preflight_manifest')
  assertEquals(
    step?.errorMessage,
    'preflight_manifest: channel manifest signature is invalid (keyId c72c6744)'
  )

  h.clock.now = minutesAfter(T0, 25 * 60)
  assertEquals(await h.coordinator.lastRun(), null)
})

/** Stall the first dispatch, let the tick retry it, and return both ids. */
async function stallAndRetry(
  h: ReturnType<typeof clockHarness>
): Promise<{ first: string; second: string; stepId: string }> {
  const first = h.enqueued[0]?.envelope.requestId
  if (!first) throw new TypeError('expected a first dispatch')
  h.clock.now = minutesAfter(T0, 16)
  await h.coordinator.tick({ resolveManifests: false })
  h.clock.now = minutesAfter(T0, 18)
  await h.coordinator.tick({ resolveManifests: false })
  const second = h.enqueued[1]?.envelope.requestId
  if (!second) throw new TypeError('expected the stall retry to re-dispatch')
  const run = await h.coordinator.activeRun()
  const stepId = run?.steps.find((item) => item.status === 'dispatched')?.id
  if (!stepId) throw new TypeError('expected a dispatched step')
  return { first, second, stepId }
}

async function rejectAsInProgress(
  h: ReturnType<typeof clockHarness>,
  unit: 'daemon' | 'instance',
  requestId: string
): Promise<void> {
  await h.coordinator.noteProgress({
    serverId: SERVER,
    unit,
    stage: 'failed',
    at: minutesAfter(T0, 18),
    detail: 'update already in progress',
    errorCode: 'preflight_in_progress',
    requestId,
  })
  await h.coordinator.noteOutcome({
    serverId: SERVER,
    unit,
    ok: false,
    at: minutesAfter(T0, 18),
    error: 'preflight_in_progress: update already in progress',
    errorCode: 'preflight_in_progress',
    requestId,
  })
}

test('a stall retry refused as already in progress keeps the install in flight', async () => {
  const h = clockHarness({ facts: [fact(['managed-upgrade-v1'])] })
  await startOrThrow(h.coordinator)
  const { second, stepId } = await stallAndRetry(h)
  await rejectAsInProgress(h, 'daemon', second)
  const held = (await h.coordinator.activeRun())?.steps.find((item) => item.id === stepId)
  assertEquals(held?.status === 'failed', false)
  assertEquals(held?.errorCode === 'preflight_in_progress', false)

  await h.coordinator.noteDaemonCommit(SERVER, 'new-daemon', minutesAfter(T0, 25))
  const done = (await h.coordinator.activeRun())?.steps.find((item) => item.id === stepId)
  assertEquals(done?.status, 'done')
})

test("the first dispatch's success still completes an instance step after a stall retry", async () => {
  const h = clockHarness({
    facts: [fact(['managed-upgrade-v1'], 'new-daemon')],
  })
  await startOrThrow(h.coordinator)
  assertEquals(h.enqueued[0]?.envelope.kind, 'instance-update')
  const { first, second, stepId } = await stallAndRetry(h)
  await rejectAsInProgress(h, 'instance', second)
  await h.coordinator.noteOutcome({
    serverId: SERVER,
    unit: 'instance',
    ok: true,
    at: minutesAfter(T0, 30),
    requestId: first,
  })
  const done = (await h.coordinator.activeRun())?.steps.find((item) => item.id === stepId)
  assertEquals(done?.status, 'done')
})

test('a stale failure applies once the newer dispatch was refused as in progress', async () => {
  const h = clockHarness({ facts: [fact(['managed-upgrade-v1'])] })
  await startOrThrow(h.coordinator)
  const { first, second, stepId } = await stallAndRetry(h)
  await rejectAsInProgress(h, 'daemon', second)
  await h.coordinator.noteOutcome({
    serverId: SERVER,
    unit: 'daemon',
    ok: false,
    at: minutesAfter(T0, 30),
    error: 'update_failed: disk full',
    errorCode: 'update_failed',
    requestId: first,
  })
  const failed = (await h.coordinator.activeRun())?.steps.find((item) => item.id === stepId)
  assertEquals(failed?.status, 'failed')
  assertEquals(failed?.errorCode, 'update_failed')
})

test('a control-plane rollback is recorded as rolled_back and retried once', async () => {
  const h = clockHarness({
    facts: [fact(['managed-upgrade-v1'], 'new-daemon')],
  })
  await startOrThrow(h.coordinator)
  const first = h.enqueued[0]?.envelope
  if (first?.kind !== 'instance-update') {
    throw new TypeError('expected the control-plane dispatch')
  }
  await h.coordinator.noteProgress({
    serverId: SERVER,
    unit: 'instance',
    stage: 'rolled-back',
    at: minutesAfter(T0, 5),
    detail: 'health_timeout: new build never became healthy',
    errorCode: 'health_timeout',
    requestId: first.requestId,
  })
  await h.coordinator.noteOutcome({
    serverId: SERVER,
    unit: 'instance',
    ok: false,
    at: minutesAfter(T0, 5),
    error: 'health_timeout: new build never became healthy',
    errorCode: 'health_timeout',
    requestId: first.requestId,
  })
  const rolled = (await h.coordinator.activeRun())?.steps.find((item) => item.unit === 'instance')
  assertEquals(rolled?.status, 'rolled_back')
  assertEquals(rolled?.errorCode, 'health_timeout')

  h.clock.now = minutesAfter(T0, 6)
  await h.coordinator.tick({ resolveManifests: false })
  const retry = h.enqueued[1]?.envelope
  assertEquals(retry?.kind, 'instance-update')
  if (retry?.requestId === first.requestId) {
    throw new TypeError('the post-rollback attempt reused the rolled-back id')
  }
  const again = (await h.coordinator.activeRun())?.steps.find((item) => item.unit === 'instance')
  assertEquals(again?.status, 'dispatched')
  assertEquals(again?.attempts, 2)
})

test('a fleet server already newer than the target is not downgraded', async () => {
  const h = clockHarness({
    facts: [
      fact(['managed-upgrade-v1'], 'new-daemon'),
      {
        ...fact(['managed-upgrade-v1'], 'future-daemon'),
        serverId: FLEET_A,
        name: 'ahead',
        version: '0.2.0',
        colocated: false,
      },
      {
        ...fact(['managed-upgrade-v1'], 'old-daemon'),
        serverId: FLEET_B,
        name: 'same version, other commit',
        version: '0.1.1',
        colocated: false,
      },
    ],
    installed: { version: '0.1.1', commit: 'new-instance' },
  })
  const runId = await startOrThrow(h.coordinator)
  assertEquals(
    h.enqueued.map((entry) => entry.serverId),
    [FLEET_B]
  )
  const recorded = await h.coordinator.run(runId)
  const ahead = recorded?.steps.find((item) => item.serverId === FLEET_A)
  assertEquals(ahead?.status, 'skipped')
  assertEquals(ahead?.errorCode, 'downgrade_refused')
})

test('preflight refuses a target older than the installed control plane', async () => {
  const h = clockHarness({
    facts: [fact(['managed-upgrade-v1'])],
    installed: { version: '0.2.0', commit: 'future-instance' },
  })
  const preflight = await h.coordinator.preflight()
  assertEquals(preflight.canStart, false)
  assertEquals(
    preflight.blockers.some((line) => line.includes('older than')),
    true
  )
  const started = await h.coordinator.start({
    source: 'manual',
    startedBy: null,
  })
  assertEquals(started.ok, false)
  assertEquals(h.enqueued.length, 0)
})

test('preflight refuses a target older than the co-located daemon', async () => {
  const h = clockHarness({
    facts: [{ ...fact(['managed-upgrade-v1'], 'future-daemon'), version: '0.3.0' }],
  })
  const preflight = await h.coordinator.preflight()
  assertEquals(preflight.canStart, false)
  assertEquals(
    preflight.blockers.some((line) => line.includes('older than')),
    true
  )
})

test('auto-update waits for an offline server to reconnect instead of opening runs for it', async () => {
  const store = createMemoryUpgradeStore({
    facts: [
      {
        ...fact(['managed-upgrade-v1'], 'old-daemon'),
        serverId: FLEET_A,
        colocated: false,
        connected: false,
      },
    ],
    latest: target,
    settings: { ...DEFAULT_UPGRADE_SETTINGS, autoUpdate: true },
  })
  const enqueued: DaemonOutboundEnvelope[] = []
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (_serverId, envelope) => {
      enqueued.push(envelope)
      return Promise.resolve()
    },
    runtime: 'workers',
    channel: 'release',
    development: false,
    now: () => T0,
    colocatedServerId: null,
    instanceInstalled: { version: '0.1.1', commit: 'new-instance' },
    resolveTarget: () => Promise.resolve(target),
  })
  await coordinator.tick()
  assertEquals(await coordinator.activeRun(), null)

  store.facts[0] = { ...store.facts[0]!, connected: true }
  await coordinator.tick()
  assertEquals((await coordinator.activeRun())?.source, 'auto')
  assertEquals(
    enqueued.map((envelope) => envelope.kind),
    ['update']
  )
})

test('a non-development gate fails closed when the target cannot be read', () => {
  assertEquals(
    clientUpdateBlock({
      runtime: 'deno',
      development: false,
      targetCommitKnown: false,
      gateOpen: false,
    }),
    { blocked: true, error: 'upgrade_gate_unavailable' }
  )
  assertEquals(
    clientUpdateBlock({
      runtime: 'deno',
      development: true,
      targetCommitKnown: false,
      gateOpen: false,
    }),
    { blocked: false, useCoordinator: false }
  )
  assertEquals(
    clientUpdateBlock({
      runtime: 'deno',
      development: false,
      targetCommitKnown: true,
      gateOpen: false,
    }),
    { blocked: true, error: 'control_plane_upgrade_required' }
  )
})

test('a hello reporting the target commit while a tick is mid-redispatch is not clobbered', async () => {
  const { coordinator, enqueued, store } = harness(['managed-upgrade-v1'])
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  const first = enqueued[0]
  if (!first || first.kind !== 'update') throw new TypeError('expected update')

  const active = await coordinator.activeRun()
  const step = active?.steps.find((item) => item.unit === 'daemon')
  if (!step) throw new TypeError('expected a daemon step')

  // A co-located daemon's own self-restart mid-install drops it "offline"
  // for a few seconds; the tick sees that and marks the step waiting
  // (dispatched again once the server is seen connected).
  step.status = 'waiting'
  step.nextAttemptAt = null
  await store.saveStep(step)

  const innerSave = store.saveStep.bind(store)
  let injected = false
  store.saveStep = async (row, expectedStatus) => {
    if (!injected && expectedStatus === 'waiting') {
      injected = true
      // The daemon's hello lands here — between this tick reading "waiting"
      // and writing its redispatch — reporting it already reached the
      // target commit. `fact.commit` (the fleet projection) hasn't caught
      // up yet, same as production: they are two separate writes from one
      // hello.
      await coordinator.noteDaemonCommit(SERVER, 'new-daemon', '2026-09-24T12:01:00.000Z')
    }
    return await innerSave(row, expectedStatus)
  }

  await coordinator.tick({ resolveManifests: false })

  // No second install command for a step the daemon already finished.
  assertEquals(enqueued.length, 1)
  const after = await coordinator.activeRun()
  const finalStep = after?.steps.find((item) => item.unit === 'daemon')
  assertEquals(finalStep?.status, 'done')
})

test('the control-plane step is not done until the daemon reports, and a second update is refused meanwhile', async () => {
  const installed = { version: '0.1.0', commit: 'old-instance' as string | null }
  const enqueued: DaemonOutboundEnvelope[] = []
  const store = createMemoryUpgradeStore({
    facts: [fact(['managed-upgrade-v1'], 'new-daemon')],
    latest: target,
  })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (_serverId, envelope) => {
      enqueued.push(envelope)
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'release',
    development: false,
    now: () => T0,
    colocatedServerId: SERVER,
    instanceInstalled: installed,
    resolveTarget: () => Promise.resolve(target),
  })
  const runId = await startOrThrow(coordinator)
  assertEquals(
    enqueued.map((envelope) => envelope.kind),
    ['instance-update']
  )

  // The new binary restarted and now answers as the target build, but the
  // daemon is still verifying it.
  installed.commit = 'new-instance'
  await coordinator.tick({ resolveManifests: false })
  assertEquals((await coordinator.activeRun())?.id, runId)

  const second = await coordinator.start({ source: 'manual', startedBy: null })
  assertEquals(second.ok, false)
  if (second.ok) throw new TypeError('expected a refusal')
  assertEquals(second.error, 'upgrade_run_active')
  assertEquals(second.activeRunId, runId)
  assertEquals(second.blockers, ['Another update is already in progress.'])

  const requestId = enqueued[0]?.requestId
  if (!requestId) throw new TypeError('expected the dispatch')
  await coordinator.noteOutcome({
    serverId: SERVER,
    unit: 'instance',
    ok: true,
    at: T0,
    requestId,
  })
  await coordinator.tick({ resolveManifests: false })
  assertEquals(await coordinator.activeRun(), null)
  assertEquals((await coordinator.run(runId))?.status, 'succeeded')
})

test('a step the busy daemon refused reaches needs_attention after one install window, not three', async () => {
  const h = clockHarness({ facts: [fact(['managed-upgrade-v1'], 'new-daemon')] })
  const runId = await startOrThrow(h.coordinator)
  const requestId = h.enqueued[0]?.envelope.requestId
  if (!requestId) throw new TypeError('expected the dispatch')
  await h.coordinator.noteProgress({
    serverId: SERVER,
    unit: 'instance',
    stage: 'failed',
    at: T0,
    errorCode: 'preflight_in_progress',
    requestId,
  })
  h.clock.now = minutesAfter(T0, 16)
  await h.coordinator.tick({ resolveManifests: false })
  const recorded = await h.coordinator.run(runId)
  const stuck = recorded?.steps.find((item) => item.unit === 'instance')
  assertEquals(stuck?.status, 'needs_attention')
  assertEquals(stuck?.errorCode, 'step_timeout')
})
