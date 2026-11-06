import { assert, assertEquals } from '@std/assert'
import type { Db } from '../db/connection.ts'
import type { AuthenticatedMetricsSample } from './metrics/types.ts'
import { resolveIngestPlanAndReconcileTopology } from './api-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-4000-8000-000000000001'

/** A select chain (`select().from().leftJoin().where().limit()`) that finds no rows. */
function emptySelect(): unknown {
  const chain: Record<string, unknown> = {}
  for (const step of ['from', 'leftJoin', 'innerJoin', 'where', 'limit']) {
    chain[step] = () => chain
  }
  chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) =>
    Promise.resolve([]).then(resolve, reject)
  return chain
}

/**
 * A database whose reads find nothing (no recorded topology, no plan row) and
 * whose `execute` (the resync marker write) stays open until `release` runs.
 * Once the caller's request is over the client is closed, so a write that
 * settles after that fails the way a closed Workers client does.
 */
function heldWriteDb() {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const state = { executed: 0, requestOver: false, failedAfterClose: 0 }
  const db = {
    select: () => emptySelect(),
    execute: async () => {
      state.executed += 1
      await held
      if (state.requestOver) {
        state.failedAfterClose += 1
        throw new Error('write CONNECTION_ENDED')
      }
      return []
    },
  } as unknown as Db
  return { db, state, release }
}

function durableSample(): AuthenticatedMetricsSample {
  return {
    serverId: SERVER_ID,
    receivedAt: '2026-11-05T12:00:00.000Z',
    metadata: { version: 8, intervalSeconds: 60, sequence: 1 },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
  } as unknown as AuthenticatedMetricsSample
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test('the topology resync marker is written before ingest plan resolution returns', async () => {
  const { db, state, release } = heldWriteDb()
  let settled = false
  const resolving = resolveIngestPlanAndReconcileTopology(
    db,
    SERVER_ID,
    durableSample(),
    'self-hosted'
  ).then((result) => {
    // The handler returns once this settles, and the request's client closes.
    settled = true
    state.requestOver = true
    return result
  })

  // Let the reads finish: the marker write is now in flight and held open.
  for (let i = 0; i < 5; i += 1) await tick()
  assertEquals(state.executed, 1, 'an unknown topology stamps the resync marker')
  assertEquals(settled, false, 'the request must wait for the marker write')

  release()
  const result = await resolving
  await tick()

  assert(result.plan !== undefined)
  assertEquals(state.failedAfterClose, 0, 'no write may run on the closed client')
})
