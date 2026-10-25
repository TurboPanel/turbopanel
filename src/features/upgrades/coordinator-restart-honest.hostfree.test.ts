import { assertEquals, assertStringIncludes } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createUpgradeCoordinator } from './coordinator.ts'
import { RESTART_RECOVERED_NOTE, UPGRADE_RESTART_RECONNECT_MS } from './restart-report.ts'
import { createMemoryUpgradeStore, type FleetServerFact } from './store.ts'

/**
 * Canary update (2026-10-22): hosts restarted onto the new build and reported
 * updated after reconnecting, yet the step read `Failed ... daemon restart
 * failed after reconcile` because the restart command's exit status was
 * nonzero (it was cut off by the restart it asked for). A reported restart
 * error is a hint: the host's own build decides the step.
 */

const test = Deno.test.bind(Deno)

const COLOCATED = '11111111-1111-4111-8111-111111111111'
const HOST = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const START = Date.parse('2026-10-22T10:00:00.000Z')
const OLD = 'old-daemon'
const NEW = 'new-daemon'

const build = (version: string, commit: string) => ({
  version,
  commit,
  buildId: commit,
  builtAt: '2026-10-22T09:00:00.000Z',
  manifestUrl: 'https://example.test/manifest.json',
})

const target = {
  daemon: build('0.1.2', NEW),
  instance: build('0.1.2', 'new-instance'),
  ui: build('0.1.2', 'new-ui'),
}

function fact(serverId: string, overrides: Partial<FleetServerFact> = {}): FleetServerFact {
  return {
    serverId,
    name: 'w',
    hostname: 'w.lan',
    connected: true,
    commit: OLD,
    version: '0.1.1',
    features: ['managed-upgrade-v1'],
    colocated: false,
    ...overrides,
  }
}

async function harness(
  hostOverrides: Partial<FleetServerFact> = {},
  others: FleetServerFact[] = []
) {
  const clock = { ms: START }
  const enqueued: { serverId: string; envelope: DaemonOutboundEnvelope }[] = []
  const host = fact(HOST, hostOverrides)
  const facts = [fact(COLOCATED, { name: 'panel', colocated: true, commit: NEW }), host, ...others]
  const store = createMemoryUpgradeStore({ facts, latest: target })
  const coordinator = createUpgradeCoordinator({
    store,
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, envelope })
      return Promise.resolve()
    },
    runtime: 'deno',
    channel: 'release',
    development: false,
    now: () => new Date(clock.ms).toISOString(),
    colocatedServerId: COLOCATED,
    instanceInstalled: { version: '0.1.2', commit: 'new-instance' },
    resolveTarget: () => Promise.resolve(target),
  })
  const started = await coordinator.start({ source: 'manual', startedBy: null })
  if (!started.ok) throw new TypeError(started.error)
  const requestId = enqueued.find(
    (item) => item.serverId === HOST && item.envelope.kind === 'update'
  )?.envelope.requestId
  if (!requestId) throw new TypeError('expected the dispatch')
  const at = () => new Date(clock.ms).toISOString()
  const report = (
    stage: 'restarting' | 'failed',
    extra: { errorCode?: string; detail?: string } = {}
  ) =>
    coordinator.noteProgress({
      serverId: HOST,
      unit: 'daemon',
      stage,
      at: at(),
      requestId,
      ...extra,
    })
  const restartFailedFrame = (restart?: unknown) =>
    report('failed', {
      errorCode: 'restart_failed',
      detail: 'daemon restart failed after reconcile (systemctl restart exited 143, 1 try, 900 ms)',
      ...(restart ? { restart } : {}),
    } as never)
  const step = async () => {
    const run = (await coordinator.activeRun()) ?? (await coordinator.lastRun())
    return run?.steps.find((item) => item.serverId === HOST)
  }
  const runStatus = async () => (await coordinator.run(started.runId))?.status
  const tick = async (afterMs = 0) => {
    clock.ms += afterMs
    await coordinator.tick({ resolveManifests: false })
  }
  const comesBack = async (commit: string) => {
    host.connected = true
    host.commit = commit
    await coordinator.noteDaemonCommit(HOST, commit, at())
  }
  return {
    coordinator,
    host,
    facts,
    report,
    restartFailedFrame,
    step,
    runStatus,
    tick,
    comesBack,
    requestId,
    at,
    runId: started.runId,
  }
}

const diagnostics = { command: 'restart', exitCode: 143, attempts: 1, elapsedMs: 900 }

