import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import type { DaemonOutboundEnvelope } from '../../contracts/cell-protocol.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { organization, server, setting, upgrade } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createUpgradeCoordinator } from './coordinator.ts'
import { RESTART_RECOVERED_NOTE } from './restart-report.ts'
import {
  persistDaemonReachedTarget,
  persistUpgradeOutcome,
  persistUpgradeProgress,
} from './persist.ts'
import {
  createDrizzleUpgradeStore,
  createMemoryUpgradeStore,
  UPGRADE_TICK_CURSOR_KEY,
  type UpgradeStore,
  type UpgradeTickCursor,
  type UpgradeRunRow,
  type UpgradeStepRow,
} from './store.ts'
import type { UpgradeTarget } from './target.ts'
import {
  ensureUpgradeCheckSchedule,
  getUpgradePause,
  markUpgradeChecked,
  pauseUpgrades,
  readUpgradeCheckSchedule,
  resumeUpgrades,
  UPGRADE_CHECK_KEY,
  UPGRADE_PAUSE_KEY,
} from '../settings/upgrade-control.ts'
import type { UpgradePhase, UpgradeStepStatus, UpgradeStepUnit } from './vocabulary.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * These suites drive `createDrizzleUpgradeStore` through the coordinator: the
 * tick reads the step window with the store's SQL and writes every decision
 * back to Postgres, and the progress/result frames go through `persist.ts`,
 * the same entry points the daemon sockets call. There is exactly one active
 * run per database (`uniq_upgrade_active`), so each test seeds its own run,
 * refuses to start if another is active, and deletes what it made.
 */

const dbUrl = getDatabaseUrl()

const T0 = '2026-09-24T12:00:00.000Z'

function minutesAfter(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString()
}

const TARGET: UpgradeTarget = {
  daemon: {
    version: '0.1.1',
    commit: 'new-daemon',
    buildId: 'd1',
    builtAt: T0,
    manifestUrl: 'https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.1/manifest.json',
  },
  instance: {
    version: '0.1.1',
    commit: 'new-instance',
    buildId: 'i1',
    builtAt: T0,
    manifestUrl: 'https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json',
  },
  ui: {
    version: '0.1.1',
    commit: 'new-ui',
    buildId: 'u1',
    builtAt: T0,
    manifestUrl: 'https://github.com/TurboPanel/ui/releases/download/v0.1.1/manifest.json',
  },
}

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  organizationId: string
  serverIds: string[]
  runIds: string[]
}

async function withFixture(label: string, fn: (fx: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase(`${label}`)
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: `Upgrade store ${label}` })
    .returning({ id: organization.id })
  const fx: Fixture = {
    db,
    organizationId: org!.id,
    serverIds: [],
    runIds: [],
  }
  try {
    await fn(fx)
  } finally {
    if (fx.runIds.length > 0) {
      await db.delete(upgrade).where(inArray(upgrade.id, fx.runIds))
    }
    await db.delete(setting).where(eq(setting.key, UPGRADE_TICK_CURSOR_KEY))
    if (fx.serverIds.length > 0) {
      await db.delete(server).where(inArray(server.id, fx.serverIds))
    }
    await db.delete(organization).where(eq(organization.id, fx.organizationId))
    await endDbConnection(db)
  }
}

async function addServer(
  fx: Fixture,
  input: {
    connected: boolean
    commit: string
    version?: string
    builtAt?: string
    features?: string[]
  }
): Promise<string> {
  const now = new Date().toISOString()
  const [row] = await fx.db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId: fx.organizationId,
      name: `upgrade-${crypto.randomUUID().slice(0, 8)}`,
      isConnected: input.connected,
      daemonCommit: input.commit,
      // A malformed build time is not storable in the column; it reads as unknown.
      daemonBuiltAt:
        input.builtAt && Number.isFinite(Date.parse(input.builtAt))
          ? new Date(input.builtAt).toISOString()
          : null,
      daemon: {
        projection: {
          daemonBuild: {
            commit: input.commit,
            version: input.version ?? '0.1.0',
            buildId: 'b0',
            ...(input.builtAt ? { builtAt: input.builtAt } : {}),
          },
          features: input.features ?? ['managed-upgrade-v1'],
        },
      },
    })
    .returning({ id: server.id })
  fx.serverIds.push(row!.id)
  return row!.id
}

