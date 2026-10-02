import { assertEquals } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createUpgradeCoordinator } from './coordinator.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'
import { UPGRADE_STEP_MAX_ATTEMPTS } from './transitions.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '11111111-1111-4111-8111-111111111111'

function fact(serverId: string): FleetServerFact {
  return {
    serverId,
    name: 'panel',
    hostname: 'panel.example',
    connected: true,
    commit: 'old-daemon',
    version: '0.1.0',
    features: ['managed-upgrade-v1'],
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

function harness(failFor: (serverId: string) => boolean) {
  const attempts: string[] = []
  const delivered: string[] = []
  const clock = { ms: Date.parse('2026-09-24T12:00:00.000Z') }
  const store = createMemoryUpgradeStore({
    facts: [fact(SERVER)],
    latest: target,
  })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId: string, envelope: DaemonOutboundEnvelope) => {
      attempts.push(serverId)
      if (failFor(serverId)) return Promise.reject(new Error('cell unavailable'))
      void envelope
      delivered.push(serverId)
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'release',
    development: false,
    now: () => new Date(clock.ms).toISOString(),
    colocatedServerId: SERVER,
    instanceInstalled: { version: '0.1.0', commit: 'old-instance' },
    resolveTarget: () => Promise.resolve(target),
  })
  return { coordinator, attempts, delivered, clock }
}

/** The step on the active run, or on the run that just ended (a failed platform step ends it). */
async function stepOf(coordinator: ReturnType<typeof harness>['coordinator'], serverId: string) {
  const run = (await coordinator.activeRun()) ?? (await coordinator.lastRun())
  return run?.steps.find((step) => step.serverId === serverId)
}

test('a dispatch that cannot be delivered becomes a visible retry, not a silent hang', async () => {
  const { coordinator } = harness((id) => id === SERVER)
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  const step = await stepOf(coordinator, SERVER)
  assertEquals(step?.status, 'pending')
  assertEquals(step?.attempts, 1)
  assertEquals(step?.errorMessage?.includes('could not be delivered'), true)
  assertEquals(step?.errorMessage?.includes('cell unavailable'), true)
  assertEquals(typeof step?.nextAttemptAt, 'string')
})

test('after the last allowed attempt the step needs attention with a dispatch_failed reason', async () => {
  const { coordinator, clock } = harness((id) => id === SERVER)
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  for (let attempt = 1; attempt < UPGRADE_STEP_MAX_ATTEMPTS; attempt += 1) {
    clock.ms += 31 * 60 * 1000
    await coordinator.tick({ resolveManifests: false })
  }
  const step = await stepOf(coordinator, SERVER)
  assertEquals(step?.status, 'needs_attention')
  assertEquals(step?.errorCode, 'dispatch_failed')
  assertEquals(step?.attempts, UPGRADE_STEP_MAX_ATTEMPTS)
  assertEquals(step?.errorMessage?.includes('cell unavailable'), true)
  // The co-located daemon step is a platform step: the run ends with it.
  assertEquals(await coordinator.activeRun(), null)
  assertEquals((await coordinator.lastRun())?.error, 'colocated_daemon_failed')
})

test('a later successful delivery clears the failure message', async () => {
  let broken = true
  const { coordinator, clock, delivered } = harness(() => broken)
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  assertEquals((await stepOf(coordinator, SERVER))?.status, 'pending')
  broken = false
  clock.ms += 31 * 60 * 1000
  await coordinator.tick({ resolveManifests: false })
  const step = await stepOf(coordinator, SERVER)
  assertEquals(step?.status, 'dispatched')
  assertEquals(step?.errorMessage, null)
  assertEquals(delivered.includes(SERVER), true)
})
