import { assert, assertEquals } from '@std/assert'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app/app.ts'
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import type { Db } from '../db/connection.ts'
import { withDevelopmentAdminRoutes } from '../platform/deno/development-admin-routes.ts'
import type { DaemonUpdateResult } from './daemon-update-fanout.ts'
import { DevOverlayRebuildError, type DevOverlayState } from './dev-update-overlay.ts'
import {
  computePendingDaemonChanges,
  type DevelopmentPushJob,
  type DevelopmentServer,
  type DevelopmentUpdatesHooks,
  JOB_RUNNING_ERROR,
  registerDevelopmentUpdatesAdminRoutes,
  resetDevelopmentPushJobForTests,
} from './development-updates-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const BUILT = {
  commit: 'abcdef0123456789abcdef0123456789abcdef01+1767225600',
  buildId: 'dev-abcdef0+1767225600',
  builtAt: '2026-01-01T00:00:00.000Z',
  source: 'abcdef0123456789abcdef0123456789abcdef01',
}
const FRESH: DevOverlayState = {
  built: BUILT,
  sourceFingerprint: BUILT.source,
  sourceChanged: false,
}
const SERVER_A = '00000000-0000-4000-8000-0000000000a1'
const SERVER_B = '00000000-0000-4000-8000-0000000000b2'
const SERVER_C = '00000000-0000-4000-8000-0000000000c3'

function remote(id: string, overrides: Partial<DevelopmentServer> = {}): DevelopmentServer {
  return {
    id,
    name: `host-${id.slice(-2)}`,
    connected: true,
    daemonVersion: '0.1.0',
    daemonCommit: BUILT.commit,
    ...overrides,
  }
}

const audited: string[] = []
const fakeDb = {
  insert: () => ({
    values: (row: { action: string }) => {
      audited.push(row.action)
      return Promise.resolve()
    },
  }),
} as unknown as Db
const fakeRegistry = {} as DaemonCellRegistry

const passRootOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('session', {
    userId: 'user-1',
    email: 'root@example.test',
  } as AppEnv['Variables']['session'])
  await next()
}

function createApp(
  hooks: DevelopmentUpdatesHooks,
  opts: { developerSurface?: boolean; register?: boolean } = {}
) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    const vars = c as unknown as Context<AppEnv>
    vars.set('db', fakeDb)
    vars.set('daemonCellRegistry', fakeRegistry)
    await next()
  })
  const registrar = withDevelopmentAdminRoutes(
    () => {},
    opts.developerSurface ?? true,
    opts.register === false
      ? undefined
      : (admin, deps) => registerDevelopmentUpdatesAdminRoutes(admin, deps, hooks)
  )
  registrar(app, { rootOnly: passRootOnly })
  return app
}

