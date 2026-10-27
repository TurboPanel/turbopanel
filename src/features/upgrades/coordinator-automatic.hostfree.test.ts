/**
 * Always-on automatic updates: Pause / Resume, the hourly check, batches,
 * servers that join or come back mid-run, and automatic retry with backoff.
 */
import { assertEquals } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createUpgradeCoordinator, UPGRADE_PAUSED, UPGRADE_RETRY_LATER } from './coordinator.ts'
import { claimUpgradeCheck } from './maintenance.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'
import type { UpgradeRuntime } from './planner.ts'
import type { UpgradeSettings } from '../settings/upgrade-settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const T0 = Date.parse('2026-10-27T10:00:00.000Z')
const HOUR = 60 * 60 * 1000
const COLOCATED = '00000000-0000-4000-8000-000000000000'

const PAUSE = {
  since: '2026-10-27T10:05:00.000Z',
  byUserId: 'user-1',
  byEmail: 'admin@example.test',
  byName: 'Ada Admin',
}

const target = {
  daemon: {
    version: '0.1.21',
    commit: 'new-daemon',
    buildId: 'd1',
    builtAt: '2026-10-27T00:00:00.000Z',
    manifestUrl: 'https://example.test/daemon/manifest.json',
  },
  instance: {
    version: '0.1.21',
    commit: 'new-instance',
    buildId: 'i1',
    builtAt: '2026-10-27T00:00:00.000Z',
    manifestUrl: 'https://example.test/instance/manifest.json',
  },
  ui: {
    version: '0.1.21',
    commit: 'new-ui',
    buildId: 'u1',
    builtAt: '2026-10-27T00:00:00.000Z',
    manifestUrl: 'https://example.test/ui/manifest.json',
  },
}

function host(serverId: string, overrides: Partial<FleetServerFact> = {}): FleetServerFact {
  return {
    serverId,
    name: serverId,
    hostname: `${serverId}.lan`,
    connected: true,
    commit: 'old-daemon',
    version: '0.1.20',
    features: ['managed-upgrade-v1'],
    colocated: false,
    ...overrides,
  }
}

function fleet(
  ids: string[],
  options: {
    runtime?: UpgradeRuntime
    batch?: UpgradeSettings['batch']
    colocated?: FleetServerFact
  } = {}
) {
  let nowMs = T0
  const enqueued: { serverId: string; envelope: DaemonOutboundEnvelope }[] = []
  const facts = ids.map((id) => host(id))
  if (options.colocated) facts.unshift(options.colocated)
  const store = createMemoryUpgradeStore({
    facts,
    latest: target,
    settings: { batch: options.batch ?? { mode: 'percent', value: 100 } },
  })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, envelope })
      return Promise.resolve()
    },
    runtime: options.runtime ?? 'workers',
    channel: 'release',
    development: false,
    now: () => new Date(nowMs).toISOString(),
    colocatedServerId: options.colocated?.serverId ?? null,
    instanceInstalled: { version: '0.1.21', commit: 'new-instance' },
    resolveTarget: () => Promise.resolve(target),
  })
  const stepOf = async (serverId: string) => {
    const run = await coordinator.activeRun()
    return run?.steps.find((step) => step.serverId === serverId)
  }
  return {
    store,
    coordinator,
    enqueued,
    sentTo: () => enqueued.map((item) => item.serverId),
    advance: (ms: number) => {
      nowMs += ms
    },
    at: () => new Date(nowMs).toISOString(),
    stepOf,
    /** The host now runs the target build. */
    reachTarget: (serverId: string) => {
      const fact = store.facts.find((item) => item.serverId === serverId)
      if (fact) fact.commit = 'new-daemon'
    },
    /** The host's daemon reports the install failed. */
    fail: async (serverId: string) => {
      const step = await stepOf(serverId)
      if (!step?.requestId) throw new TypeError(`no dispatched step for ${serverId}`)
      await coordinator.noteOutcome({
        serverId,
        upgradeId: step.upgradeId,
        unit: 'daemon',
        ok: false,
        at: new Date(nowMs).toISOString(),
        error: 'disk full',
        errorCode: 'preflight_disk',
        requestId: step.requestId,
      })
    },
  }
}

