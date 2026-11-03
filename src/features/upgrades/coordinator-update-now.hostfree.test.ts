/**
 * Update Now: the hourly check, run at once by an administrator. It starts the
 * run through `start()` (same preflight, order and fleet gate), refuses while
 * a run is open or updates are paused, and stays single-flight against a
 * second press and the hourly check.
 */
import { assertEquals } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import {
  createUpgradeCoordinator,
  UPGRADE_DEVELOPMENT,
  UPGRADE_PAUSED,
  UPGRADE_RETRY_LATER,
  UPGRADE_RUN_ACTIVE,
  type UpgradeUpdateNowResult,
} from './coordinator.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'
import type { UpgradeTarget } from './target.ts'
import type { UpgradeRuntime } from './planner.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const T0 = Date.parse('2026-11-03T10:00:00.000Z')
const HOUR = 60 * 60 * 1000
const COLOCATED = '00000000-0000-4000-8000-000000000000'
const ADMIN = '11111111-1111-4111-8111-111111111111'

function build(commit: string): NonNullable<UpgradeTarget['daemon']> {
  return {
    version: '0.1.22',
    commit,
    buildId: commit,
    builtAt: '2026-11-03T00:00:00.000Z',
    manifestUrl: `https://example.test/${commit}/manifest.json`,
  }
}

const fresh: UpgradeTarget = {
  daemon: build('new-daemon'),
  instance: build('new-instance'),
  ui: build('new-ui'),
}

function host(serverId: string, overrides: Partial<FleetServerFact> = {}): FleetServerFact {
  return {
    serverId,
    name: serverId,
    hostname: `${serverId}.lan`,
    connected: true,
    commit: 'old-daemon',
    version: '0.1.21',
    features: ['managed-upgrade-v1'],
    colocated: false,
    ...overrides,
  }
}

function setup(
  ids: string[],
  options: { runtime?: UpgradeRuntime; colocated?: boolean; development?: boolean } = {}
) {
  let nowMs = T0
  let resolves = 0
  const enqueued: { serverId: string; envelope: DaemonOutboundEnvelope }[] = []
  const facts = ids.map((id) => host(id))
  if (options.colocated) facts.unshift(host(COLOCATED, { colocated: true }))
  // The saved build is older than what the release servers answer now:
  // Update Now must act on the fresh one.
  const store = createMemoryUpgradeStore({
    facts,
    latest: { daemon: build('older-daemon'), instance: null, ui: null },
    installedUi: { commit: 'new-ui', source: 'install', at: '2026-11-03T00:00:00.000Z' },
  })
  let created = 0
  const insertRun = store.insertRun
  store.insertRun = async (run, steps) => {
    const outcome = await insertRun(run, steps)
    if (outcome === 'created') created += 1
    return outcome
  }
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, envelope })
      return Promise.resolve()
    },
    runtime: options.runtime ?? 'workers',
    channel: 'release',
    development: options.development ?? false,
    now: () => new Date(nowMs).toISOString(),
    colocatedServerId: options.colocated ? COLOCATED : null,
    instanceInstalled: { version: '0.1.22', commit: 'new-instance' },
    resolveTarget: () => {
      resolves += 1
      return Promise.resolve(fresh)
    },
  })
  return {
    store,
    coordinator,
    sentTo: () => enqueued.map((item) => item.serverId),
    resolves: () => resolves,
    runsCreated: () => created,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

function runIdOf(result: UpgradeUpdateNowResult): string {
  if (!result.ok || !('runId' in result)) throw new TypeError(JSON.stringify(result))
  return result.runId
}

test('Update Now starts a run at once when a server is behind', async () => {
  const f = setup(['a', 'b'])
  const result = await f.coordinator.updateNow({ startedBy: ADMIN })
  const runId = runIdOf(result)
  const run = await f.coordinator.activeRun()
  assertEquals(run?.id, runId)
  // A person pressed it: history reads it as manual, with who.
  assertEquals(run?.source, 'manual')
  assertEquals(run?.startedBy, ADMIN)
  assertEquals(f.sentTo().sort(), ['a', 'b'])
  // The fresh target is saved and the run targets it.
  assertEquals((await f.store.latestBuild())?.daemon?.commit, 'new-daemon')
  assertEquals(run?.target.daemon?.commit, 'new-daemon')
})

test('Update Now keeps the safe order: co-located daemon first, fleet behind the gate', async () => {
  const f = setup(['a'], { runtime: 'deno', colocated: true })
  runIdOf(await f.coordinator.updateNow({ startedBy: ADMIN }))
  const run = await f.coordinator.activeRun()
  assertEquals(
    run?.steps.map((step) => step.phase),
    ['colocated_daemon', 'control_plane', 'fleet']
  )
  // The control plane already runs the target, so only the daemon is sent;
  // the fleet phase stays shut until the co-located daemon is on target.
  assertEquals(f.sentTo(), [COLOCATED])
})

test('Update Now answers up to date and saves no run when nothing is behind', async () => {
  const f = setup(['a'])
  for (const fact of f.store.facts) fact.commit = 'new-daemon'
  assertEquals(await f.coordinator.updateNow({ startedBy: ADMIN }), { ok: true, upToDate: true })
  assertEquals(await f.coordinator.activeRun(), null)
  assertEquals(f.sentTo(), [])
  // It still saved what the release servers answered.
  assertEquals((await f.store.latestBuild())?.daemon?.commit, 'new-daemon')
})

test('Update Now refuses while a run is open, before asking the release servers', async () => {
  const f = setup(['a'])
  const first = runIdOf(await f.coordinator.updateNow({ startedBy: ADMIN }))
  const before = f.resolves()
  const again = await f.coordinator.updateNow({ startedBy: ADMIN })
  assertEquals(again.ok, false)
  if (!again.ok) {
    assertEquals(again.error, UPGRADE_RUN_ACTIVE)
    assertEquals(again.activeRunId, first)
  }
  assertEquals(f.resolves(), before)
})

test('Update Now refuses while updates are paused', async () => {
  const f = setup(['a'])
  f.store.setPause({
    since: '2026-11-03T09:00:00.000Z',
    byUserId: null,
    byEmail: null,
    byName: null,
  })
  const result = await f.coordinator.updateNow({ startedBy: ADMIN })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error, UPGRADE_PAUSED)
  assertEquals(f.resolves(), 0)
  assertEquals(await f.coordinator.activeRun(), null)
})