function post(app: Hono<AppEnv>, body: unknown = {}) {
  return app.request('/instance/updates/development/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function waitForJobEnd(app: Hono<AppEnv>): Promise<DevelopmentPushJob> {
  for (let i = 0; i < 500; i += 1) {
    const res = await app.request('/instance/updates/development')
    const body = (await res.json()) as { job: DevelopmentPushJob | null }
    if (body.job && (body.job.state === 'done' || body.job.state === 'failed')) return body.job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('job never ended')
}

function okResults(ids: readonly string[]): Promise<DaemonUpdateResult[]> {
  return Promise.resolve(ids.map((serverId) => ({ serverId, ok: true as const })))
}

test('computePendingDaemonChanges needs a connected remote and a difference', () => {
  const onBuild = remote(SERVER_A)
  const behind = remote(SERVER_B, { daemonCommit: 'old' })
  const offlineBehind = remote(SERVER_C, { connected: false, daemonCommit: 'old' })
  const base = { built: BUILT, sourceChanged: false }
  assertEquals(computePendingDaemonChanges({ ...base, servers: [] }), false)
  assertEquals(computePendingDaemonChanges({ ...base, sourceChanged: true, servers: [] }), false)
  assertEquals(computePendingDaemonChanges({ ...base, servers: [offlineBehind] }), false)
  assertEquals(computePendingDaemonChanges({ ...base, servers: [onBuild] }), false)
  assertEquals(computePendingDaemonChanges({ ...base, servers: [onBuild, behind] }), true)
  assertEquals(
    computePendingDaemonChanges({ ...base, sourceChanged: true, servers: [onBuild] }),
    true
  )
  assertEquals(computePendingDaemonChanges({ ...base, built: null, servers: [onBuild] }), true)
})

test('the development routes are absent outside development', async () => {
  resetDevelopmentPushJobForTests()
  const hooks: DevelopmentUpdatesHooks = {
    readState: () => Promise.resolve(FRESH),
    listRemoteServers: () => Promise.resolve([]),
  }
  for (const app of [
    createApp(hooks, { developerSurface: false }),
    createApp(hooks, { register: false }),
  ]) {
    assertEquals((await app.request('/instance/updates/development')).status, 404)
    assertEquals((await post(app)).status, 404)
  }
  assertEquals((await createApp(hooks).request('/instance/updates/development')).status, 200)
})

test('GET reports the build, the remote servers and pending changes', async () => {
  resetDevelopmentPushJobForTests()
  const app = createApp({
    readState: () => Promise.resolve({ ...FRESH }),
    listRemoteServers: () =>
      Promise.resolve([
        remote(SERVER_A),
        remote(SERVER_B, { daemonCommit: 'old' }),
        remote(SERVER_C, { connected: false, daemonCommit: null, daemonVersion: null }),
      ]),
    readHost: () => Promise.resolve(null),
  })
  const res = await app.request('/instance/updates/development')
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    daemonBuild: { built: BUILT, sourceFingerprint: BUILT.source, sourceChanged: false },
    servers: [
      { ...remote(SERVER_A), onLatestBuild: true },
      { ...remote(SERVER_B, { daemonCommit: 'old' }), onLatestBuild: false },
      {
        ...remote(SERVER_C, { connected: false, daemonCommit: null, daemonVersion: null }),
        onLatestBuild: false,
      },
    ],
    job: null,
    pendingDaemonChanges: true,
    host: null,
  })
})

test('GET answers 503 when the daemon checkout cannot be read', async () => {
  resetDevelopmentPushJobForTests()
  const app = createApp({
    readState: () => Promise.reject(new Error('git rev-parse failed')),
    listRemoteServers: () => Promise.resolve([]),
  })
  const res = await app.request('/instance/updates/development')
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { ok: false, error: 'daemon_checkout_unavailable' })
})

test('POST runs one job at a time: a second press while building gets 409', async () => {
  resetDevelopmentPushJobForTests()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let state: DevOverlayState = { ...FRESH, sourceChanged: true }
  const forced: boolean[] = []
  const pushed: string[][] = []
  const app = createApp({
    readState: () => Promise.resolve(state),
    rebuild: async (force) => {
      forced.push(force)
      await gate
      state = FRESH
    },
    listRemoteServers: () =>
      Promise.resolve([remote(SERVER_A), remote(SERVER_B, { connected: false })]),
    push: (_registry, _db, ids) => {
      pushed.push([...ids])
      return okResults(ids)
    },
    newId: () => 'job-1',
  })

  const first = await post(app)
  assertEquals(first.status, 202)
  const started = (await first.json()) as { ok: boolean; job: DevelopmentPushJob }
  assertEquals(started.ok, true)
  assertEquals(started.job.id, 'job-1')
  assertEquals(started.job.state, 'building')

  const second = await post(app, { force: true })
  assertEquals(second.status, 409)
  assertEquals(await second.json(), { ok: false, error: JOB_RUNNING_ERROR })

  release!()
  const ended = await waitForJobEnd(app)
  assertEquals(ended.state, 'done')
  assert(ended.endedAt !== null)
  assertEquals(ended.servers, [
    { id: SERVER_A, name: remote(SERVER_A).name, ok: true, skipped: false, error: null },
  ])
  assertEquals(forced, [false])
  // Only the connected remote is pushed.
  assertEquals(pushed, [[SERVER_A]])
  assertEquals(audited.includes('upgrade.dev_push'), true)

  // A finished job no longer blocks the next press.
  assertEquals((await post(app)).status, 202)
  await waitForJobEnd(app)
})