test('a check starts an automatic run on its own; nobody presses anything', async () => {
  const f = fleet(['a', 'b'])
  await f.coordinator.tick()
  const run = await f.coordinator.activeRun()
  assertEquals(run?.source, 'auto')
  assertEquals(f.sentTo().sort(), ['a', 'b'])
})

test('the default batch updates every server in one wave', async () => {
  const f = fleet(['a', 'b', 'c', 'd', 'e'])
  await f.coordinator.tick()
  assertEquals(f.sentTo().length, 5)
})

test('a 25% batch rolls out a quarter at a time; the next starts once the last finished or failed', async () => {
  const f = fleet(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], {
    batch: { mode: 'percent', value: 25 },
  })
  await f.coordinator.tick()
  const first = f.sentTo()
  assertEquals(first.length, 2)
  // One finished, one still installing: the next batch waits.
  f.reachTarget(first[0])
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(f.sentTo().length, 2)
  // The other one fails: failed counts as finished for the batch.
  await f.fail(first[1])
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(f.sentTo().length, 4)
})

test('while paused no run starts, and a direct start is refused', async () => {
  const f = fleet(['a'])
  f.store.setPause(PAUSE)
  await f.coordinator.tick()
  assertEquals(await f.coordinator.activeRun(), null)
  assertEquals(f.enqueued.length, 0)
  const started = await f.coordinator.start({ source: 'auto', startedBy: null })
  assertEquals(started.ok, false)
  if (!started.ok) assertEquals(started.error, UPGRADE_PAUSED)
})

test('pausing mid-run finishes the servers already updating, then stops the run', async () => {
  const f = fleet(['a', 'b', 'c', 'd'], { batch: { mode: 'count', value: 1 } })
  await f.coordinator.tick()
  assertEquals(f.sentTo(), ['a'])
  const runId = (await f.coordinator.activeRun())?.id ?? ''

  f.store.setPause(PAUSE)
  await f.coordinator.tick({ resolveManifests: false })
  // a is still installing; b, c, d were never sent and are settled.
  assertEquals((await f.stepOf('a'))?.status, 'dispatched')
  for (const id of ['b', 'c', 'd']) {
    const step = await f.stepOf(id)
    assertEquals(step?.status, 'skipped')
    assertEquals(step?.errorCode, 'updates_paused')
  }
  assertEquals(f.sentTo(), ['a'])

  f.reachTarget('a')
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(await f.coordinator.activeRun(), null)
  const ended = await f.coordinator.run(runId)
  assertEquals(ended?.status, 'cancelled')
  assertEquals(ended?.error, 'updates_paused')
  assertEquals(f.sentTo(), ['a'])
})

test('resume lets the next check start a run for the servers the pause held back', async () => {
  const f = fleet(['a', 'b'], { batch: { mode: 'count', value: 1 } })
  await f.coordinator.tick()
  f.store.setPause(PAUSE)
  f.reachTarget('a')
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(await f.coordinator.activeRun(), null)

  // Still paused: the check sees b behind but starts nothing.
  await f.coordinator.tick()
  assertEquals(await f.coordinator.activeRun(), null)

  f.store.setPause(null)
  await f.coordinator.tick()
  const run = await f.coordinator.activeRun()
  assertEquals(run?.steps.find((step) => step.serverId === 'b')?.status, 'dispatched')
  assertEquals(f.sentTo(), ['a', 'b'])
})

test('a server added during a run is picked up by the next check after it ends', async () => {
  const f = fleet(['a'])
  await f.coordinator.tick()
  f.store.facts.push(host('late'))
  // The run in progress is never replaced and the late server waits.
  await f.coordinator.tick()
  assertEquals(f.sentTo(), ['a'])
  f.reachTarget('a')
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(await f.coordinator.activeRun(), null)

  await f.coordinator.tick()
  assertEquals(f.sentTo(), ['a', 'late'])
})