test('Update Now refuses on a development install', async () => {
  const f = setup(['a'], { runtime: 'deno', colocated: true, development: true })
  const result = await f.coordinator.updateNow({ startedBy: ADMIN })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error, UPGRADE_DEVELOPMENT)
  assertEquals(f.resolves(), 0)
  assertEquals(f.sentTo(), [])
})

test('two presses at once open one run; the other answers run active', async () => {
  const f = setup(['a', 'b'])
  const results = await Promise.all([
    f.coordinator.updateNow({ startedBy: ADMIN }),
    f.coordinator.updateNow({ startedBy: ADMIN }),
  ])
  const started = results.filter((result) => result.ok && 'runId' in result)
  const refused = results.filter((result) => !result.ok)
  assertEquals(started.length, 1)
  assertEquals(refused.length, 1)
  const loser = refused[0]
  if (loser && !loser.ok) assertEquals(loser.error, UPGRADE_RUN_ACTIVE)
  assertEquals(f.runsCreated(), 1)
  // Each server was sent the update once.
  assertEquals(f.sentTo().sort(), ['a', 'b'])
})

test('a press and the hourly check at the same moment open one run', async () => {
  const f = setup(['a'])
  const [now] = await Promise.all([
    f.coordinator.updateNow({ startedBy: ADMIN }),
    f.coordinator.tick({ resolveManifests: true }),
  ])
  const run = await f.coordinator.activeRun()
  assertEquals(f.runsCreated(), 1)
  if (now.ok && 'runId' in now) assertEquals(run?.id, now.runId)
  else assertEquals(now.ok ? null : now.error, UPGRADE_RUN_ACTIVE)
  assertEquals(f.sentTo(), ['a'])
})

test('Update Now keeps the retry backoff for a control plane host that just failed', async () => {
  const f = setup(['a'], { runtime: 'deno', colocated: true })
  runIdOf(await f.coordinator.updateNow({ startedBy: ADMIN }))
  const step = (await f.coordinator.activeRun())?.steps.find((s) => s.serverId === COLOCATED)
  await f.coordinator.noteOutcome({
    serverId: COLOCATED,
    upgradeId: step?.upgradeId,
    unit: 'daemon',
    ok: false,
    at: new Date(T0).toISOString(),
    error: 'disk full',
    errorCode: 'preflight_disk',
    requestId: step?.requestId ?? '',
  })
  await f.coordinator.tick({ resolveManifests: false })
  assertEquals(await f.coordinator.activeRun(), null)
  const refused = await f.coordinator.updateNow({ startedBy: ADMIN })
  assertEquals(refused.ok, false)
  if (!refused.ok) assertEquals(refused.error, UPGRADE_RETRY_LATER)
  f.advance(HOUR + 60_000)
  runIdOf(await f.coordinator.updateNow({ startedBy: ADMIN }))
})
