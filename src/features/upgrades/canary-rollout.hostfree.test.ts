import { assertEquals, assertMatch } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createUpgradeCoordinator, type UpgradeTickDecision } from './coordinator.ts'
import {
  formatUpgradeTickDecision,
  resetUpgradeTickLogForTests,
  traceUpgradeTick,
  UPGRADE_TICK_LOG_REPEAT_MS,
} from './maintenance.ts'
import { builtAfter, createMemoryUpgradeStore, type FleetServerFact } from './store.ts'
import type { UpgradeTarget } from './target.ts'
import { DEFAULT_UPGRADE_SETTINGS } from '../settings/upgrade-settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * The testing fleet on 2026-09-27: daemons report their plain base version
 * (`0.1.1`) and an older build; the canary channel publishes the next build
 * of the same base under a pre-release label.
 */
const CANARY_VERSION = '0.1.1-canary.20260927-182044-86d492d'
const CANARY_BUILT_AT = '2026-09-27T18:20:44Z'

function fleetHost(serverId: string, overrides: Partial<FleetServerFact> = {}): FleetServerFact {
  return {
    serverId,
    name: serverId,
    hostname: `${serverId}.example`,
    connected: true,
    commit: 'ee6236a0000000000000000000000000000000000',
    version: '0.1.1',
    builtAt: '2026-09-27T00:14:32Z',
    features: ['managed-upgrade-v1'],
    colocated: false,
    ...overrides,
  }
}

const canaryTarget: UpgradeTarget = {
  daemon: {
    version: CANARY_VERSION,
    commit: '86d492d8000000000000000000000000000000000',
    buildId: '20260927-182044-86d492d',
    builtAt: CANARY_BUILT_AT,
    manifestUrl: `https://github.com/TurboPanel/turbopaneld/releases/download/canary/manifest-${CANARY_VERSION}.json`,
  },
  instance: null,
  ui: null,
}

function workersFleet(facts: FleetServerFact[], autoUpdate = true) {
  const enqueued: { serverId: string; envelope: DaemonOutboundEnvelope }[] = []
  const decisions: UpgradeTickDecision[] = []
  const store = createMemoryUpgradeStore({
    facts,
    latest: canaryTarget,
    settings: { ...DEFAULT_UPGRADE_SETTINGS, autoUpdate },
  })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, envelope })
      return Promise.resolve()
    },
    runtime: 'workers',
    channel: 'canary',
    development: false,
    now: () => '2026-09-27T19:00:00.000Z',
    colocatedServerId: null,
    instanceInstalled: { version: '0.1.1', commit: 'b12db099' },
    resolveTarget: () => Promise.resolve(canaryTarget),
    trace: (decision) => decisions.push(decision),
  })
  return { coordinator, enqueued, decisions, store }
}

test('a canary build of the installed base rolls out to the Workers fleet', async () => {
  const { coordinator, enqueued, decisions, store } = workersFleet([
    fleetHost('adrastea'),
    fleetHost('kore'),
  ])

  await coordinator.tick({ resolveManifests: true })

  assertEquals(decisions.length, 1)
  const decision = decisions[0]
  assertEquals(decision.daemonDrift, true)
  assertEquals(decision.autoStart.decision, 'started')
  if (decision.autoStart.decision !== 'started') return
  // Before the fix every step was created `skipped` / `downgrade_refused`.
  assertEquals(decision.autoStart.steps.skipped, 0)
  const steps = await store.stepsFor(decision.autoStart.runId)
  assertEquals(
    steps.map((step) => step.errorCode),
    [null, null]
  )
  assertEquals(enqueued.map((entry) => entry.envelope.kind).sort(), ['update', 'update'])
})

test('a host whose own build is newer than the target is not dispatched', async () => {
  const { coordinator, enqueued, store } = workersFleet([
    fleetHost('ahead', { builtAt: '2026-09-28T00:00:00Z' }),
    fleetHost('behind'),
  ])

  const started = await coordinator.start({ source: 'auto', startedBy: null })
  assertEquals(started.ok, true)
  if (!started.ok) return
  const steps = await store.stepsFor(started.runId)
  const byServer = new Map(steps.map((step) => [step.serverId, step]))
  assertEquals(byServer.get('ahead')?.errorCode, 'downgrade_refused')
  assertEquals(byServer.get('behind')?.errorCode, null)
  assertEquals(
    enqueued.map((entry) => entry.serverId),
    ['behind']
  )
})

test('a fleet already ahead of the target does not reopen a run every tick', async () => {
  const { coordinator, enqueued, decisions } = workersFleet([
    fleetHost('ahead', { builtAt: '2026-09-28T00:00:00Z' }),
  ])

  await coordinator.tick({ resolveManifests: true })

  assertEquals(decisions[0].daemonDrift, false)
  assertEquals(decisions[0].autoStart, { decision: 'not-attempted' })
  assertEquals(enqueued, [])
})

