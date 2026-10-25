import { assertEquals } from '@std/assert'
import { createUpgradeCoordinator } from './coordinator.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'

const test = Deno.test.bind(Deno)

const SERVER = '11111111-1111-4111-8111-111111111111'

const build = (version: string, commit: string) => ({
  version,
  commit,
  buildId: commit,
  builtAt: '2026-09-24T00:00:00.000Z',
  manifestUrl: 'https://example.test/manifest.json',
})

const target = {
  daemon: build('0.1.19-canary.3', 'daemon-3'),
  instance: build('0.1.19-canary.3', 'instance-3'),
  ui: build('0.1.19-canary.3', 'ui-3'),
}

const daemonFact: FleetServerFact = {
  serverId: SERVER,
  name: 'panel',
  hostname: 'panel.example',
  connected: true,
  commit: 'daemon-2',
  version: '0.1.19',
  features: ['managed-upgrade-v1'],
  colocated: true,
}

async function startRun(buildLabel: string | null) {
  const store = createMemoryUpgradeStore({ facts: [daemonFact], latest: target })
  // An earlier run targeted the daemon build that is now installed.
  const earlier = createUpgradeCoordinator({
    store,
    enqueue: () => Promise.resolve(),
    runtime: 'deno',
    channel: 'canary',
    development: false,
    now: () => '2026-09-23T12:00:00.000Z',
    colocatedServerId: SERVER,
    instanceInstalled: { version: '0.1.19', commit: 'instance-1' },
    resolveTarget: () =>
      Promise.resolve({ ...target, daemon: build('0.1.19-canary.2', 'daemon-2') }),
  })
  const first = await earlier.start({ source: 'manual', startedBy: null })
  if (!first.ok) throw new TypeError(first.error)
  const run = await store.runById(first.runId)
  if (run)
    await store.saveRun({ ...run, status: 'succeeded', finishedAt: '2026-09-23T13:00:00.000Z' })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: () => Promise.resolve(),
    runtime: 'deno',
    channel: 'canary',
    development: false,
    now: () => '2026-09-24T12:00:00.000Z',
    colocatedServerId: SERVER,
    instanceInstalled: { version: '0.1.19', commit: 'instance-2' },
    buildLabel,
    resolveTarget: () => Promise.resolve(target),
  })
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  return store.stepsFor(started.runId)
}

test('steps record the running build label, not the plain release number', async () => {
  const steps = await startRun('0.1.19-canary.2')
  const daemon = steps.find((step) => step.unit === 'daemon')
  const instance = steps.find((step) => step.unit === 'instance')
  assertEquals(daemon?.fromVersion, '0.1.19-canary.2')
  assertEquals(daemon?.toVersion, '0.1.19-canary.3')
  assertEquals(instance?.fromVersion, '0.1.19-canary.2')
  assertEquals(instance?.toVersion, '0.1.19-canary.3')
})

test('control-plane step falls back to the installed number without a label', async () => {
  const steps = await startRun(null)
  assertEquals(steps.find((step) => step.unit === 'instance')?.fromVersion, '0.1.19')
})