test('a server that was offline at the start updates on the first check after it reconnects', async () => {
  const f = fleet(['a', 'b'])
  const b = f.store.facts.find((fact) => fact.serverId === 'b')
  if (b) b.connected = false
  await f.coordinator.tick()
  assertEquals((await f.stepOf('b'))?.errorCode, 'server_offline')
  f.reachTarget('a')
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(await f.coordinator.activeRun(), null)

  if (b) b.connected = true
  await f.coordinator.tick()
  assertEquals(f.sentTo(), ['a', 'b'])
})

test('nothing behind writes no run at all', async () => {
  const f = fleet(['a'])
  f.reachTarget('a')
  await f.coordinator.tick()
  assertEquals(await f.coordinator.activeRun(), null)
  assertEquals((await f.store.history(0, 10)).total, 0)
})

test('a failed server is retried automatically, with a backoff that doubles', async () => {
  const f = fleet(['a'])
  await f.coordinator.tick()
  await f.fail('a')
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(await f.coordinator.activeRun(), null)
  assertEquals((await f.store.history(0, 10)).total, 1)

  // Right away: inside the one-hour backoff, so no run (and no history row).
  await f.coordinator.tick()
  assertEquals(await f.coordinator.activeRun(), null)
  assertEquals((await f.store.history(0, 10)).total, 1)
  assertEquals(f.enqueued.length, 1)

  // An hour later the next check tries again.
  f.advance(HOUR + 60_000)
  await f.coordinator.tick()
  assertEquals(f.enqueued.length, 2)
  await f.fail('a')
  await f.coordinator.tick({ resolveManifests: false })

  // Second failure: two hours this time.
  f.advance(HOUR + 60_000)
  await f.coordinator.tick()
  assertEquals(f.enqueued.length, 2)
  f.advance(HOUR)
  await f.coordinator.tick()
  assertEquals(f.enqueued.length, 3)
})

test('a server in backoff is skipped with retry_later while the others update', async () => {
  const f = fleet(['a', 'b'])
  await f.coordinator.tick()
  await f.fail('a')
  f.reachTarget('b')
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(await f.coordinator.activeRun(), null)

  // b falls behind again (a new host build is published for it to take).
  const b = f.store.facts.find((fact) => fact.serverId === 'b')
  if (b) b.commit = 'old-daemon'
  await f.coordinator.tick()
  const step = await f.stepOf('a')
  assertEquals(step?.status, 'skipped')
  assertEquals(step?.errorCode, 'retry_later')
  assertEquals(step?.errorMessage?.includes('tries again automatically after'), true)
  assertEquals((await f.stepOf('b'))?.status, 'dispatched')
})

test('a control plane host in backoff holds the whole run until it may retry', async () => {
  const colocated = host(COLOCATED, { colocated: true })
  const f = fleet(['a'], { runtime: 'deno', colocated })
  await f.coordinator.tick()
  await f.fail(COLOCATED)
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(await f.coordinator.activeRun(), null)
  const started = await f.coordinator.start({ source: 'auto', startedBy: null })
  assertEquals(started.ok, false)
  if (!started.ok) assertEquals(started.error, UPGRADE_RETRY_LATER)
  f.advance(HOUR + 60_000)
  const again = await f.coordinator.start({ source: 'auto', startedBy: null })
  assertEquals(again.ok, true)
})

test('the hourly check runs once per slot and records itself first', async () => {
  const store = createMemoryUpgradeStore({ checkMinute: 17 })
  const created = new Date('2026-10-27T09:40:00.000Z')
  assertEquals(await claimUpgradeCheck(store, created), false)
  assertEquals(await claimUpgradeCheck(store, new Date('2026-10-27T10:16:00.000Z')), false)
  assertEquals(await claimUpgradeCheck(store, new Date('2026-10-27T10:17:00.000Z')), true)
  assertEquals(await claimUpgradeCheck(store, new Date('2026-10-27T10:18:00.000Z')), false)
  assertEquals(await claimUpgradeCheck(store, new Date('2026-10-27T11:16:59.000Z')), false)
  assertEquals(await claimUpgradeCheck(store, new Date('2026-10-27T11:17:30.000Z')), true)
  const schedule = await store.checkSchedule('2026-10-27T11:18:00.000Z')
  assertEquals(schedule.lastCheckAt, '2026-10-27T11:17:30.000Z')
})