function stepRow(
  runId: string,
  input: {
    serverId: string
    unit: UpgradeStepUnit
    phase: UpgradePhase
    status?: UpgradeStepStatus
    errorCode?: string
  }
): UpgradeStepRow {
  const pin = input.unit === 'instance' ? TARGET.instance : TARGET.daemon
  return {
    id: crypto.randomUUID(),
    upgradeId: runId,
    serverId: input.serverId,
    unit: input.unit,
    phase: input.phase,
    batchIndex: 0,
    status: input.status ?? 'pending',
    requestId: null,
    attempts: 0,
    nextAttemptAt: null,
    fromVersion: '0.1.0',
    toVersion: pin?.version ?? null,
    fromCommit: null,
    toCommit: pin?.commit ?? null,
    lastStageAt: T0,
    errorCode: input.errorCode ?? null,
    errorMessage: null,
    detail: { phase: input.phase },
  }
}

async function seedRun(
  fx: Fixture,
  phase: UpgradePhase,
  steps: (runId: string) => UpgradeStepRow[]
): Promise<string> {
  const id = crypto.randomUUID()
  const run: UpgradeRunRow = {
    id,
    createdAt: T0,
    source: 'manual',
    channel: 'release',
    status: 'running',
    phase,
    startedBy: null,
    startedByEmail: null,
    target: TARGET,
    batchPolicy: { mode: 'percent', value: 100 },
    counts: null,
    error: null,
    startedAt: T0,
    finishedAt: null,
  }
  const inserted = await createDrizzleUpgradeStore(fx.db, null).insertRun(run, steps(id))
  if (inserted !== 'created') {
    throw new TypeError('another upgrade run is active in this database; these tests need it empty')
  }
  fx.runIds.push(id)
  return id
}

function coordinatorFor(
  fx: Fixture,
  input: {
    runtime: 'deno' | 'workers'
    colocatedServerId: string | null
    instanceCommit?: string
  }
) {
  const clock = { now: T0 }
  const enqueued: Array<{ serverId: string; envelope: DaemonOutboundEnvelope }> = []
  const coordinator = createUpgradeCoordinator({
    store: createDrizzleUpgradeStore(fx.db, null),
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, envelope })
      return Promise.resolve()
    },
    runtime: input.runtime,
    channel: 'release',
    development: false,
    now: () => clock.now,
    colocatedServerId: input.colocatedServerId,
    instanceInstalled: {
      version: '0.1.0',
      commit: input.instanceCommit ?? 'old-instance',
    },
    resolveTarget: () => Promise.resolve(TARGET),
  })
  return { coordinator, enqueued, clock }
}

async function stepById(fx: Fixture, runId: string, stepId: string) {
  const steps = await createDrizzleUpgradeStore(fx.db, null).stepsFor(runId)
  return steps.find((step) => step.id === stepId) ?? null
}

test('Postgres upgrades: anyDaemonBehind ignores hosts built after the target', async () => {
  await withFixture('daemon-behind-built-at', async (fx) => {
    // The query is instance-wide; another connected server in a shared
    // scratch database would decide it, so only run against our own rows.
    const others = await fx.db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.isConnected, true))
      .limit(1)
    if (others.length > 0) {
      console.warn('Skipping daemon-behind-built-at: other connected servers exist')
      return
    }
    const store = createDrizzleUpgradeStore(fx.db, null)
    const targetCommit = `canary-${crypto.randomUUID()}`
    const targetBuiltAt = '2026-09-27T18:20:44Z'

    await addServer(fx, {
      connected: true,
      commit: 'ahead-build',
      version: '0.1.1',
      builtAt: '2026-09-28T00:00:00Z',
    })
    assertEquals(await store.anyDaemonBehind(targetCommit, targetBuiltAt), false)
    // Without a target build time the host counts as behind, as before.
    assertEquals(await store.anyDaemonBehind(targetCommit), true)

    await addServer(fx, {
      connected: true,
      commit: 'older-build',
      version: '0.1.1',
      builtAt: '2026-09-27T00:14:32Z',
    })
    assertEquals(await store.anyDaemonBehind(targetCommit, targetBuiltAt), true)
  })
})

