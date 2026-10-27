import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { datacenter, organization, server, stage, upgrade } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { parseHistoryQuery, parseRunServersQuery } from './history.ts'
import { readHistoryPage, readRunServersPage } from './history-read.ts'
import { createDrizzleUpgradeStore } from './store.ts'
import type {
  UpgradePhase,
  UpgradeStatus,
  UpgradeStepStatus,
  UpgradeStepUnit,
} from './vocabulary.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

/**
 * The paged history reads against real Postgres: one row per run with server
 * totals, and one row per server inside a run with sorting, filters and the
 * quick-filter counts. Runs are inserted finished, so no test here holds the
 * one active run slot other suites need.
 */

const dbUrl = getDatabaseUrl()

const T0 = '2026-10-20T12:00:00.000Z'

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  orgA: string
  orgB: string
  dcId: string
  serverIds: string[]
  runIds: string[]
}

async function withFixture(label: string, fn: (fx: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase(label)
    return
  }
  const db = createDenoDb()
  const tag = crypto.randomUUID().slice(0, 8)
  const [a] = await db
    .insert(organization)
    .values({ name: `Alpha ${tag}` })
    .returning({ id: organization.id })
  const [b] = await db
    .insert(organization)
    .values({ name: `Beta ${tag}` })
    .returning({ id: organization.id })
  const [dc] = await db
    .insert(datacenter)
    .values({ organizationId: a!.id, name: `Tokyo ${tag}` })
    .returning({ id: datacenter.id })
  const fx: Fixture = { db, orgA: a!.id, orgB: b!.id, dcId: dc!.id, serverIds: [], runIds: [] }
  try {
    await fn(fx)
  } finally {
    if (fx.runIds.length > 0) await db.delete(upgrade).where(inArray(upgrade.id, fx.runIds))
    if (fx.serverIds.length > 0) await db.delete(server).where(inArray(server.id, fx.serverIds))
    await db.delete(datacenter).where(eq(datacenter.id, fx.dcId))
    await db.delete(organization).where(inArray(organization.id, [fx.orgA, fx.orgB]))
    await endDbConnection(db)
  }
}

async function addServer(
  fx: Fixture,
  name: string,
  organizationId: string,
  withDatacenter = false
): Promise<string> {
  const [row] = await fx.db
    .insert(server)
    .values({
      organizationId,
      name,
      isConnected: true,
      preferredDatacenterId: withDatacenter ? fx.dcId : null,
    })
    .returning({ id: server.id })
  fx.serverIds.push(row!.id)
  return row!.id
}

type StepSeed = {
  serverId: string
  unit?: UpgradeStepUnit
  phase?: UpgradePhase
  status: UpgradeStepStatus
  attempts?: number
  fromVersion?: string
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  errorMessage?: string
}

async function addRun(
  fx: Fixture,
  input: { status: UpgradeStatus; source?: 'manual' | 'auto' | 'server'; createdAt: string },
  steps: StepSeed[]
): Promise<string> {
  const id = crypto.randomUUID()
  await fx.db.insert(upgrade).values({
    id,
    createdAt: input.createdAt,
    source: input.source ?? 'manual',
    channel: 'canary',
    status: input.status,
    target: { daemon: { version: '0.1.15', commit: 'new' }, instance: null, ui: null },
    startedAt: input.createdAt,
    finishedAt: input.createdAt,
    counts: {
      total: steps.length,
      done: 0,
      skipped: 0,
      failed: 0,
      needsAttention: 0,
      inProgress: 0,
    },
  })
  fx.runIds.push(id)
  if (steps.length > 0) {
    await fx.db.insert(stage).values(
      steps.map((step) => ({
        upgradeId: id,
        serverId: step.serverId,
        unit: step.unit ?? 'daemon',
        phase: step.phase ?? 'fleet',
        status: step.status,
        attempts: step.attempts ?? 0,
        fromVersion: step.fromVersion ?? '0.1.14',
        toVersion: '0.1.15',
        fromCommit: 'old',
        toCommit: 'new',
        statusChangedAt: step.finishedAt ?? input.createdAt,
        startedAt: step.startedAt ?? null,
        finishedAt: step.finishedAt ?? null,
        errorCode: step.errorCode ?? null,
        errorMessage: step.errorMessage ?? null,
        detail: {},
      }))
    )
  }
  return id
}

function minutes(n: number): string {
  return new Date(Date.parse(T0) + n * 60_000).toISOString()
}

function historyQuery(params: Record<string, string>) {
  const query = parseHistoryQuery(params)
  if ('error' in query) throw new Error(query.field)
  return { ...query, limit: 100 }
}

function serversQuery(params: Record<string, string>) {
  const query = parseRunServersQuery(params)
  if ('error' in query) throw new Error(query.field)
  return query
}

