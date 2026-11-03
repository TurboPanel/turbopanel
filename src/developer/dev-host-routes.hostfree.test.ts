/**
 * Development host actions (no database, no daemon): the admin and developer
 * mounts, 202 / 409 / 503, feature gating, the mutual refusal with Build and
 * Push Daemon, and the co-located-only `dev-host-status` dispatch.
 */
import { assert, assertEquals } from '@std/assert'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { DEVELOPER_API_PREFIX } from '../app/surfaces.ts'
import type { DaemonCellRegistry, PendingRequestRecord } from '../contracts/cell.ts'
import type {
  DaemonMessage,
  DaemonOutboundEnvelope,
  DevHostStatus,
} from '../contracts/cell-protocol.ts'
import { dispatchDaemonInboundMessage } from '../daemon/deno-ws.ts'
import type { Db } from '../db/connection.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../lib/secrets/secrets.ts'
import { DEV_HOST_FEATURE } from '../lib/version-wire.ts'
import { withDevelopmentAdminRoutes } from '../platform/deno/development-admin-routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import {
  DEV_HOST_ACTION_TIMEOUT_MS,
  type DevHostRoutesHooks,
  registerDevHostAdminRoutes,
  registerDevHostDeveloperRoutes,
} from './dev-host-routes.ts'
import { createDevHostStatusStore, devHostStatusStore } from './dev-host-status.ts'
import type { DevOverlayState } from './dev-update-overlay.ts'
import {
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

const AT = '2026-11-03T12:00:00.000Z'
const SERVER = '00000000-0000-4000-8000-0000000000c0'
const HEAD = 'd'.repeat(40)

const STATUS: DevHostStatus = {
  parts: [
    {
      name: 'control-plane',
      unit: 'turbopanel-instance.service',
      branch: 'trunk',
      onTrunk: true,
      headCommit: HEAD,
      runningCommit: null,
      behindBy: 2,
      dirty: { files: 0, blocking: false, kinds: [] },
      restartNeeded: false,
      setupNeeded: {},
      active: true,
    },
  ],
  lastFetchAt: AT,
  job: null,
}

type Answer = Partial<PendingRequestRecord> | Error

/** A cell registry whose one cell answers every request with `answer`. */
function fakeRegistry(answer: Answer) {
  const sent: { envelope: DaemonOutboundEnvelope; timeoutMs: number; serverId: string }[] = []
  const registry = {
    getCell: (serverId: string) => ({
      createRequestAndWait: (envelope: DaemonOutboundEnvelope, timeoutMs: number) => {
        sent.push({ envelope, timeoutMs, serverId })
        if (answer instanceof Error) return Promise.reject(answer)
        return Promise.resolve({
          serverId,
          requestId: envelope.requestId,
          requestKind: envelope.kind,
          createdAt: AT,
          expiresAt: AT,
          status: 'done',
          ...answer,
        } as PendingRequestRecord)
      },
    }),
  } as unknown as DaemonCellRegistry
  return { registry, sent }
}

const accepted: Answer = { status: 'done', result: { ok: true, jobId: 'job-7' } }

function auditingDb() {
  const audited: { action: string; context: unknown }[] = []
  const db = {
    insert: () => ({
      values: (row: { action: string; context: unknown }) => {
        audited.push({ action: row.action, context: row.context })
        return Promise.resolve()
      },
    }),
  } as unknown as Db
  return { db, audited }
}

const passRootOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('session', {
    userId: 'user-1',
    email: 'root@example.test',
  } as AppEnv['Variables']['session'])
  await next()
}

const denyRootOnly: MiddlewareHandler<AppEnv> = (c) => Promise.resolve(c.json({ ok: false }, 403))

function hooksWith(overrides: DevHostRoutesHooks = {}): DevHostRoutesHooks {
  const store = createDevHostStatusStore()
  store.put(SERVER, STATUS, AT)
  return {
    store,
    pushJobActive: () => false,
    isConnected: () => Promise.resolve(true),
    daemonFeatures: () => Promise.resolve([DEV_HOST_FEATURE]),
    readMigratePending: () => Promise.resolve({ pending: 0 }),
    runningCommit: () => Promise.resolve(HEAD),
    ...overrides,
  }
}

function adminApp(
  registry: DaemonCellRegistry,
  db: Db,
  hooks: DevHostRoutesHooks,
  opts: { developerSurface?: boolean; rootOnly?: MiddlewareHandler<AppEnv> } = {}
) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    const vars = c as unknown as Context<AppEnv>
    vars.set('db', db)
    vars.set('daemonCellRegistry', registry)
    await next()
  })
  const registrar = withDevelopmentAdminRoutes(
    () => {},
    opts.developerSurface ?? true,
    (admin, deps) => registerDevHostAdminRoutes(admin, deps, hooks)
  )
  registrar(app, { rootOnly: opts.rootOnly ?? passRootOnly })
  return app
}

function press(app: Hono<AppEnv>, action: 'update' | 'restart') {
  return app.request(`/instance/updates/development/host/${action}`, { method: 'POST' })
}