test('Postgres upgrades: an unknown or malformed build time counts as behind', async () => {
  await withFixture('daemon-behind-unknown', async (fx) => {
    const others = await fx.db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.isConnected, true))
      .limit(1)
    if (others.length > 0) {
      console.warn('Skipping daemon-behind-unknown: other connected servers exist')
      return
    }
    const store = createDrizzleUpgradeStore(fx.db, null)
    await addServer(fx, {
      connected: true,
      commit: 'no-built-at',
      version: '0.1.1',
      builtAt: 'last tuesday',
    })
    assertEquals(await store.anyDaemonBehind('target-commit', '2026-09-27T18:20:44Z'), true)
  })
})

test('Postgres upgrades: a fleet server offline past the deadline is skipped', async () => {
  await withFixture('offline-deadline', async (fx) => {
    const offline = await addServer(fx, {
      connected: false,
      commit: 'old-daemon',
    })
    let stepId = ''
    const runId = await seedRun(fx, 'fleet', (id) => {
      const row = stepRow(id, {
        serverId: offline,
        unit: 'daemon',
        phase: 'fleet',
      })
      stepId = row.id
      return [row]
    })
    const { coordinator, clock, enqueued } = coordinatorFor(fx, {
      runtime: 'workers',
      colocatedServerId: null,
    })

    clock.now = minutesAfter(T0, 90)
    await coordinator.tick({ resolveManifests: false })
    assertEquals((await stepById(fx, runId, stepId))?.status, 'waiting')

    clock.now = minutesAfter(T0, 100)
    await coordinator.tick({ resolveManifests: false })
    assertEquals((await stepById(fx, runId, stepId))?.status, 'waiting')

    clock.now = minutesAfter(T0, 107)
    await coordinator.tick({ resolveManifests: false })
    const gaveUp = await stepById(fx, runId, stepId)
    assertEquals(gaveUp?.status, 'skipped')
    assertEquals(gaveUp?.errorCode, 'server_offline')
    const store = createDrizzleUpgradeStore(fx.db, null)
    assertEquals(await store.activeRun(), null)
    assertEquals((await store.runById(runId))?.status, 'succeeded')
    assertEquals(enqueued.length, 0)
  })
})

test('Postgres upgrades: a failed co-located daemon step fails the run', async () => {
  await withFixture('colocated-failed', async (fx) => {
    const panel = await addServer(fx, { connected: true, commit: 'old-daemon' })
    const fleet = await addServer(fx, { connected: true, commit: 'old-daemon' })
    const runId = await seedRun(fx, 'colocated_daemon', (id) => [
      stepRow(id, {
        serverId: panel,
        unit: 'daemon',
        phase: 'colocated_daemon',
        status: 'failed',
        errorCode: 'update_failed',
      }),
      stepRow(id, { serverId: fleet, unit: 'daemon', phase: 'fleet' }),
    ])
    const { coordinator, enqueued } = coordinatorFor(fx, {
      runtime: 'deno',
      colocatedServerId: panel,
    })
    await coordinator.tick({ resolveManifests: false })
    const store = createDrizzleUpgradeStore(fx.db, null)
    assertEquals(await store.activeRun(), null)
    const recorded = await store.runById(runId)
    assertEquals(recorded?.status, 'failed')
    assertEquals(recorded?.error, 'colocated_daemon_failed')
    assertEquals(enqueued.length, 0)
  })
})