test('a test install with TURBOPANEL_UPGRADE_CHECK_MINUTES=5 checks every 5 minutes', async () => {
  const store = createMemoryUpgradeStore({ checkMinute: 17 })
  assertEquals(await claimUpgradeCheck(store, new Date('2026-10-27T09:40:00.000Z'), 5), false)
  assertEquals(await claimUpgradeCheck(store, new Date('2026-10-27T09:42:00.000Z'), 5), true)
  assertEquals(await claimUpgradeCheck(store, new Date('2026-10-27T09:44:00.000Z'), 5), false)
  assertEquals(await claimUpgradeCheck(store, new Date('2026-10-27T09:47:00.000Z'), 5), true)
})

test('a new web interface build alone starts a self-hosted run that installs it, then nothing is waiting', async () => {
  const colocated = host(COLOCATED, { colocated: true, commit: 'new-daemon' })
  const f = fleet([], { runtime: 'deno', colocated })
  await f.store.recordInstalledUi({ commit: 'old-ui', source: 'install', at: f.at() })
  await f.coordinator.tick()
  const run = await f.coordinator.activeRun()
  const step = run?.steps.find((item) => item.unit === 'instance')
  assertEquals(step?.status, 'dispatched')
  assertEquals(f.enqueued.at(-1)?.envelope.kind, 'instance-update')
  if (!step?.requestId) throw new TypeError('expected a dispatched control-plane step')
  await f.coordinator.noteOutcome({
    serverId: COLOCATED,
    upgradeId: step.upgradeId,
    unit: 'instance',
    ok: true,
    at: f.at(),
    requestId: step.requestId,
  })
  assertEquals(await f.store.installedUi(), 'new-ui')
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(await f.coordinator.activeRun(), null)
  const sent = f.enqueued.length
  await f.coordinator.tick()
  assertEquals(await f.coordinator.activeRun(), null)
  assertEquals(f.enqueued.length, sent)
})

test('a console report never replaces a recorded install, so a stale tab cannot reopen a run', async () => {
  const store = createMemoryUpgradeStore()
  await store.recordInstalledUi({
    commit: 'first',
    source: 'console',
    at: '2026-10-27T10:00:00.000Z',
  })
  await store.recordInstalledUi({
    commit: 'second',
    source: 'console',
    at: '2026-10-27T10:01:00.000Z',
  })
  assertEquals(await store.installedUi(), 'second')
  await store.recordInstalledUi({
    commit: 'installed',
    source: 'install',
    at: '2026-10-27T10:02:00.000Z',
  })
  await store.recordInstalledUi({
    commit: 'stale-tab',
    source: 'console',
    at: '2026-10-27T10:03:00.000Z',
  })
  assertEquals(await store.installedUi(), 'installed')
})

test('the hosted control plane never opens a run for a web interface build', async () => {
  const f = fleet(['a'])
  f.reachTarget('a')
  await f.store.recordInstalledUi({ commit: 'old-ui', source: 'install', at: f.at() })
  await f.coordinator.tick()
  assertEquals(await f.coordinator.activeRun(), null)
  assertEquals(f.enqueued.length, 0)
})

test('a pause that lands after every server was sent leaves the run its real outcome', async () => {
  const f = fleet(['a', 'b'])
  await f.coordinator.tick()
  assertEquals(f.sentTo().sort(), ['a', 'b'])
  const runId = (await f.coordinator.activeRun())?.id ?? ''
  f.store.setPause(PAUSE)
  f.reachTarget('a')
  f.reachTarget('b')
  await f.coordinator.tick({ resolveManifests: false })
  const ended = await f.coordinator.run(runId)
  // Nothing was held back, so the run is not reported as stopped.
  assertEquals(ended?.status, 'succeeded')
  assertEquals(ended?.error, null)
})
