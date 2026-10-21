import { assertEquals } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createUpgradeCoordinator } from './coordinator.ts'
import { createMemoryUpgradeStore, type FleetServerFact, type UpgradeStore } from './store.ts'

/**
 * Canary update (2026-10-21, run 197eff60): the panel restarted on the target
 * build, the daemon replayed its queued reports in one burst, and the step
 * stayed `verifying` until verify_timeout. Reports are handled concurrently, so
 * a `verifying` read before `done` was written could overwrite it.
 */

const test = Deno.test.bind(Deno)

const SERVER = '66666666-6666-4666-8666-666666666666'
const NOW = '2026-10-21T17:43:00.000Z'

const build = (version: string, commit: string) => ({
  version,
  commit,
  buildId: commit,
  builtAt: '2026-10-21T17:00:00.000Z',
  manifestUrl: 'https://example.test/manifest.json',
})

const target = {
  daemon: build('0.1.15-canary.6', 'daemon-6'),
  instance: build('0.1.19-canary.5', 'instance-5'),
  ui: build('0.1.15-canary.5', 'ui-5'),
}

const fact: FleetServerFact = {
  serverId: SERVER,
  name: 'canary',
  hostname: 'canary.example',
  connected: true,
  commit: 'daemon-6',
  version: '0.1.15-canary.6',
  features: ['managed-upgrade-v1'],
  colocated: true,
}

async function harness(wrap?: (store: UpgradeStore) => UpgradeStore) {
  const enqueued: DaemonOutboundEnvelope[] = []
  const base = createMemoryUpgradeStore({ facts: [fact], latest: target })
  const store = wrap ? wrap(base) : base
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (_id, envelope) => {
      enqueued.push(envelope)
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'canary',
    development: false,
    now: () => NOW,
    colocatedServerId: SERVER,
    instanceInstalled: { version: '0.1.19', commit: 'instance-3' },
    resolveTarget: () => Promise.resolve(target),
  })
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  const requestId = enqueued.find((item) => item.kind === 'instance-update')?.requestId
  if (!requestId) throw new TypeError('expected the dispatch')
  const status = async () =>
    (await store.stepsFor(started.runId)).find((step) => step.unit === 'instance')?.status
  return { coordinator, requestId, status }
}

const report = (requestId: string, stage: 'restarting' | 'verifying' | 'done') => ({
  serverId: SERVER,
  unit: 'instance' as const,
  stage,
  at: NOW,
  requestId,
})

test('a verifying report that read the step before done was written does not undo done', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reads = -1000
  const h = await harness((store) => ({
    ...store,
    // The first report to read the steps is held until another report has written.
    stepsFor: async (id) => {
      const rows = await store.stepsFor(id)
      reads += 1
      if (reads === 1) await gate
      return rows
    },
    saveStep: async (step, expected) => {
      const saved = await store.saveStep(step, expected)
      release()
      return saved
    },
  }))
  await h.coordinator.noteProgress(report(h.requestId, 'restarting'))
  reads = 0
  await Promise.all([
    h.coordinator.noteProgress(report(h.requestId, 'verifying')),
    h.coordinator.noteProgress(report(h.requestId, 'done')),
  ])
  assertEquals(await h.status(), 'done')
})

test('an earlier stage replayed after a later one does not move the step back', async () => {
  const h = await harness()
  await h.coordinator.noteProgress(report(h.requestId, 'verifying'))
  await h.coordinator.noteProgress(report(h.requestId, 'restarting'))
  assertEquals(await h.status(), 'verifying')
})