test('Postgres upgrades: a stall retry refused as in progress still finishes', async () => {
  await withFixture('stall-retry', async (fx) => {
    const host = await addServer(fx, { connected: true, commit: 'old-daemon' })
    let stepId = ''
    const runId = await seedRun(fx, 'fleet', (id) => {
      const row = stepRow(id, { serverId: host, unit: 'daemon', phase: 'fleet' })
      stepId = row.id
      return [row]
    })
    const { coordinator, clock, enqueued } = coordinatorFor(fx, {
      runtime: 'workers',
      colocatedServerId: null,
    })

    await coordinator.tick({ resolveManifests: false })
    const first = enqueued[0]?.envelope.requestId
    if (!first) throw new TypeError('expected the first dispatch')

    clock.now = minutesAfter(T0, 16)
    await coordinator.tick({ resolveManifests: false })
    clock.now = minutesAfter(T0, 18)
    await coordinator.tick({ resolveManifests: false })
    const second = enqueued[1]?.envelope.requestId
    if (!second) throw new TypeError('expected the stall retry')

    const at = minutesAfter(T0, 18)
    await persistUpgradeProgress(fx.db, {
      serverId: host,
      unit: 'daemon',
      stage: 'failed',
      at,
      detail: 'update already in progress',
      errorCode: 'preflight_in_progress',
      requestId: second,
    })
    await persistUpgradeOutcome(fx.db, {
      serverId: host,
      unit: 'daemon',
      ok: false,
      at,
      error: 'preflight_in_progress: update already in progress',
      errorCode: 'preflight_in_progress',
      requestId: second,
    })
    const held = await stepById(fx, runId, stepId)
    assertEquals(held?.status === 'failed', false)
    assertEquals((held?.detail as { priorRequestIds?: string[] })?.priorRequestIds, [first])

    await persistDaemonReachedTarget(fx.db, host, 'new-daemon', minutesAfter(T0, 25))
    assertEquals((await stepById(fx, runId, stepId))?.status, 'done')
    clock.now = minutesAfter(T0, 26)
    await coordinator.tick({ resolveManifests: false })
    const recorded = await createDrizzleUpgradeStore(fx.db, null).runById(runId)
    assertEquals(recorded?.status, 'succeeded')
  })
})

test('Postgres upgrades: a control-plane rollback is recorded as rolled_back', async () => {
  await withFixture('rollback', async (fx) => {
    const panel = await addServer(fx, {
      connected: true,
      commit: 'new-daemon',
      version: '0.1.1',
    })
    let stepId = ''
    const runId = await seedRun(fx, 'control_plane', (id) => {
      const colocated = stepRow(id, {
        serverId: panel,
        unit: 'daemon',
        phase: 'colocated_daemon',
        status: 'done',
      })
      const instance = stepRow(id, {
        serverId: panel,
        unit: 'instance',
        phase: 'control_plane',
      })
      stepId = instance.id
      return [colocated, instance]
    })
    const { coordinator, enqueued, clock } = coordinatorFor(fx, {
      runtime: 'deno',
      colocatedServerId: panel,
    })
    await coordinator.tick({ resolveManifests: false })
    const dispatched = enqueued[0]?.envelope
    if (dispatched?.kind !== 'instance-update') {
      throw new TypeError('expected the control-plane dispatch')
    }

    const at = minutesAfter(T0, 5)
    await persistUpgradeProgress(fx.db, {
      serverId: panel,
      unit: 'instance',
      stage: 'rolled-back',
      at,
      detail: 'health_timeout: new build never became healthy',
      errorCode: 'health_timeout',
      requestId: dispatched.requestId,
    })
    await persistUpgradeOutcome(fx.db, {
      serverId: panel,
      upgradeId: runId,
      unit: 'instance',
      ok: false,
      at,
      error: 'health_timeout: new build never became healthy',
      errorCode: 'health_timeout',
      requestId: dispatched.requestId,
    })
    const rolled = await stepById(fx, runId, stepId)
    assertEquals(rolled?.status, 'rolled_back')
    assertEquals(rolled?.errorCode, 'health_timeout')

    clock.now = minutesAfter(T0, 6)
    await coordinator.tick({ resolveManifests: false })
    const retry = enqueued[1]?.envelope
    assertEquals(retry?.kind, 'instance-update')
    const again = await stepById(fx, runId, stepId)
    assertEquals(again?.status, 'dispatched')
    assertEquals(again?.attempts, 2)
  })
})

/**
 * The coordinator's host-free suites run on `createMemoryUpgradeStore`, whose
 * `tickWindow` re-implements `loadTickWindow`'s SQL in JavaScript. Seed the
 * same steps into both and require the same window, page by page, so those
 * suites exercise what Postgres returns.
 */
