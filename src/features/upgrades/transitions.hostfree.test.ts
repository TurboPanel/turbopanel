import { assertEquals } from '@std/assert'
import {
  computeBackoffMs,
  isInFlightStepStatus,
  isSettledStepStatus,
  parseUpgradeVerifyTimeoutMs,
  planStepAction,
  type StepConfig,
  type StepFacts,
  type StepView,
  UPGRADE_BACKOFF_BASE_MS,
  UPGRADE_BACKOFF_MAX_MS,
  UPGRADE_VERIFY_TIMEOUT_MS,
} from './transitions.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = '2026-01-01T12:00:00.000Z'

function step(overrides: Partial<StepView> = {}): StepView {
  return {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastStageAt: null,
    toCommit: 'target-sha',
    ...overrides,
  }
}

function facts(overrides: Partial<StepFacts> = {}): StepFacts {
  return { serverConnected: true, currentCommit: null, ...overrides }
}

const cfg: StepConfig = { now: NOW }

test('settled steps are left alone', () => {
  for (const status of ['done', 'skipped', 'failed', 'needs_attention'] as const) {
    assertEquals(planStepAction(step({ status }), facts(), cfg).kind, 'none')
  }
})

test('a matching current commit marks the step done', () => {
  const action = planStepAction(
    step({ status: 'installing' }),
    facts({ currentCommit: 'target-sha' }),
    cfg
  )
  assertEquals(action.kind, 'done')
})

test('pending + connected + no backoff → dispatch', () => {
  assertEquals(planStepAction(step(), facts(), cfg).kind, 'dispatch')
})

test('pending + offline → waiting (self-heal on reconnect)', () => {
  assertEquals(planStepAction(step(), facts({ serverConnected: false }), cfg).kind, 'wait_offline')
})

test('pending with a future backoff waits without dispatching', () => {
  const future = new Date(Date.parse(NOW) + 60_000).toISOString()
  assertEquals(
    planStepAction(step({ status: 'waiting', nextAttemptAt: future }), facts(), cfg).kind,
    'none'
  )
  const past = new Date(Date.parse(NOW) - 60_000).toISOString()
  assertEquals(
    planStepAction(step({ status: 'waiting', nextAttemptAt: past }), facts(), cfg).kind,
    'dispatch'
  )
})

test('in-flight and offline → waiting so it re-dispatches on reconnect', () => {
  assertEquals(
    planStepAction(step({ status: 'downloading' }), facts({ serverConnected: false }), cfg).kind,
    'wait_offline'
  )
})

test('in-flight and not stalled → none', () => {
  const recent = new Date(Date.parse(NOW) - 60_000).toISOString()
  assertEquals(
    planStepAction(step({ status: 'installing', lastStageAt: recent }), facts(), cfg).kind,
    'none'
  )
})

test('stalled install retries with backoff until attempts are exhausted', () => {
  const stale = new Date(Date.parse(NOW) - 30 * 60 * 1000).toISOString()
  const retry = planStepAction(
    step({ status: 'installing', lastStageAt: stale, attempts: 1 }),
    facts(),
    cfg
  )
  assertEquals(retry.kind, 'retry')
  if (retry.kind !== 'retry') throw new TypeError('expected a retry action')
  assertEquals(
    retry.nextAttemptAt,
    new Date(Date.parse(NOW) + UPGRADE_BACKOFF_BASE_MS).toISOString()
  )

  const exhausted = planStepAction(
    step({ status: 'installing', lastStageAt: stale, attempts: 3 }),
    facts(),
    cfg
  )
  assertEquals(exhausted.kind, 'needs_attention')
  if (exhausted.kind !== 'needs_attention') {
    throw new TypeError('expected needs_attention')
  }
  assertEquals(exhausted.errorCode, 'step_timeout')
})

test('rolled_back retries once then needs attention', () => {
  assertEquals(
    planStepAction(step({ status: 'rolled_back', attempts: 1 }), facts(), cfg).kind,
    'dispatch'
  )
  const attention = planStepAction(step({ status: 'rolled_back', attempts: 2 }), facts(), cfg)
  assertEquals(attention.kind, 'needs_attention')
  if (attention.kind !== 'needs_attention') {
    throw new TypeError('expected needs_attention')
  }
  assertEquals(attention.errorCode, 'rolled_back')
})

test('rolled_back while offline waits instead of dispatching', () => {
  assertEquals(
    planStepAction(
      step({ status: 'rolled_back', attempts: 1 }),
      facts({ serverConnected: false }),
      cfg
    ).kind,
    'wait_offline'
  )
})

const HOUR_MS = 60 * 60 * 1000