test('the host actions are absent outside development', async () => {
  const { registry, sent } = fakeRegistry(accepted)
  const app = adminApp(registry, auditingDb().db, hooksWith(), { developerSurface: false })
  assertEquals((await press(app, 'update')).status, 404)
  assertEquals((await press(app, 'restart')).status, 404)
  assertEquals(sent.length, 0)
})

test('the host actions are superadmin only', async () => {
  const { registry, sent } = fakeRegistry(accepted)
  const app = adminApp(registry, auditingDb().db, hooksWith(), { rootOnly: denyRootOnly })
  assertEquals((await press(app, 'update')).status, 403)
  assertEquals(sent.length, 0)
})

test('an accepted action answers 202 with the job, audits it and waits 8 s at most', async () => {
  for (const action of ['update', 'restart'] as const) {
    const { registry, sent } = fakeRegistry(accepted)
    const { db, audited } = auditingDb()
    const hooks = hooksWith()
    const app = adminApp(registry, db, hooks)
    const res = await press(app, action)
    assertEquals(res.status, 202)
    assertEquals(await res.json(), { ok: true, job: { id: 'job-7', action } })
    assertEquals(sent.length, 1)
    assertEquals(sent[0].serverId, SERVER)
    assertEquals(sent[0].timeoutMs, DEV_HOST_ACTION_TIMEOUT_MS)
    assertEquals(DEV_HOST_ACTION_TIMEOUT_MS, 8_000)
    assert(sent[0].envelope.kind === 'dev-host-action')
    assertEquals(sent[0].envelope.action, action)
    assertEquals(audited, [{ action: `upgrade.dev_host_${action}`, context: { jobId: 'job-7' } }])
    // The started job blocks a second press before the daemon reports it.
    assertEquals(hooks.store!.isJobRunning(), true)
    const again = await press(app, action)
    assertEquals(again.status, 409)
    assertEquals(await again.json(), { ok: false, error: 'job_running' })
    assertEquals(sent.length, 1)
  }
})

test('the daemon refusing with job_running answers 409', async () => {
  const { registry } = fakeRegistry({
    status: 'failed',
    error: 'job_running',
    result: { ok: false, error: 'job_running' },
  })
  const { db, audited } = auditingDb()
  const res = await press(adminApp(registry, db, hooksWith()), 'update')
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { ok: false, error: 'job_running' })
  assertEquals(audited, [])
})

test('a host job the daemon reports as running answers 409 without asking', async () => {
  const store = createDevHostStatusStore()
  store.put(
    SERVER,
    {
      ...STATUS,
      job: {
        id: 'job-1',
        action: 'update',
        state: 'running',
        step: 'pull',
        steps: [],
        startedAt: AT,
        endedAt: null,
        logTail: [],
      },
    },
    AT
  )
  const { registry, sent } = fakeRegistry(accepted)
  const res = await press(adminApp(registry, auditingDb().db, hooksWith({ store })), 'restart')
  assertEquals(res.status, 409)
  assertEquals(sent.length, 0)
})

test('a running Build and Push job answers 409 without asking', async () => {
  const { registry, sent } = fakeRegistry(accepted)
  const app = adminApp(registry, auditingDb().db, hooksWith({ pushJobActive: () => true }))
  const res = await press(app, 'update')
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { ok: false, error: 'job_running' })
  assertEquals(sent.length, 0)
})

test('503 daemon_unavailable when the daemon is missing, offline or lacks dev-host-v1', async () => {
  const cases: DevHostRoutesHooks[] = [
    hooksWith({ store: createDevHostStatusStore() }),
    hooksWith({ isConnected: () => Promise.resolve(false) }),
    hooksWith({ daemonFeatures: () => Promise.resolve(['managed-health-v1']) }),
  ]
  for (const hooks of cases) {
    const { registry, sent } = fakeRegistry(accepted)
    const res = await press(adminApp(registry, auditingDb().db, hooks), 'update')
    assertEquals(res.status, 503)
    assertEquals(await res.json(), { ok: false, error: 'daemon_unavailable' })
    assertEquals(sent.length, 0)
  }
})

test('503 daemon_unavailable when the daemon times out, refuses or the cell throws', async () => {
  const cases: [Answer, Record<string, unknown>][] = [
    [{ status: 'expired' }, { ok: false, error: 'daemon_unavailable', reason: 'timeout' }],
    [
      {
        status: 'failed',
        error: 'not_development',
        result: { ok: false, error: 'not_development' },
      },
      { ok: false, error: 'daemon_unavailable', reason: 'not_development' },
    ],
    [
      { status: 'done', result: { ok: true } },
      { ok: false, error: 'daemon_unavailable' },
    ],
    [new Error('cell down'), { ok: false, error: 'daemon_unavailable' }],
  ]
  for (const [answer, body] of cases) {
    const { registry } = fakeRegistry(answer)
    const { db, audited } = auditingDb()
    const res = await press(adminApp(registry, db, hooksWith()), 'restart')
    assertEquals(res.status, 503)
    assertEquals(await res.json(), body)
    assertEquals(audited, [])
  }
})