test('POST skips the build when the overlay is current and reports failed pushes', async () => {
  resetDevelopmentPushJobForTests()
  let builds = 0
  const app = createApp({
    readState: () => Promise.resolve(FRESH),
    rebuild: () => {
      builds += 1
      return Promise.resolve()
    },
    listRemoteServers: () => Promise.resolve([remote(SERVER_A), remote(SERVER_B)]),
    push: () =>
      Promise.resolve([
        { serverId: SERVER_A, ok: true },
        { serverId: SERVER_B, ok: false, error: 'timeout waiting for daemon acknowledgement' },
      ]),
  })
  const res = await post(app)
  assertEquals(res.status, 202)
  assertEquals(((await res.json()) as { job: DevelopmentPushJob }).job.state, 'pushing')
  const ended = await waitForJobEnd(app)
  assertEquals(builds, 0)
  assertEquals(ended.state, 'failed')
  assertEquals(ended.message, '1 of 2 servers failed to update.')
  assertEquals(ended.servers[1]?.error, 'timeout waiting for daemon acknowledgement')
})

test('POST with force rebuilds a current overlay', async () => {
  resetDevelopmentPushJobForTests()
  const forced: boolean[] = []
  const app = createApp({
    readState: () => Promise.resolve(FRESH),
    rebuild: (force) => {
      forced.push(force)
      return Promise.resolve()
    },
    listRemoteServers: () => Promise.resolve([]),
  })
  assertEquals((await post(app, { force: true })).status, 202)
  const ended = await waitForJobEnd(app)
  assertEquals(forced, [true])
  assertEquals(ended.state, 'done')
  assertEquals(ended.message, 'No connected remote servers to update.')
})

test('a failed build fails the job with the stderr tail and pushes nothing', async () => {
  resetDevelopmentPushJobForTests()
  let pushes = 0
  const app = createApp({
    readState: () =>
      Promise.resolve({ built: null, sourceFingerprint: 'abc', sourceChanged: true }),
    rebuild: () => Promise.reject(new DevOverlayRebuildError(1, 'error: compile failed')),
    listRemoteServers: () => Promise.resolve([remote(SERVER_A)]),
    push: (_registry, _db, ids) => {
      pushes += 1
      return okResults(ids)
    },
  })
  assertEquals((await post(app)).status, 202)
  const ended = await waitForJobEnd(app)
  assertEquals(ended.state, 'failed')
  assertEquals(
    ended.message,
    'daemon overlay rebuild failed (deno task release:dev exited 1)\nerror: compile failed'
  )
  assertEquals(pushes, 0)
})

test('POST refuses with 409 while a development host job runs and starts nothing', async () => {
  resetDevelopmentPushJobForTests()
  let rebuilt = false
  const app = createApp({
    readState: () => Promise.resolve(FRESH),
    rebuild: () => {
      rebuilt = true
      return Promise.resolve()
    },
    listRemoteServers: () => Promise.resolve([remote(SERVER_A)]),
    readHost: () => Promise.resolve(null),
    hostJobRunning: () => true,
  })
  const res = await post(app, { force: true })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { ok: false, error: JOB_RUNNING_ERROR })
  const status = await app.request('/instance/updates/development')
  assertEquals(((await status.json()) as { job: unknown }).job, null)
  assertEquals(rebuilt, false)
})

test('GET carries the host block and answers when reading it fails', async () => {
  resetDevelopmentPushJobForTests()
  const host = {
    parts: [],
    lastFetchAt: null,
    job: null,
    migrate: { pending: 0, applied: 25, total: 25 },
  }
  const withHost = createApp({
    readState: () => Promise.resolve(FRESH),
    listRemoteServers: () => Promise.resolve([]),
    readHost: () => Promise.resolve(host),
  })
  const res = await withHost.request('/instance/updates/development')
  assertEquals(((await res.json()) as { host: unknown }).host, host)

  const failing = createApp({
    readState: () => Promise.resolve(FRESH),
    listRemoteServers: () => Promise.resolve([]),
    readHost: () => Promise.reject(new Error('cell down')),
  })
  const failed = await failing.request('/instance/updates/development')
  assertEquals(failed.status, 200)
  assertEquals(((await failed.json()) as { host: unknown }).host, null)
})