function hoursBefore(iso: string, hours: number): string {
  return new Date(Date.parse(iso) - hours * HOUR_MS).toISOString()
}

function minutesBefore(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60 * 1000).toISOString()
}

test('a fleet step still offline past the deadline is skipped', () => {
  const action = planStepAction(
    step({ status: 'waiting', phase: 'fleet', lastStageAt: minutesBefore(NOW, 16) }),
    facts({ serverConnected: false }),
    cfg
  )
  assertEquals(action, { kind: 'skip_offline' })
})

test('a colocated daemon step still offline past the deadline needs attention', () => {
  const action = planStepAction(
    step({
      status: 'waiting',
      phase: 'colocated_daemon',
      lastStageAt: minutesBefore(NOW, 16),
    }),
    facts({ serverConnected: false }),
    cfg
  )
  assertEquals(action, { kind: 'needs_attention', errorCode: 'server_offline' })
})

test('a control-plane step still offline past the deadline needs attention', () => {
  const action = planStepAction(
    step({
      status: 'waiting',
      phase: 'control_plane',
      lastStageAt: minutesBefore(NOW, 16),
    }),
    facts({ serverConnected: false }),
    cfg
  )
  assertEquals(action, { kind: 'needs_attention', errorCode: 'server_offline' })
})

test('a step with no phase still offline past the deadline needs attention', () => {
  const action = planStepAction(
    step({ status: 'waiting', lastStageAt: hoursBefore(NOW, 2) }),
    facts({ serverConnected: false }),
    cfg
  )
  assertEquals(action, { kind: 'needs_attention', errorCode: 'server_offline' })
})

test('a waiting step inside the offline deadline keeps waiting', () => {
  const action = planStepAction(
    step({
      status: 'waiting',
      lastStageAt: new Date(Date.parse(NOW) - 10 * 60 * 1000).toISOString(),
    }),
    facts({ serverConnected: false }),
    cfg
  )
  assertEquals(action.kind, 'wait_offline')
})

test('a later-batch step that first finds its server offline waits, whatever its row age', () => {
  const action = planStepAction(
    step({ status: 'pending', lastStageAt: hoursBefore(NOW, 48) }),
    facts({ serverConnected: false }),
    cfg
  )
  assertEquals(action.kind, 'wait_offline')
})

test('the offline deadline is configurable', () => {
  const action = planStepAction(
    step({
      status: 'waiting',
      lastStageAt: new Date(Date.parse(NOW) - 5 * 60 * 1000).toISOString(),
    }),
    facts({ serverConnected: false }),
    { now: NOW, offlineDeadlineMs: 60 * 1000 }
  )
  assertEquals(action, { kind: 'needs_attention', errorCode: 'server_offline' })
  assertEquals(
    planStepAction(
      step({
        phase: 'fleet',
        status: 'waiting',
        lastStageAt: new Date(Date.parse(NOW) - 5 * 60 * 1000).toISOString(),
      }),
      facts({ serverConnected: false }),
      { now: NOW, offlineDeadlineMs: 60 * 1000 }
    ),
    { kind: 'skip_offline' }
  )
})

test('a server back online before the deadline is dispatched', () => {
  const action = planStepAction(
    step({ status: 'waiting', lastStageAt: hoursBefore(NOW, 2) }),
    facts({ serverConnected: true }),
    cfg
  )
  assertEquals(action.kind, 'dispatch')
})

test('computeBackoffMs doubles per attempt and caps', () => {
  assertEquals(computeBackoffMs(1), UPGRADE_BACKOFF_BASE_MS)
  assertEquals(computeBackoffMs(2), UPGRADE_BACKOFF_BASE_MS * 2)
  assertEquals(computeBackoffMs(3), UPGRADE_BACKOFF_BASE_MS * 4)
  assertEquals(computeBackoffMs(99), UPGRADE_BACKOFF_MAX_MS)
})

test('status classifiers', () => {
  assertEquals(isSettledStepStatus('done'), true)
  assertEquals(isSettledStepStatus('rolled_back'), false)
  assertEquals(isInFlightStepStatus('downloading'), true)
  assertEquals(isInFlightStepStatus('pending'), false)
})

