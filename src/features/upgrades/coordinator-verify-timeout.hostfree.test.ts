import { assertEquals, assertStringIncludes } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createUpgradeCoordinator } from './coordinator.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'

/**
 * Canary update #2 (2026-10-01, run 82b040b5): the control-plane step reached
 * `verifying` when the new build restarted, then the daemon went quiet (its
 * health check could not match a canary label and waited out its budget). The
 * stall rule would have re-dispatched a full install on top of it after 15
 * minutes; the console showed a spinner until the run was cancelled by hand.
 */

/** Sonar typescript:S2187 only recognizes `test()`, not `Deno.test()`. */
const test = Deno.test.bind(Deno)

const SERVER = '55555555-5555-4555-8555-555555555555'
const T0 = '2026-10-01T23:18:21.000Z'

function minutesAfter(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString()
}

function colocated(): FleetServerFact {
  return {
    serverId: SERVER,
    name: 'canary',
    hostname: 'canary.example',
    connected: true,
    commit: '812124126e2a5554f45e5a4d62e51313bce585ae',
    version: '0.1.7',
    features: ['managed-upgrade-v1'],
    colocated: true,
  }
}

const target = {
  daemon: {
    version: '0.1.7-canary.51',
    commit: '812124126e2a5554f45e5a4d62e51313bce585ae',
    buildId: '20261001-225921-8121241',
    builtAt: '2026-10-01T22:59:21Z',
    manifestUrl: 'https://example.test/daemon/manifest-0.1.7-canary.51.json',
  },
  instance: {
    version: '0.1.7-canary.56',
    commit: '077abdc24a91bbca883251da274991284f5d8064',
    buildId: '20261001-225131-077abdc',
    builtAt: '2026-10-01T22:51:31Z',
    manifestUrl: 'https://example.test/instance/manifest-0.1.7-canary.56.json',
  },
  ui: {
    version: '0.1.6-canary.48',
    commit: 'a57d12fc0ea552399304934e9140d0f96479867e',
    buildId: '20261001-223229-a57d12f',
    builtAt: '2026-10-01T22:32:29Z',
    manifestUrl: 'https://example.test/ui/manifest-0.1.6-canary.48.json',
  },
}

function canaryReplay(verifyTimeoutMs?: number) {
  const clock = { now: T0 }
  const installed = {
    version: '0.1.7',
    commit: 'dd0bdf70c916de3b95d7cee4e6b888cc8810bf37' as string | null,
  }
  const enqueued: DaemonOutboundEnvelope[] = []
  const store = createMemoryUpgradeStore({ facts: [colocated()], latest: target })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (_serverId, envelope) => {
      enqueued.push(envelope)
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'canary',
    development: false,
    now: () => clock.now,
    colocatedServerId: SERVER,
    instanceInstalled: installed,
    resolveTarget: () => Promise.resolve(target),
    ...(verifyTimeoutMs === undefined ? {} : { verifyTimeoutMs }),
  })
  return { coordinator, enqueued, installed, clock, store }
}

/** Start the run and walk the control-plane step to `verifying` at T0 + 4 min. */
async function reachVerifying(h: ReturnType<typeof canaryReplay>): Promise<string> {
  const started = await h.coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  const dispatch = h.enqueued[0]
  if (dispatch?.kind !== 'instance-update') throw new TypeError('expected instance-update')
  for (const [minute, stage] of [
    [3, 'restarting'],
    [4, 'verifying'],
  ] as const) {
    await h.coordinator.noteProgress({
      serverId: SERVER,
      unit: 'instance',
      stage,
      at: minutesAfter(T0, minute),
      requestId: dispatch.requestId,
    })
  }
  return started.runId
}

async function instanceStep(h: ReturnType<typeof canaryReplay>, runId: string) {
  const run = await h.coordinator.run(runId)
  return { run, step: run?.steps.find((item) => item.unit === 'instance') }
}