test('Postgres upgrades: the in-memory tick window matches the SQL one', async () => {
  await withFixture('tick-window-parity', async (fx) => {
    const servers: string[] = []
    for (let i = 0; i < 6; i++) {
      servers.push(await addServer(fx, { connected: true, commit: 'old' }))
    }
    // Ordered ids under one random prefix: batch-1 steps sort after batch 0,
    // so the page after the last batch-0 step is where a window that ignored
    // the batch would leak batch-1 rows.
    const prefix = crypto.randomUUID().slice(0, 34)
    const orderedId = (n: number) => `${prefix}${n.toString(16).padStart(2, '0')}`
    const plan = (runId: string): UpgradeStepRow[] => [
      stepRow(runId, {
        serverId: servers[0]!,
        unit: 'daemon',
        phase: 'colocated_daemon',
        status: 'done',
      }),
      stepRow(runId, {
        serverId: servers[0]!,
        unit: 'instance',
        phase: 'control_plane',
        status: 'done',
      }),
      ...servers.slice(1).map((serverId, i) => ({
        ...stepRow(runId, {
          serverId,
          unit: 'daemon',
          phase: 'fleet',
          status: i === 0 ? 'done' : 'pending',
        }),
        id: orderedId(i + 1),
        batchIndex: i < 3 ? 0 : 1,
      })),
    ]
    const runId = await seedRun(fx, 'fleet', plan)
    const sqlStore = createDrizzleUpgradeStore(fx.db, null)
    const memoryStore = createMemoryUpgradeStore()
    const run = await sqlStore.runById(runId)
    await memoryStore.insertRun(run!, await sqlStore.stepsFor(runId))

    const view = async (store: UpgradeStore, cursor: UpgradeTickCursor | null) => {
      const window = await store.tickWindow(runId, cursor, 1)
      return {
        steps: window.steps.map((step) => [step.id, step.status]),
        counts: window.counts,
        phase: window.phase,
        batchIndex: window.batchIndex,
        failedPlatformPhase: window.failedPlatformPhase,
        allTerminal: window.allTerminal,
      }
    }

    let cursor: UpgradeTickCursor | null = null
    for (let page = 0; page < 4; page++) {
      const fromSql = await view(sqlStore, cursor)
      assertEquals(await view(memoryStore, cursor), fromSql, `page ${page}`)
      const last = fromSql.steps.at(-1)
      cursor =
        last && fromSql.phase && fromSql.batchIndex !== null
          ? {
              phase: fromSql.phase,
              batchIndex: fromSql.batchIndex,
              afterId: String(last[0]),
            }
          : null
    }

    // Finish batch 0 in both stores: the window must move to batch 1 alike.
    for (const store of [sqlStore, memoryStore]) {
      for (const step of await store.stepsFor(runId)) {
        if (step.phase === 'fleet' && step.batchIndex === 0) {
          await store.saveStep({ ...step, status: 'done' })
        }
      }
    }
    assertEquals(await view(memoryStore, null), await view(sqlStore, null))
  })
})

test('Postgres upgrades: the tick window prefers connected servers like the in-memory one', async () => {
  await withFixture('tick-window-connected-first', async (fx) => {
    const offline = [
      await addServer(fx, { connected: false, commit: 'old' }),
      await addServer(fx, { connected: false, commit: 'old' }),
    ]
    const online = [
      await addServer(fx, { connected: true, commit: 'old' }),
      await addServer(fx, { connected: true, commit: 'old' }),
    ]
    const fleet = [...offline, ...online]
    const runId = await seedRun(fx, 'fleet', (id) =>
      fleet.map((serverId, i) => ({
        ...stepRow(id, { serverId, unit: 'daemon', phase: 'fleet' }),
        batchIndex: i,
      }))
    )
    const sqlStore = createDrizzleUpgradeStore(fx.db, null)
    const run = await sqlStore.runById(runId)
    const steps = await sqlStore.stepsFor(runId)
    const memoryStore = createMemoryUpgradeStore({ facts: await sqlStore.factsFor(fleet, null) })
    await memoryStore.insertRun(run!, steps)

    const batches = async () => {
      const sqlWindow = await sqlStore.tickWindow(runId, null, 10)
      const memoryWindow = await memoryStore.tickWindow(runId, null, 10)
      assertEquals(memoryWindow.batchIndex, sqlWindow.batchIndex)
      assertEquals(
        memoryWindow.steps.map((step) => step.id),
        sqlWindow.steps.map((step) => step.id)
      )
      return sqlWindow.batchIndex
    }

    // Offline batches 0 and 1 wait behind the first connected batch.
    assertEquals(await batches(), 2)

    // An install in flight on an offline server pins its batch.
    const first = steps.find((step) => step.serverId === offline[0])!
    for (const store of [sqlStore, memoryStore]) {
      await store.saveStep({ ...first, status: 'installing' })
    }
    assertEquals(await batches(), 0)

    // Once that install settles, the connected batch leads again.
    for (const store of [sqlStore, memoryStore]) {
      await store.saveStep({ ...first, status: 'done' })
    }
    assertEquals(await batches(), 2)

    // With every connected step done, the lowest offline batch is next.
    for (const step of steps.filter((s) => online.includes(s.serverId))) {
      for (const store of [sqlStore, memoryStore]) {
        await store.saveStep({ ...step, status: 'done' })
      }
    }
    assertEquals(await batches(), 1)
  })
})