test('a run where every host was already current counts no server as updated', async () => {
  await withFixture('already current', async (fx) => {
    const s1 = await addServer(fx, 'web-1', fx.orgA)
    const s2 = await addServer(fx, 'web-2', fx.orgA)
    const noop = await addRun(fx, { status: 'succeeded', createdAt: minutes(-60) }, [
      { serverId: s1, status: 'done', fromVersion: '0.1.15' },
      { serverId: s2, status: 'done', fromVersion: '0.1.15' },
    ])
    const real = await addRun(fx, { status: 'partially_failed', createdAt: minutes(-30) }, [
      { serverId: s1, status: 'done', attempts: 1 },
      { serverId: s2, status: 'failed', attempts: 3, errorCode: 'step_timeout' },
    ])
    const pruned = await addRun(fx, { status: 'succeeded', createdAt: minutes(-90) }, [])
    const page = await readHistoryPage(fx.db, historyQuery({ status: 'any' }))
    const mine = page.runs.filter((run) => fx.runIds.includes(run.id))
    assertEquals(
      mine.map((run) => run.id),
      [real, noop, pruned]
    )
    const byId = new Map(mine.map((run) => [run.id, run]))
    assertEquals(byId.get(noop)?.summary, {
      detail: 'steps',
      total: 2,
      updated: 0,
      alreadyCurrent: 2,
      skipped: 0,
      failed: 0,
      inProgress: 0,
    })
    assertEquals(byId.get(real)?.summary.updated, 1)
    assertEquals(byId.get(real)?.summary.failed, 1)
    assertEquals(byId.get(pruned)?.summary.detail, 'pruned')
    assertEquals(byId.get(pruned)?.summary.updated, null)
    assertEquals(byId.get(noop)?.trigger, 'manual')
  })
})

test('history filters by status and trigger', async () => {
  await withFixture('history filters', async (fx) => {
    const s1 = await addServer(fx, 'db-1', fx.orgA)
    const auto = await addRun(
      fx,
      { status: 'succeeded', source: 'auto', createdAt: minutes(-10) },
      [{ serverId: s1, status: 'done', attempts: 1 }]
    )
    const failed = await addRun(fx, { status: 'failed', createdAt: minutes(-5) }, [
      { serverId: s1, status: 'failed', attempts: 3 },
    ])
    const automatic = await readHistoryPage(fx.db, historyQuery({ trigger: 'automatic' }))
    assert(automatic.runs.some((run) => run.id === auto))
    assert(!automatic.runs.some((run) => run.id === failed))
    assert(automatic.runs.every((run) => run.trigger === 'automatic'))
    const onlyFailed = await readHistoryPage(fx.db, historyQuery({ status: 'failed' }))
    assert(onlyFailed.runs.some((run) => run.id === failed))
    assert(onlyFailed.runs.every((run) => run.status === 'failed'))
  })
})

