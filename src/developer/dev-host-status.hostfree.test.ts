/**
 * The in-memory development host status store and the `host` block built from
 * it (no database, no daemon): job tracking, staleness, the control plane's
 * own commit and the migrate count.
 */
import { assertEquals } from '@std/assert'
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import type { DevHostPart, DevHostStatus } from '../contracts/cell-protocol.ts'
import type { Db } from '../db/connection.ts'
import {
  createDevHostStatusStore,
  DEV_HOST_PENDING_JOB_MS,
  DEV_HOST_STATUS_STALE_MS,
} from './dev-host-status.ts'
import {
  buildDevHostView,
  createMigratePendingReader,
  migratePendingFromState,
  pinDevelopmentRevision,
  readDevHostView,
  readTrunkMigrationCount,
} from './dev-host-view.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const AT = '2026-11-03T12:00:00.000Z'
const SERVER = '00000000-0000-4000-8000-0000000000c0'
const HEAD = 'b'.repeat(40)
const OLD = 'c'.repeat(40)
const fakeDb = {} as Db
const fakeRegistry = {} as DaemonCellRegistry

function part(overrides: Partial<DevHostPart> = {}): DevHostPart {
  return {
    name: 'control-plane',
    unit: 'turbopanel-instance.service',
    branch: 'trunk',
    onTrunk: true,
    headCommit: HEAD,
    runningCommit: null,
    behindBy: 0,
    dirty: { files: 0, blocking: false, kinds: [] },
    restartNeeded: false,
    setupNeeded: {},
    active: true,
    ...overrides,
  }
}

function status(job: DevHostStatus['job'] = null, parts = [part()]): DevHostStatus {
  return { parts, lastFetchAt: AT, job }
}

function job(id: string, state: 'running' | 'done' | 'failed'): DevHostStatus['job'] {
  return {
    id,
    action: 'restart',
    state,
    step: 'restart control plane',
    steps: [],
    startedAt: AT,
    endedAt: state === 'running' ? null : AT,
    logTail: [],
  }
}

test('the store keeps the latest status as a copy', () => {
  const store = createDevHostStatusStore()
  assertEquals(store.get(), null)
  const s = status()
  store.put(SERVER, s, AT, 1_000)
  s.parts[0].behindBy = 9
  const got = store.get()
  assertEquals(got?.serverId, SERVER)
  assertEquals(got?.status.parts[0].behindBy, 0)
  assertEquals(got?.receivedAtMs, 1_000)
  store.clear()
  assertEquals(store.get(), null)
})

test('a running job counts until it ends or its status goes stale', () => {
  const store = createDevHostStatusStore()
  assertEquals(store.isJobRunning(0), false)
  store.put(SERVER, status(job('job-1', 'running')), AT, 0)
  assertEquals(store.isJobRunning(1_000), true)
  assertEquals(store.isJobRunning(DEV_HOST_STATUS_STALE_MS), false)
  store.put(SERVER, status(job('job-1', 'done')), AT, 2_000)
  assertEquals(store.isJobRunning(3_000), false)
})

test('a started job counts as running until a status names it', () => {
  const store = createDevHostStatusStore()
  store.put(SERVER, status(job('old', 'done')), AT, 0)
  store.noteJobStarted('job-2', 10)
  assertEquals(store.isJobRunning(20), true)
  // A status about another job does not clear the marker.
  store.put(SERVER, status(job('old', 'done')), AT, 30)
  assertEquals(store.isJobRunning(40), true)
  // The marker lapses on its own.
  assertEquals(store.isJobRunning(10 + DEV_HOST_PENDING_JOB_MS), false)
  store.noteJobStarted('job-3', 100)
  store.put(SERVER, status(job('job-3', 'done')), AT, 110)
  assertEquals(store.isJobRunning(120), false)
})

test('migratePendingFromState counts what migrate would apply', () => {
  assertEquals(migratePendingFromState({ status: 'current', applied: 3, shipped: 3 }), {
    pending: 0,
    applied: 3,
    total: 3,
  })
  assertEquals(migratePendingFromState({ status: 'unmigrated', applied: 0, shipped: 4 }), {
    pending: 4,
    applied: 0,
    total: 4,
  })
  assertEquals(
    migratePendingFromState({ status: 'behind', applied: 2, shipped: 4, pending: ['x', 'y'] }),
    { pending: 2, applied: 2, total: 4 }
  )
  assertEquals(
    migratePendingFromState({ status: 'ahead', applied: 5, shipped: 4, unknown: ['z'] }),
    null
  )
  assertEquals(migratePendingFromState({ status: 'diverged', applied: 2, shipped: 4, at: 1 }), null)
})

test('migratePendingFromState takes the total from trunk, never below the checkout', () => {
  // The checkout is behind trunk: trunk ships two more than it has.
  assertEquals(migratePendingFromState({ status: 'current', applied: 23, shipped: 23 }, 25), {
    pending: 0,
    applied: 23,
    total: 25,
  })
  // A branch checkout with its own new migration ships more than trunk.
  assertEquals(
    migratePendingFromState({ status: 'behind', applied: 25, shipped: 26, pending: ['n'] }, 25),
    { pending: 1, applied: 25, total: 26 }
  )
})