test('Postgres upgrades: saveStep with expectedStatus refuses a stale write', async () => {
  await withFixture('cas-refuses-stale-write', async (fx) => {
    const server = await addServer(fx, { connected: true, commit: 'old-daemon' })
    let stepId = ''
    const runId = await seedRun(fx, 'colocated_daemon', (id) => {
      const row = stepRow(id, {
        serverId: server,
        unit: 'daemon',
        phase: 'colocated_daemon',
        status: 'waiting',
      })
      stepId = row.id
      return [row]
    })
    const store = createDrizzleUpgradeStore(fx.db, null)
    const read = await stepById(fx, runId, stepId)
    if (!read) throw new TypeError('step not seeded')

    // The daemon's own hello lands first and marks the step done — the same
    // write `noteDaemonCommit` makes outside the tick.
    const applied = await store.saveStep({ ...read, status: 'done', lastStageAt: T0 })
    assertEquals(applied, true)

    // A tick that read the step before that hello landed now tries to
    // redispatch it (the stale "waiting -> reconnect" decision). Guarded by
    // the status it actually read, the write must be refused rather than
    // clobbering the daemon's own "done" report.
    const staleWrite = await store.saveStep(
      { ...read, status: 'dispatched', attempts: read.attempts + 1, requestId: 'retry-1' },
      'waiting'
    )
    assertEquals(staleWrite, false)

    const final = await stepById(fx, runId, stepId)
    assertEquals(final?.status, 'done')
  })
})

async function seedHeldRestart(fx: Fixture) {
  const host = await addServer(fx, { connected: true, commit: 'old-daemon' })
  let stepId = ''
  const runId = await seedRun(fx, 'fleet', (id) => {
    const row = stepRow(id, { serverId: host, unit: 'daemon', phase: 'fleet' })
    row.fromCommit = 'old-daemon'
    stepId = row.id
    return [row]
  })
  const { coordinator, clock, enqueued } = coordinatorFor(fx, {
    runtime: 'workers',
    colocatedServerId: null,
  })
  await coordinator.tick({ resolveManifests: false })
  const requestId = enqueued[0]?.envelope.requestId
  if (!requestId) throw new TypeError('expected the dispatch')
  await persistUpgradeProgress(fx.db, {
    serverId: host,
    unit: 'daemon',
    stage: 'failed',
    at: minutesAfter(T0, 1),
    detail: 'daemon restart failed after reconcile (systemctl restart exited 143, 1 try, 900 ms)',
    errorCode: 'restart_failed',
    restart: { command: 'restart', exitCode: 143, attempts: 1, elapsedMs: 900 },
    requestId,
  })
  return { host, stepId, runId, coordinator, clock }
}

test('Postgres upgrades: a reported restart error is held and the host coming back on the target ends updated', async () => {
  await withFixture('restart-held-then-back', async (fx) => {
    const { host, stepId, runId, coordinator, clock } = await seedHeldRestart(fx)
    const held = await stepById(fx, runId, stepId)
    assertEquals(held?.status, 'restarting')
    assertEquals(held?.errorCode, null)

    await persistDaemonReachedTarget(fx.db, host, 'new-daemon', minutesAfter(T0, 2))
    const done = await stepById(fx, runId, stepId)
    assertEquals(done?.status, 'done')
    const detail = done?.detail as {
      restartNote?: string
      restartPending?: { restart?: { exitCode?: number } }
    }
    assertEquals(detail.restartNote, RESTART_RECOVERED_NOTE)
    assertEquals(detail.restartPending?.restart?.exitCode, 143)
    clock.now = minutesAfter(T0, 3)
    await coordinator.tick({ resolveManifests: false })
    assertEquals((await createDrizzleUpgradeStore(fx.db, null).runById(runId))?.status, 'succeeded')
  })
})