test('a run page has one row per server with its components, counts and filters', async () => {
  await withFixture('run servers', async (fx) => {
    const host = await addServer(fx, 'control-plane', fx.orgA, true)
    const web = await addServer(fx, 'web-1', fx.orgA)
    const mail = await addServer(fx, 'mail-1', fx.orgB)
    const idle = await addServer(fx, 'idle-1', fx.orgB)
    const runId = await addRun(fx, { status: 'partially_failed', createdAt: minutes(0) }, [
      {
        serverId: host,
        unit: 'daemon',
        phase: 'colocated_daemon',
        status: 'done',
        attempts: 1,
        startedAt: minutes(1),
        finishedAt: minutes(3),
      },
      {
        serverId: host,
        unit: 'instance',
        phase: 'control_plane',
        status: 'done',
        attempts: 1,
        startedAt: minutes(3),
        finishedAt: minutes(8),
      },
      {
        serverId: web,
        status: 'needs_attention',
        attempts: 3,
        startedAt: minutes(9),
        finishedAt: minutes(20),
        errorCode: 'step_timeout',
        errorMessage: 'No progress for 15 minutes.',
      },
      { serverId: mail, status: 'skipped', errorCode: 'server_offline' },
      { serverId: idle, status: 'done', fromVersion: '0.1.15' },
    ])
    const page = await readRunServersPage(fx.db, null, runId, serversQuery({}))
    assert(page)
    assertEquals(page.units, ['daemon', 'instance'])
    assertEquals(page.statusCounts, {
      all: 4,
      failed: 1,
      in_progress: 0,
      skipped: 1,
      updated: 1,
      already_current: 1,
    })
    assertEquals(page.total, 4)
    assertEquals(
      page.servers.map((row) => [row.serverName, row.status]),
      [
        ['web-1', 'failed'],
        ['mail-1', 'skipped'],
        ['control-plane', 'updated'],
        ['idle-1', 'already_current'],
      ]
    )
    const plane = page.servers.find((row) => row.serverId === host)!
    assertEquals(plane.components.daemon?.outcome, 'updated')
    assertEquals(plane.components.instance?.outcome, 'updated')
    assertEquals(plane.startedAt, minutes(1))
    assertEquals(plane.finishedAt, minutes(8))
    assertEquals(plane.durationMs, 7 * 60_000)
    assertEquals(plane.attempts, 2)
    assert(plane.datacenterName?.startsWith('Tokyo'))
    assert(plane.organizationName?.startsWith('Alpha'))
    const failedRow = page.servers[0]!
    assertEquals(failedRow.errorCode, 'step_timeout')
    assertEquals(failedRow.errorMessage, 'No progress for 15 minutes.')
    const skipped = page.servers[1]!
    assertEquals(skipped.errorCode, 'server_offline')
    assertEquals(skipped.startedAt, null)
    assertEquals(page.organizations.length, 2)
    assertEquals(
      page.organizations.map((org) => org.servers),
      [2, 2]
    )
    assertEquals(page.run.summary.updated, 1)
    assertEquals(page.run.summary.alreadyCurrent, 1)

    const orgB = await readRunServersPage(
      fx.db,
      null,
      runId,
      serversQuery({ organizationId: fx.orgB, sort: 'server' })
    )
    assertEquals(
      orgB?.servers.map((row) => row.serverName),
      ['idle-1', 'mail-1']
    )
    assertEquals(orgB?.statusCounts.all, 2)

    const onlyCurrent = await readRunServersPage(
      fx.db,
      null,
      runId,
      serversQuery({ status: 'already_current' })
    )
    assertEquals(
      onlyCurrent?.servers.map((row) => row.serverId),
      [idle]
    )
    assertEquals(onlyCurrent?.total, 1)
    assertEquals(onlyCurrent?.statusCounts.all, 4)

    const search = await readRunServersPage(fx.db, null, runId, serversQuery({ q: 'WEB' }))
    assertEquals(
      search?.servers.map((row) => row.serverId),
      [web]
    )
    const byId = await readRunServersPage(fx.db, null, runId, serversQuery({ q: mail }))
    assertEquals(
      byId?.servers.map((row) => row.serverId),
      [mail]
    )
    const literal = await readRunServersPage(fx.db, null, runId, serversQuery({ q: '%' }))
    assertEquals(literal?.servers.length, 0)

    const longest = await readRunServersPage(
      fx.db,
      null,
      runId,
      serversQuery({ sort: 'duration', dir: 'desc', limit: '1' })
    )
    assertEquals(
      longest?.servers.map((row) => row.serverId),
      [web]
    )
    assertEquals(longest?.total, 4)
    const second = await readRunServersPage(
      fx.db,
      null,
      runId,
      serversQuery({ sort: 'duration', dir: 'desc', limit: '1', offset: '1' })
    )
    assertEquals(
      second?.servers.map((row) => row.serverId),
      [host]
    )
    const one = await readRunServersPage(fx.db, null, runId, serversQuery({ serverId: host }))
    assertEquals(one?.servers.length, 1)
    assertEquals(one?.servers[0]?.components.instance?.phase, 'control_plane')
  })
})

test('an unknown run has no server page', async () => {
  await withFixture('unknown run', async (fx) => {
    assertEquals(await readRunServersPage(fx.db, null, crypto.randomUUID(), serversQuery({})), null)
  })
})

test('saving a step stamps its first dispatch and its finish, and a retry reopens it', async () => {
  await withFixture('step times', async (fx) => {
    const s1 = await addServer(fx, 'stamp-1', fx.orgA)
    // Saving a step does not read the run's status, so a finished run keeps
    // the one active slot free for the other suites.
    const runId = await addRun(fx, { status: 'failed', createdAt: minutes(0) }, [
      { serverId: s1, status: 'pending' },
    ])
    const store = createDrizzleUpgradeStore(fx.db, null)
    const [step] = await store.stepsFor(runId)
    assert(step)
    const read = async () =>
      (
        await fx.db
          .select({ startedAt: stage.startedAt, finishedAt: stage.finishedAt })
          .from(stage)
          .where(eq(stage.id, step.id))
      )[0]!
    await store.saveStep({ ...step, status: 'dispatched', attempts: 1 })
    const dispatched = await read()
    assert(dispatched.startedAt)
    assertEquals(dispatched.finishedAt, null)
    await store.saveStep({ ...step, status: 'failed', attempts: 1 })
    const failed = await read()
    assertEquals(failed.startedAt, dispatched.startedAt)
    assert(failed.finishedAt)
    await store.saveStep({ ...step, status: 'pending', attempts: 1 })
    const reopened = await read()
    assertEquals(reopened.startedAt, dispatched.startedAt)
    assertEquals(reopened.finishedAt, null)
  })
})