test('self-hosted preflight does not call a canary build of the installed base a downgrade', async () => {
  const colocated = fleetHost('panel', { colocated: true })
  const target: UpgradeTarget = {
    daemon: canaryTarget.daemon,
    instance: {
      version: '0.1.1-canary.20260927-165414-b12db09',
      commit: 'b12db0990000000000000000000000000000000',
      buildId: '20260927-165414-b12db09',
      builtAt: '2026-09-27T16:54:14Z',
      manifestUrl: 'https://example.test/instance.json',
    },
    ui: {
      version: '0.1.1-canary.20260927-185132-accf34f',
      commit: 'accf34f0000000000000000000000000000000000',
      buildId: '20260927-185132-accf34f',
      builtAt: '2026-09-27T18:51:32Z',
      manifestUrl: 'https://example.test/ui.json',
    },
  }
  const coordinator = createUpgradeCoordinator({
    store: createMemoryUpgradeStore({ facts: [colocated], latest: target }),
    enqueue: () => Promise.resolve(),
    runtime: 'deno',
    channel: 'canary',
    development: false,
    now: () => '2026-09-27T19:00:00.000Z',
    colocatedServerId: 'panel',
    instanceInstalled: { version: '0.1.1', commit: '64c5c281' },
    resolveTarget: () => Promise.resolve(target),
  })

  const preflight = await coordinator.preflight()

  const noDowngrade = preflight.checks.find((check) => check.id === 'no-downgrade')
  assertEquals(noDowngrade?.passed, true)
  assertEquals(
    preflight.blockers.filter((blocker) => blocker.includes('older than')),
    []
  )
})

test('a canary build never starts a Workers run while autoUpdate is off', async () => {
  const { coordinator, enqueued, decisions, store } = workersFleet(
    [fleetHost('adrastea'), fleetHost('kore')],
    false
  )

  await coordinator.tick({ resolveManifests: true })

  assertEquals(decisions.length, 1)
  assertEquals(decisions[0].daemonDrift, true)
  assertEquals(decisions[0].autoStart, { decision: 'not-attempted' })
  assertEquals(await store.activeRun(), null)
  assertEquals(enqueued.length, 0)
})

test('builtAfter needs both build times and a strictly later install', () => {
  assertEquals(builtAfter('2026-09-28T00:00:00Z', '2026-09-27T18:20:44Z'), true)
  assertEquals(builtAfter('2026-09-27T00:14:32Z', '2026-09-27T18:20:44Z'), false)
  assertEquals(builtAfter('2026-09-27T18:20:44Z', '2026-09-27T18:20:44Z'), false)
  assertEquals(builtAfter(null, '2026-09-27T18:20:44Z'), false)
  assertEquals(builtAfter('2026-09-28T00:00:00Z', null), false)
  assertEquals(builtAfter('not-a-date', '2026-09-27T18:20:44Z'), false)
  assertEquals(builtAfter('2026-09-28T00:00:00Z', Date.parse('2026-09-27T18:20:44Z')), true)
})

const decision: UpgradeTickDecision = {
  channel: 'canary',
  targetDaemon: { version: CANARY_VERSION, commit: '86d492d8aa' },
  targetInstance: null,
  daemonDrift: true,
  targetDiffers: true,
  activeRun: null,
  autoStart: {
    decision: 'started',
    runId: 'run-1',
    steps: { total: 5, done: 0, skipped: 1, failed: 0, needsAttention: 0, inProgress: 4 },
  },
}

test('the tick decision reads as one operator line', () => {
  assertEquals(
    formatUpgradeTickDecision(decision),
    `upgrade-tick decision channel=canary daemonTarget=${CANARY_VERSION}@86d492d ` +
      'daemonDrift=true targetDiffers=true activeRun=none ' +
      'autoStart=started run-1 steps=5 done=0 skipped=1 failed=0 attention=0 inProgress=4'
  )
  assertMatch(
    formatUpgradeTickDecision({
      ...decision,
      targetDaemon: null,
      activeRun: { id: 'run-2', status: 'running', phase: 'fleet' },
      autoStart: {
        decision: 'refused',
        error: 'The channel target could not be resolved.',
        blockers: ['The channel target could not be resolved.', 'second'],
      },
    }),
    /daemonTarget=unresolved .*activeRun=run-2:running\/fleet autoStart=refused The channel target could not be resolved\. \(\+1 more\)$/
  )
  assertMatch(
    formatUpgradeTickDecision({ ...decision, autoStart: { decision: 'not-attempted' } }),
    /autoStart=not-attempted$/
  )
})

test('an unchanged tick decision is logged at most once an hour', () => {
  resetUpgradeTickLogForTests()
  const lines: string[] = []
  const log = (line: string) => lines.push(line)
  const quiet = { ...decision, autoStart: { decision: 'not-attempted' as const } }
  traceUpgradeTick(quiet, 0, log)
  traceUpgradeTick(quiet, 15 * 60 * 1000, log)
  assertEquals(lines.length, 1)
  traceUpgradeTick({ ...quiet, daemonDrift: false }, 30 * 60 * 1000, log)
  assertEquals(lines.length, 2)
  traceUpgradeTick(
    { ...quiet, daemonDrift: false },
    30 * 60 * 1000 + UPGRADE_TICK_LOG_REPEAT_MS,
    log
  )
  assertEquals(lines.length, 3)
  resetUpgradeTickLogForTests()
})