test('Postgres upgrades: a reported restart error with no host back on the target fails after the window with the reason', async () => {
  await withFixture('restart-held-never-back', async (fx) => {
    const { host, stepId, runId, coordinator, clock } = await seedHeldRestart(fx)
    await fx.db.update(server).set({ isConnected: false }).where(eq(server.id, host))
    // The window counts from the panel's own clock when it held the step (the
    // frame writer stamps the wall clock), not from the test clock or the frame.
    const held = await stepById(fx, runId, stepId)
    const heldAt = (held?.detail as { restartPending?: { at?: string } }).restartPending?.at
    if (!heldAt) throw new TypeError('expected the restart hold')
    clock.now = minutesAfter(heldAt, 5)
    await coordinator.tick({ resolveManifests: false })
    assertEquals((await stepById(fx, runId, stepId))?.status, 'restarting')

    clock.now = minutesAfter(heldAt, 12)
    await coordinator.tick({ resolveManifests: false })
    const failed = await stepById(fx, runId, stepId)
    assertEquals(failed?.status, 'failed')
    assertEquals(failed?.errorCode, 'restart_failed')
    assertEquals(failed?.errorMessage?.includes('exited 143'), true)
    assertEquals(failed?.errorMessage?.includes('did not reconnect'), true)
    assertEquals((await createDrizzleUpgradeStore(fx.db, null).runById(runId))?.status, 'failed')
  })
})

test('Postgres upgrades: run steps name their server, from the servers table or the planned snapshot', async () => {
  await withFixture('step-server-names', async (fx) => {
    const host = await addServer(fx, { connected: true, commit: 'old-daemon' })
    await fx.db.update(server).set({ name: null, hostname: 'w.lan' }).where(eq(server.id, host))
    const runId = await seedRun(fx, 'fleet', (id) => {
      const row = stepRow(id, { serverId: host, unit: 'daemon', phase: 'fleet' })
      row.detail = { phase: 'fleet', serverName: 'w', serverHostname: 'w.lan' }
      return [row]
    })
    const { coordinator } = coordinatorFor(fx, { runtime: 'workers', colocatedServerId: null })
    const stepOf = async () => (await coordinator.run(runId))?.steps[0]

    assertEquals((await stepOf())?.serverName, 'w')
    assertEquals((await stepOf())?.hostname, 'w.lan')

    await fx.db.update(server).set({ name: 'renamed' }).where(eq(server.id, host))
    assertEquals((await stepOf())?.serverName, 'renamed')

    // A step row goes with its server (cascade), so the snapshot covers a name or hostname later cleared.
    await fx.db.update(server).set({ name: null, hostname: null }).where(eq(server.id, host))
    assertEquals((await stepOf())?.serverName, 'w')
    assertEquals((await stepOf())?.hostname, 'w.lan')
  })
})

test('Postgres upgrades: a pause settles only never-sent steps, then the run ends cancelled', async () => {
  await withFixture('pause-settle', async (fx) => {
    const sent = await addServer(fx, { connected: true, commit: 'old-daemon' })
    const waiting = await addServer(fx, { connected: true, commit: 'old-daemon' })
    const later = await addServer(fx, { connected: true, commit: 'old-daemon' })
    let sentStepId = ''
    const runId = await seedRun(fx, 'fleet', (id) => {
      const first = { ...stepRow(id, { serverId: sent, unit: 'daemon', phase: 'fleet' }) }
      first.status = 'dispatched'
      first.attempts = 1
      first.requestId = 'req-1'
      sentStepId = first.id
      return [
        first,
        stepRow(id, { serverId: waiting, unit: 'daemon', phase: 'fleet', status: 'waiting' }),
        { ...stepRow(id, { serverId: later, unit: 'daemon', phase: 'fleet' }), batchIndex: 1 },
      ]
    })
    const store = createDrizzleUpgradeStore(fx.db, null)
    await setUpgradePauseForTest(fx, true)
    try {
      const { coordinator, enqueued, clock } = coordinatorFor(fx, {
        runtime: 'workers',
        colocatedServerId: null,
      })
      await coordinator.tick({ resolveManifests: false })
      const steps = await store.stepsFor(runId)
      const byId = new Map(steps.map((step) => [step.serverId, step]))
      assertEquals(byId.get(sent)?.status, 'dispatched')
      assertEquals(byId.get(waiting)?.status, 'skipped')
      assertEquals(byId.get(waiting)?.errorCode, 'updates_paused')
      assertEquals(byId.get(later)?.errorCode, 'updates_paused')
      assertEquals(enqueued.length, 0)
      assertEquals((await store.activeRun())?.error, 'updates_paused')

      await fx.db.update(server).set({ daemonCommit: 'new-daemon' }).where(eq(server.id, sent))
      await persistDaemonReachedTarget(fx.db, sent, 'new-daemon', minutesAfter(T0, 2))
      clock.now = minutesAfter(T0, 3)
      await coordinator.tick({ resolveManifests: false })
      const ended = await store.runById(runId)
      assertEquals(ended?.status, 'cancelled')
      assertEquals(ended?.error, 'updates_paused')
      assertEquals((await stepById(fx, runId, sentStepId))?.status, 'done')
    } finally {
      await setUpgradePauseForTest(fx, false)
    }
  })
})