test('Build and Push and the host actions refuse each other', async () => {
  resetDevelopmentPushJobForTests()
  devHostStatusStore.clear()
  try {
    devHostStatusStore.put(SERVER, STATUS, AT)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fresh: DevOverlayState = { built: null, sourceFingerprint: 'x', sourceChanged: true }
    const { registry, sent } = fakeRegistry(accepted)
    const { db } = auditingDb()
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      const vars = c as unknown as Context<AppEnv>
      vars.set('db', db)
      vars.set('daemonCellRegistry', registry)
      await next()
    })
    const hostHooks: DevHostRoutesHooks = {
      isConnected: () => Promise.resolve(true),
      daemonFeatures: () => Promise.resolve([DEV_HOST_FEATURE]),
      runningCommit: () => Promise.resolve(HEAD),
    }
    withDevelopmentAdminRoutes(
      () => {},
      true,
      (admin, deps) => {
        registerDevelopmentUpdatesAdminRoutes(admin, deps, {
          readState: () => Promise.resolve(fresh),
          rebuild: () => gate,
          listRemoteServers: () => Promise.resolve([]),
          readHost: () => Promise.resolve(null),
        })
        registerDevHostAdminRoutes(admin, deps, hostHooks)
      }
    )(app, { rootOnly: passRootOnly })

    const push = () =>
      app.request('/instance/updates/development/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })

    assertEquals((await push()).status, 202)
    assertEquals((await press(app, 'update')).status, 409)
    assertEquals(sent.length, 0)
    release!()
    for (let i = 0; i < 500; i += 1) {
      if ((await press(app, 'restart')).status !== 409) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assertEquals(sent.length, 1)
    // The host job now blocks a push.
    assertEquals((await push()).status, 409)
  } finally {
    devHostStatusStore.clear()
    resetDevelopmentPushJobForTests()
  }
})

test('the Developer Console mounts serve status and the actions', async () => {
  const { registry, sent } = fakeRegistry(accepted)
  const { db } = auditingDb()
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    const vars = c as unknown as Context<AppEnv>
    vars.set('db', db)
    vars.set('daemonCellRegistry', registry)
    await next()
  })
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  registerDevHostDeveloperRoutes(app, { secrets, authRequired: false }, hooksWith())
  const status = await app.request(`${DEVELOPER_API_PREFIX}/dev-host/status`)
  assertEquals(status.status, 200)
  const body = (await status.json()) as {
    ok: boolean
    host: { migrate: unknown; parts: { runningCommit: string }[] }
  }
  assertEquals(body.ok, true)
  assertEquals(body.host.migrate, { pending: 0 })
  assertEquals(body.host.parts[0].runningCommit, HEAD)
  const res = await app.request(`${DEVELOPER_API_PREFIX}/dev-host/update`, { method: 'POST' })
  assertEquals(res.status, 202)
  assertEquals(sent.length, 1)
})

test('the Developer Console mounts need developer access by default', async () => {
  const { registry, sent } = fakeRegistry(accepted)
  const app = new Hono<AppEnv>()
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  app.use('*', async (c, next) => {
    ;(c as unknown as Context<AppEnv>).set('daemonCellRegistry', registry)
    await next()
  })
  registerDevHostDeveloperRoutes(app, { secrets }, hooksWith())
  assertEquals((await app.request(`${DEVELOPER_API_PREFIX}/dev-host/status`)).status, 401)
  assertEquals(
    (await app.request(`${DEVELOPER_API_PREFIX}/dev-host/restart`, { method: 'POST' })).status,
    401
  )
  assertEquals(sent.length, 0)
})

test('dev-host-status reaches the sink only from the co-located daemon', async () => {
  const received: { serverId: string; at: string }[] = []
  const recorded: string[] = []
  const cell = {
    getSnapshot: () => Promise.resolve({ connected: true }),
    recordInbound: (params: { at?: string }) => {
      recorded.push(params.at ?? '')
      return Promise.resolve()
    },
  } as unknown as ReturnType<DaemonCellRegistry['getCell']>
  const message: DaemonMessage = { type: 'dev-host-status', status: STATUS, at: AT }
  for (const colocated of [false, true]) {
    await dispatchDaemonInboundMessage({
      cell,
      db: {} as Db,
      serverId: SERVER,
      connectionId: 'connection-1',
      message,
      colocated,
      onDevHostStatus: (report) => received.push({ serverId: report.serverId, at: report.at }),
      reply: () => {},
    })
  }
  // Without a sink (production) the frame only records liveness.
  await dispatchDaemonInboundMessage({
    cell,
    db: {} as Db,
    serverId: SERVER,
    connectionId: 'connection-1',
    message,
    colocated: true,
    reply: () => {},
  })
  assertEquals(received, [{ serverId: SERVER, at: AT }])
  assertEquals(recorded, [AT, AT, AT])
})