test('readTrunkMigrationCount counts the trunk manifest, null when it cannot', async () => {
  const manifest = JSON.stringify({ entries: [{ sha256: 'a' }, { sha256: 'b' }] })
  const paths: string[] = []
  const show = (path: string) => {
    paths.push(path)
    return Promise.resolve(manifest)
  }
  assertEquals(await readTrunkMigrationCount(show), 2)
  assertEquals(paths, ['migrations/manifest.json'])
  assertEquals(await readTrunkMigrationCount(() => Promise.resolve(null)), null)
  assertEquals(await readTrunkMigrationCount(() => Promise.resolve('not json')), null)
  assertEquals(await readTrunkMigrationCount(() => Promise.resolve('{"entries":[]}')), null)
})

test('pinDevelopmentRevision sets the checkout HEAD, and drops a stale value it cannot replace', async () => {
  const values = new Map<string, string>([['TURBOPANEL_REVISION', OLD]])
  const env = {
    set: (key: string, value: string) => {
      values.set(key, value)
    },
    delete: (key: string) => {
      values.delete(key)
    },
  }
  assertEquals(
    await pinDevelopmentRevision(() => Promise.resolve({ commit: `${HEAD}\n` }), env),
    HEAD
  )
  assertEquals(values.get('TURBOPANEL_REVISION'), HEAD)
  assertEquals(
    await pinDevelopmentRevision(() => Promise.resolve({ commit: 'unknown' }), env),
    null
  )
  assertEquals(values.has('TURBOPANEL_REVISION'), false)
})

test('the migrate reader caches for its ttl, failures included', async () => {
  let now = 0
  let calls = 0
  let fail = false
  const read = createMigratePendingReader(
    () => {
      calls += 1
      return fail
        ? Promise.reject(new Error('db down'))
        : Promise.resolve({ pending: calls, applied: 0, total: calls })
    },
    { ttlMs: 30_000, now: () => now }
  )
  assertEquals(await read(fakeDb), { pending: 1, applied: 0, total: 1 })
  now = 29_999
  assertEquals(await read(fakeDb), { pending: 1, applied: 0, total: 1 })
  now = 30_000
  fail = true
  assertEquals(await read(fakeDb), null)
  now = 40_000
  assertEquals(await read(fakeDb), null)
  assertEquals(calls, 2)
})

test('buildDevHostView fills the control plane commit, restart and migrate count', () => {
  const daemon = part({ name: 'daemon', unit: 'turbopaneld.service', runningCommit: OLD })
  const s = status(null, [part({ setupNeeded: { install: true } }), daemon])
  const migrate = { pending: 2, applied: 23, total: 25 }
  const view = buildDevHostView(s, { runningCommit: OLD, migrate })
  assertEquals(view.migrate, migrate)
  assertEquals(view.parts[0].runningCommit, OLD)
  assertEquals(view.parts[0].restartNeeded, true)
  assertEquals(view.parts[0].setupNeeded, { install: true, migrate: { pending: 2 } })
  // Other parts are the daemon's own reading.
  assertEquals(view.parts[1], daemon)
})

test('buildDevHostView leaves restart off when the running commit is the HEAD', () => {
  const s = status(null, [part({ setupNeeded: { migrate: { pending: 7 } } })])
  const view = buildDevHostView(s, {
    runningCommit: HEAD,
    migrate: { pending: 0, applied: 25, total: 25 },
  })
  assertEquals(view.parts[0].restartNeeded, false)
  assertEquals(view.parts[0].setupNeeded, {})
  const unknown = buildDevHostView(s, { runningCommit: null, migrate: null })
  assertEquals(unknown.migrate, null)
  assertEquals(unknown.parts[0].runningCommit, null)
  assertEquals(unknown.parts[0].restartNeeded, false)
})

test('readDevHostView is null without a status or while the daemon is offline', async () => {
  const store = createDevHostStatusStore()
  const deps = {
    store,
    isConnected: () => Promise.resolve(false),
    readMigratePending: () => Promise.resolve({ pending: 0, applied: 25, total: 25 }),
    runningCommit: () => Promise.resolve(HEAD),
  }
  assertEquals(await readDevHostView(fakeDb, fakeRegistry, deps), null)
  store.put(SERVER, status(), AT)
  assertEquals(await readDevHostView(fakeDb, fakeRegistry, deps), null)
  const failing = { ...deps, isConnected: () => Promise.reject(new Error('cell down')) }
  assertEquals(await readDevHostView(fakeDb, fakeRegistry, failing), null)
  const asked: string[] = []
  const online = {
    ...deps,
    isConnected: (_registry: DaemonCellRegistry, serverId: string) => {
      asked.push(serverId)
      return Promise.resolve(true)
    },
  }
  const view = await readDevHostView(fakeDb, fakeRegistry, online)
  assertEquals(asked, [SERVER])
  assertEquals(view?.migrate, { pending: 0, applied: 25, total: 25 })
  assertEquals(view?.parts[0].runningCommit, HEAD)
})