test('Postgres upgrades: failure history counts failed steps per server and unit at the target', async () => {
  await withFixture('failure-history', async (fx) => {
    const host = await addServer(fx, { connected: true, commit: 'old-daemon' })
    const other = await addServer(fx, { connected: true, commit: 'old-daemon' })
    const first = await seedRun(fx, 'fleet', (id) => [
      stepRow(id, { serverId: host, unit: 'daemon', phase: 'fleet', status: 'failed' }),
      stepRow(id, { serverId: other, unit: 'daemon', phase: 'fleet', status: 'done' }),
    ])
    await fx.db.update(upgrade).set({ status: 'partially_failed' }).where(eq(upgrade.id, first))
    await seedRun(fx, 'fleet', (id) => [
      stepRow(id, { serverId: host, unit: 'daemon', phase: 'fleet', status: 'needs_attention' }),
    ])
    const store = createDrizzleUpgradeStore(fx.db, null)
    const history = await store.failureHistory({ daemonCommit: 'new-daemon', instanceCommit: null })
    const entry = history.get(`${host}:daemon`)
    assertEquals(entry?.failures, 2)
    assertEquals(Number.isFinite(Date.parse(entry?.lastFailedAt ?? '')), true)
    assertEquals(entry?.lastFailedAt?.endsWith('Z'), true)
    assertEquals(history.has(`${other}:daemon`), false)
    const otherBuild = await store.failureHistory({ daemonCommit: 'newer', instanceCommit: null })
    assertEquals(otherBuild.has(`${host}:daemon`), false)
  })
})

test('Postgres upgrades: the check row is created once with a stable minute, and pause keeps the first pause', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('upgrade control rows')
    return
  }
  const db = createDenoDb()
  const keys = [UPGRADE_CHECK_KEY, UPGRADE_PAUSE_KEY]
  await db.delete(setting).where(inArray(setting.key, keys))
  try {
    const first = await ensureUpgradeCheckSchedule(db, T0, () => 0.5)
    assertEquals(first, { minute: 30, createdAt: T0, lastCheckAt: null })
    const again = await ensureUpgradeCheckSchedule(db, minutesAfter(T0, 5), () => 0.1)
    assertEquals(again.minute, 30)
    await markUpgradeChecked(db, again, minutesAfter(T0, 30))
    assertEquals((await readUpgradeCheckSchedule(db))?.lastCheckAt, minutesAfter(T0, 30))

    const pause = { since: T0, byUserId: null, byEmail: 'a@example.test', byName: 'A' }
    assertEquals(await pauseUpgrades(db, pause), { pause, changed: true })
    const second = await pauseUpgrades(db, { ...pause, since: minutesAfter(T0, 1), byName: 'B' })
    assertEquals(second, { pause, changed: false })
    assertEquals(await getUpgradePause(db), pause)
    assertEquals(await resumeUpgrades(db), true)
    assertEquals(await resumeUpgrades(db), false)
    assertEquals(await getUpgradePause(db), null)
  } finally {
    await db.delete(setting).where(inArray(setting.key, keys))
    await endDbConnection(db)
  }
})

async function setUpgradePauseForTest(fx: Fixture, paused: boolean): Promise<void> {
  if (paused) {
    await pauseUpgrades(fx.db, { since: T0, byUserId: null, byEmail: null, byName: null })
  } else {
    await resumeUpgrades(fx.db)
  }
}