test('a dispatched step the daemon never answers retries after the ack timeout, then needs attention', () => {
  const minutesAgo = (minutes: number) =>
    new Date(Date.parse(NOW) - minutes * 60 * 1000).toISOString()
  assertEquals(
    planStepAction(
      step({ status: 'dispatched', lastStageAt: minutesAgo(4), attempts: 1 }),
      facts(),
      cfg
    ).kind,
    'none'
  )
  assertEquals(
    planStepAction(
      step({ status: 'dispatched', lastStageAt: minutesAgo(6), attempts: 1 }),
      facts(),
      cfg
    ).kind,
    'retry'
  )
  const exhausted = planStepAction(
    step({ status: 'dispatched', lastStageAt: minutesAgo(6), attempts: 3 }),
    facts(),
    cfg
  )
  assertEquals(exhausted, { kind: 'needs_attention', errorCode: 'step_timeout' })
  // A step that reported a stage keeps the long install timeout.
  assertEquals(
    planStepAction(
      step({ status: 'verifying', lastStageAt: minutesAgo(6), attempts: 1 }),
      facts(),
      cfg
    ).kind,
    'none'
  )
})

test('a dispatch the busy daemon refused keeps the install window, then needs attention without a retry', () => {
  const at = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60 * 1000).toISOString()
  const refused = (minutes: number) =>
    step({
      status: 'dispatched',
      lastStageAt: at(minutes),
      attempts: 1,
      inProgressRefused: true,
    })
  assertEquals(planStepAction(refused(6), facts(), cfg).kind, 'none')
  assertEquals(planStepAction(refused(16), facts(), cfg), {
    kind: 'needs_attention',
    errorCode: 'step_timeout',
  })
})

function minutesAgo(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60 * 1000).toISOString()
}

test('a restarted control-plane step waits out the verify window without a retry', () => {
  for (const status of ['restarting', 'verifying'] as const) {
    const quiet = step({ unit: 'instance', status, lastStageAt: minutesAgo(16), attempts: 1 })
    assertEquals(planStepAction(quiet, facts(), cfg).kind, 'none')
    const past = step({ unit: 'instance', status, lastStageAt: minutesAgo(21), attempts: 1 })
    assertEquals(planStepAction(past, facts(), cfg), {
      kind: 'needs_attention',
      errorCode: 'verify_timeout',
    })
  }
})

test('the verify window is configurable and only applies to the control plane', () => {
  const long = { ...cfg, verifyTimeoutMs: 45 * 60 * 1000 }
  const verifying = step({ unit: 'instance', status: 'verifying', lastStageAt: minutesAgo(30) })
  assertEquals(planStepAction(verifying, facts(), long).kind, 'none')
  // A daemon step keeps the ordinary stall retry.
  const daemon = step({ unit: 'daemon', status: 'verifying', lastStageAt: minutesAgo(16) })
  assertEquals(planStepAction(daemon, facts(), cfg).kind, 'retry')
  // So does a control-plane step that never reached its restart.
  const installing = step({ unit: 'instance', status: 'installing', lastStageAt: minutesAgo(16) })
  assertEquals(planStepAction(installing, facts(), cfg).kind, 'retry')
})

test('parseUpgradeVerifyTimeoutMs reads whole minutes within 5..180', () => {
  assertEquals(UPGRADE_VERIFY_TIMEOUT_MS, 20 * 60 * 1000)
  assertEquals(parseUpgradeVerifyTimeoutMs(undefined), UPGRADE_VERIFY_TIMEOUT_MS)
  assertEquals(parseUpgradeVerifyTimeoutMs(''), UPGRADE_VERIFY_TIMEOUT_MS)
  assertEquals(parseUpgradeVerifyTimeoutMs(' 45 '), 45 * 60 * 1000)
  assertEquals(parseUpgradeVerifyTimeoutMs('5'), 5 * 60 * 1000)
  assertEquals(parseUpgradeVerifyTimeoutMs('180'), 180 * 60 * 1000)
  for (const junk of ['4', '181', '1.5', '-10', 'ten', '9999']) {
    assertEquals(parseUpgradeVerifyTimeoutMs(junk), UPGRADE_VERIFY_TIMEOUT_MS, junk)
  }
})

test('a restarted control-plane step is not re-dispatched while its daemon reconnects', () => {
  const offline = facts({ serverConnected: false })
  const inside = step({ unit: 'instance', status: 'verifying', lastStageAt: minutesAgo(2) })
  assertEquals(planStepAction(inside, offline, cfg).kind, 'none')
  const past = step({ unit: 'instance', status: 'restarting', lastStageAt: minutesAgo(21) })
  assertEquals(planStepAction(past, offline, cfg), {
    kind: 'needs_attention',
    errorCode: 'verify_timeout',
  })
  // Before the restart an offline host still waits and is re-dispatched.
  const installing = step({ unit: 'instance', status: 'installing', lastStageAt: minutesAgo(2) })
  assertEquals(planStepAction(installing, offline, cfg).kind, 'wait_offline')
})