test('a restart that works ends updated and the run succeeded', async () => {
  const h = await harness()
  await h.report('restarting')
  await h.comesBack(NEW)
  await h.tick()
  assertEquals((await h.step())?.status, 'done')
  assertEquals((await h.step())?.errorCode, null)
  assertEquals(await h.runStatus(), 'succeeded')
})

test('a nonzero restart report is held, not failed, while the host can still come back', async () => {
  const h = await harness()
  await h.report('restarting')
  await h.restartFailedFrame(diagnostics)
  await h.coordinator.noteOutcome({
    serverId: HOST,
    unit: 'daemon',
    ok: false,
    at: h.at(),
    error: 'daemon restart failed after reconcile',
    errorCode: 'restart_failed',
    requestId: h.requestId,
  })
  h.host.connected = false
  await h.tick(60_000)
  const held = await h.step()
  assertEquals(held?.status, 'restarting')
  assertEquals(held?.errorCode, null)
  assertEquals(held?.attempts, 1)
})

test('nonzero restart but the host reconnects on the target build: updated, with a note, run succeeded', async () => {
  const h = await harness()
  await h.report('restarting')
  await h.restartFailedFrame(diagnostics)
  h.host.connected = false
  await h.tick(30_000)
  await h.comesBack(NEW)
  await h.tick(30_000)
  const done = await h.step()
  assertEquals(done?.status, 'done')
  assertEquals(done?.errorCode, null)
  assertEquals(done?.errorMessage, null)
  const detail = done?.detail as { restartNote?: string; restartPending?: { restart?: unknown } }
  assertEquals(detail.restartNote, RESTART_RECOVERED_NOTE)
  assertEquals(detail.restartPending?.restart, diagnostics)
  assertEquals(await h.runStatus(), 'succeeded')
})

test('the tick alone settles a held step once the host reports the target build', async () => {
  const h = await harness()
  await h.restartFailedFrame()
  h.host.commit = NEW
  await h.tick(5_000)
  assertEquals((await h.step())?.status, 'done')
  assertEquals(await h.runStatus(), 'succeeded')
})

test('a restart report from an older daemon (result only, no diagnostics) is held the same way', async () => {
  const h = await harness()
  await h.coordinator.noteOutcome({
    serverId: HOST,
    unit: 'daemon',
    ok: false,
    at: h.at(),
    error: 'daemon restart failed after reconcile',
    errorCode: 'restart_failed',
    requestId: h.requestId,
  })
  assertEquals((await h.step())?.status, 'restarting')
  await h.comesBack(NEW)
  assertEquals((await h.step())?.status, 'done')
})

test('nonzero restart and the host never comes back: failed with the exact reason', async () => {
  const h = await harness()
  await h.restartFailedFrame(diagnostics)
  h.host.connected = false
  await h.tick(UPGRADE_RESTART_RECONNECT_MS + 1_000)
  const failed = await h.step()
  assertEquals(failed?.status, 'failed')
  assertEquals(failed?.errorCode, 'restart_failed')
  assertStringIncludes(failed?.errorMessage ?? '', 'daemon restart failed after reconcile')
  assertStringIncludes(failed?.errorMessage ?? '', 'exited 143')
  assertStringIncludes(failed?.errorMessage ?? '', 'did not reconnect within 10 minutes')
  assertEquals(await h.runStatus(), 'partially_failed')
})

test('nonzero restart and the host comes back on the old build: failed, says which build', async () => {
  const h = await harness()
  await h.restartFailedFrame(diagnostics)
  await h.tick(UPGRADE_RESTART_RECONNECT_MS + 1_000)
  const failed = await h.step()
  assertEquals(failed?.status, 'failed')
  assertStringIncludes(failed?.errorMessage ?? '', `still runs the old build ${OLD.slice(0, 7)}`)
  assertStringIncludes(failed?.errorMessage ?? '', `not the target ${NEW.slice(0, 7)}`)
  assertEquals(await h.runStatus(), 'partially_failed')
})

test('nonzero restart and the host comes back on some other build: failed, says so', async () => {
  const h = await harness()
  await h.restartFailedFrame(diagnostics)
  h.host.commit = 'surprise-build'
  await h.tick(UPGRADE_RESTART_RECONNECT_MS + 1_000)
  const failed = await h.step()
  assertEquals(failed?.status, 'failed')
  assertStringIncludes(failed?.errorMessage ?? '', 'neither the old build nor the target')
})

