import { assertEquals } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createUpgradeCoordinator } from './coordinator.ts'
import { stepSatisfiedByInstalled } from './planner.ts'
import { detailWithPhase } from './decisions.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '22222222-2222-4222-8222-222222222222'

const unit = (name: string, commit: string) => ({
  version: '0.1.1',
  commit,
  buildId: `${name}-1`,
  builtAt: '2026-09-24T00:00:00.000Z',
  manifestUrl: `https://example.test/${name}/manifest.json`,
})

const target = {
  daemon: unit('daemon', 'daemon-current'),
  instance: unit('instance', 'instance-current'),
  ui: unit('ui', 'ui-new'),
}

const currentDaemon: FleetServerFact = {
  serverId: SERVER,
  name: 'panel',
  hostname: 'panel.example',
  connected: true,
  commit: 'daemon-current',
  version: '0.1.1',
  features: ['managed-upgrade-v1'],
  colocated: true,
}

/** A control plane whose binary and daemon are current: only the UI can differ. */
function harness() {
  const sent: DaemonOutboundEnvelope[] = []
  const coordinator = createUpgradeCoordinator({
    store: createMemoryUpgradeStore({ facts: [currentDaemon], latest: target }),
    enqueue: (_serverId: string, envelope: DaemonOutboundEnvelope) => {
      sent.push(envelope)
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'canary',
    development: false,
    now: () => '2026-09-24T12:00:00.000Z',
    colocatedServerId: SERVER,
    instanceInstalled: { version: '0.1.1', commit: 'instance-current' },
    resolveTarget: () => Promise.resolve(target),
  })
  return { coordinator, sent }
}

async function instanceStep(coordinator: ReturnType<typeof harness>['coordinator'], runId: string) {
  const run = await coordinator.run(runId)
  return run?.steps.find((step) => step.unit === 'instance')
}

test('a UI-only change opens the control-plane step and dispatches the install that carries the UI', async () => {
  const { coordinator, sent } = harness()
  const started = await coordinator.start({
    source: 'manual',
    startedBy: null,
    consoleCommit: 'ui-old',
  })
  if (!started.ok) throw new TypeError(started.error)
  const step = await instanceStep(coordinator, started.runId)
  assertEquals(step?.status, 'dispatched')
  const update = sent.find((envelope) => envelope.kind === 'instance-update')
  assertEquals(update?.kind, 'instance-update')
  if (update?.kind === 'instance-update') {
    assertEquals(update.uiManifestUrl, 'https://example.test/ui/manifest.json')
  }
})

test('the control-plane step stays satisfied when the console already runs the UI target', async () => {
  const { coordinator, sent } = harness()
  const started = await coordinator.start({
    source: 'manual',
    startedBy: null,
    consoleCommit: 'ui-new',
  })
  if (!started.ok) throw new TypeError(started.error)
  assertEquals((await instanceStep(coordinator, started.runId))?.status, 'done')
  assertEquals(
    sent.some((envelope) => envelope.kind === 'instance-update'),
    false
  )
})

test('an unknown console build never opens the step', async () => {
  const { coordinator } = harness()
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  assertEquals((await instanceStep(coordinator, started.runId))?.status, 'done')
})

test('the UI-refresh mark survives the way a step is stored', () => {
  assertEquals(detailWithPhase('control_plane', { phase: 'control_plane', uiRefresh: true }), {
    phase: 'control_plane',
    uiRefresh: true,
  })
  assertEquals(detailWithPhase('control_plane', { phase: 'control_plane' }), {
    phase: 'control_plane',
  })
})

test('the control-plane step is satisfied only when the binary is current and the UI is not behind', () => {
  const step = { unit: 'instance' } as Parameters<typeof stepSatisfiedByInstalled>[0]
  const installed = { daemonCommit: null, instanceCommit: 'instance-current' }
  assertEquals(stepSatisfiedByInstalled(step, installed, target), true)
  assertEquals(stepSatisfiedByInstalled(step, { ...installed, uiBehind: false }, target), true)
  assertEquals(stepSatisfiedByInstalled(step, { ...installed, uiBehind: true }, target), false)
  assertEquals(
    stepSatisfiedByInstalled(step, { ...installed, instanceCommit: 'old' }, target),
    false
  )
})