test('a quiet verifying control-plane step is never re-dispatched as a stalled install', async () => {
  const h = canaryReplay()
  const runId = await reachVerifying(h)
  // The new build is running: the restart happened, the daemon has not answered.
  h.installed.commit = target.instance.commit
  h.clock.now = minutesAfter(T0, 4 + 16)
  await h.coordinator.tick({ resolveManifests: false })
  h.clock.now = minutesAfter(T0, 4 + 18)
  await h.coordinator.tick({ resolveManifests: false })
  const { step } = await instanceStep(h, runId)
  assertEquals(step?.status, 'verifying')
  assertEquals(step?.attempts, 1)
  assertEquals(h.enqueued.length, 1)
})

test('a verifying control-plane step past the verify window needs attention and ends the run', async () => {
  const h = canaryReplay()
  const runId = await reachVerifying(h)
  h.installed.commit = target.instance.commit
  h.clock.now = minutesAfter(T0, 4 + 21)
  await h.coordinator.tick({ resolveManifests: false })
  const { run, step } = await instanceStep(h, runId)
  assertEquals(step?.status, 'needs_attention')
  assertEquals(step?.errorCode, 'verify_timeout')
  assertStringIncludes(step?.errorMessage ?? '', '20 minutes')
  assertStringIncludes(step?.errorMessage ?? '', 'is running the target build 077abdc')
  // The run ends this tick with the platform error the console shows, and
  // leaves the active slot: the next Update can start.
  assertEquals(run?.status, 'failed')
  assertEquals(run?.error, 'control_plane_failed')
  assertEquals(run?.finishedAt, minutesAfter(T0, 4 + 21))
  assertEquals(await h.coordinator.activeRun(), null)
  assertEquals(h.enqueued.length, 1)
})

test('the verify-timeout message says when the control plane is not on the target build', async () => {
  const h = canaryReplay()
  const runId = await reachVerifying(h)
  // Still the old build (for example a rollback whose report never arrived).
  h.clock.now = minutesAfter(T0, 4 + 21)
  await h.coordinator.tick({ resolveManifests: false })
  const { step } = await instanceStep(h, runId)
  assertEquals(step?.errorCode, 'verify_timeout')
  assertStringIncludes(step?.errorMessage ?? '', 'is running dd0bdf7, not the target build 077abdc')
})

test('the verify window is a coordinator setting', async () => {
  const h = canaryReplay(45 * 60 * 1000)
  const runId = await reachVerifying(h)
  h.installed.commit = target.instance.commit
  h.clock.now = minutesAfter(T0, 4 + 30)
  await h.coordinator.tick({ resolveManifests: false })
  assertEquals((await instanceStep(h, runId)).step?.status, 'verifying')
  h.clock.now = minutesAfter(T0, 4 + 46)
  await h.coordinator.tick({ resolveManifests: false })
  const { step } = await instanceStep(h, runId)
  assertEquals(step?.status, 'needs_attention')
  assertStringIncludes(step?.errorMessage ?? '', '45 minutes')
})

test("the daemon's done report inside the window still finishes the run", async () => {
  const h = canaryReplay()
  const runId = await reachVerifying(h)
  h.installed.commit = target.instance.commit
  const requestId = h.enqueued[0]?.requestId
  if (!requestId) throw new TypeError('expected the dispatch')
  await h.coordinator.noteProgress({
    serverId: SERVER,
    unit: 'instance',
    stage: 'done',
    at: minutesAfter(T0, 5),
    requestId,
  })
  h.clock.now = minutesAfter(T0, 6)
  await h.coordinator.tick({ resolveManifests: false })
  assertEquals((await h.coordinator.run(runId))?.status, 'succeeded')
})

test('a second update while one is active answers upgrade_run_active before resolving the target', async () => {
  const h = canaryReplay()
  const runId = await reachVerifying(h)
  let resolved = 0
  const second = await createUpgradeCoordinator({
    store: h.store,
    enqueue: () => Promise.resolve(),
    runtime: 'deno',
    channel: 'canary',
    development: false,
    now: () => h.clock.now,
    colocatedServerId: SERVER,
    instanceInstalled: h.installed,
    resolveTarget: () => {
      resolved += 1
      return Promise.reject(new Error('manifest host unreachable'))
    },
  }).start({ source: 'manual', startedBy: null })
  assertEquals(second.ok, false)
  if (second.ok) throw new TypeError('expected a refusal')
  assertEquals(second.error, 'upgrade_run_active')
  assertEquals(second.activeRunId, runId)
  assertEquals(resolved, 0)
})