test('the result frame is lost: the host coming back on the target still ends updated, without a note', async () => {
  const h = await harness()
  await h.report('restarting')
  h.host.connected = false
  await h.tick(20_000)
  await h.comesBack(NEW)
  await h.tick(1_000)
  const done = await h.step()
  assertEquals(done?.status, 'done')
  assertEquals((done?.detail as { restartNote?: string }).restartNote, undefined)
  assertEquals(await h.runStatus(), 'succeeded')
})

test('a step that really failed to install still fails at once', async () => {
  const h = await harness()
  await h.report('failed', { errorCode: 'update_failed', detail: 'checksum mismatch' })
  assertEquals((await h.step())?.status, 'failed')
  await h.tick(1_000)
  assertEquals(await h.runStatus(), 'partially_failed')
})

test('a step names its server: live name, else hostname, else the planned snapshot, else nothing', async () => {
  const live = await harness()
  assertEquals((await live.step())?.serverName, 'w')
  assertEquals((await live.step())?.hostname, 'w.lan')

  const unnamed = await harness({ name: null })
  assertEquals((await unnamed.step())?.serverName, null)
  assertEquals((await unnamed.step())?.hostname, 'w.lan')

  const renamed = await harness()
  renamed.host.name = 'renamed'
  assertEquals((await renamed.step())?.serverName, 'renamed')

  const cleared = await harness()
  // The name is cleared after planning: the name the step was planned with remains.
  cleared.host.name = null
  assertEquals((await cleared.step())?.serverName, 'w')
  assertEquals((await cleared.step())?.hostname, 'w.lan')
})

test('retrying a step that failed after a restart error sends a fresh install that can succeed', async () => {
  // A second server still updating keeps the run open, so the failed step can be retried.
  const h = await harness({}, [fact(OTHER, { name: 'x', hostname: 'x.lan' })])
  await h.restartFailedFrame(diagnostics)
  await h.tick(UPGRADE_RESTART_RECONNECT_MS + 1_000)
  const failed = await h.step()
  assertEquals(failed?.status, 'failed')
  assertEquals((await h.coordinator.retry(failed?.id ?? '')).ok, true)
  const retried = await h.step()
  assertEquals(retried?.status, 'dispatched')
  assertEquals(retried?.attempts, 2)
  const detail = retried?.detail as { restartPending?: unknown; restartNote?: unknown }
  assertEquals(detail.restartPending, undefined)
  assertEquals(detail.restartNote, undefined)
  await h.tick(1_000)
  assertEquals((await h.step())?.status, 'dispatched')
  await h.comesBack(NEW)
  const other = h.facts.find((item) => item.serverId === OTHER)
  if (other) other.commit = NEW
  await h.coordinator.noteDaemonCommit(OTHER, NEW, h.at())
  await h.tick(1_000)
  const done = await h.step()
  assertEquals(done?.status, 'done')
  assertEquals((done?.detail as { restartNote?: unknown }).restartNote, undefined)
  assertEquals(await h.runStatus(), 'succeeded')
})

for (const skew of [
  { label: 'behind', ms: -15 * 60_000 },
  { label: 'ahead', ms: 15 * 60_000 },
]) {
  test(`the reconnect window runs on the panel's clock when the host's clock is 15 minutes ${skew.label}`, async () => {
    const h = await harness()
    await h.coordinator.noteProgress({
      serverId: HOST,
      unit: 'daemon',
      stage: 'failed',
      at: new Date(Date.parse(h.at()) + skew.ms).toISOString(),
      requestId: h.requestId,
      errorCode: 'restart_failed',
      detail: 'daemon restart failed after reconcile',
    })
    h.host.connected = false
    await h.tick(UPGRADE_RESTART_RECONNECT_MS - 60_000)
    assertEquals((await h.step())?.status, 'restarting')
    await h.tick(2 * 60_000)
    assertEquals((await h.step())?.status, 'failed')
    assertEquals((await h.step())?.errorCode, 'restart_failed')
  })
}

test('a failed frame replayed after the host came back on the target is ignored', async () => {
  const h = await harness()
  await h.restartFailedFrame(diagnostics)
  await h.comesBack(NEW)
  assertEquals((await h.step())?.status, 'done')
  await h.restartFailedFrame(diagnostics)
  await h.report('failed', { errorCode: 'update_failed', detail: 'late copy' })
  await h.tick(UPGRADE_RESTART_RECONNECT_MS + 1_000)
  const done = await h.step()
  assertEquals(done?.status, 'done')
  assertEquals(done?.errorCode, null)
  assertEquals(done?.errorMessage, null)
  assertEquals(await h.runStatus(), 'succeeded')
})
