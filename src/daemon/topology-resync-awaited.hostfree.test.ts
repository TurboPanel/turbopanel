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

/**
 * A query builder chain: every step returns the chain again, and awaiting it
 * (or calling `.catch` on it) runs `settle`.
 */
function queryChain(settle: () => Promise<unknown>): unknown {
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject?: (err: unknown) => unknown) =>
            settle().then(resolve, reject)
        }
        if (prop === 'catch') {
          return (onError: (err: unknown) => unknown) => settle().catch(onError)
        }
        return () => chain
      },
    }
  )
  return chain
}

/**
 * A database whose reads return `rows`, and whose writes (`execute` for the
 * resync marker, `update` for the machine class) stay open until `release`
 * runs. Once the caller's request is over the client is closed, so a write
 * that settles after that fails the way a closed Workers client does.
 */
function heldWriteDb(rows: unknown[]) {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const state = { writes: [] as string[], requestOver: false, failedAfterClose: 0 }
  const write = (label: string) => async () => {
    state.writes.push(label)
    await held
    if (state.requestOver) {
      state.failedAfterClose += 1
      throw new Error('write CONNECTION_ENDED')
    }
    return []
  }
  const db = {
    select: () => queryChain(() => Promise.resolve(rows)),
    execute: write('execute'),
    update: () => queryChain(write('update')),
    insert: () => queryChain(() => Promise.resolve([])),
  } as unknown as Db
  return { db, state, release }
}

function durableSample(hardwareSignals: unknown[] = []): AuthenticatedMetricsSample {
  return {
    serverId: SERVER_ID,
    receivedAt: '2026-11-05T12:00:00.000Z',
    metadata: { version: 8, intervalSeconds: 60, sequence: 1 },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals,
  } as unknown as AuthenticatedMetricsSample
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Resolve the ingest plan against `db`, mark the request over (its client
 * closed) when that returns, and report whether it returned while the writes
 * were still held open.
 */
async function resolveWithHeldWrites(
  heldDb: ReturnType<typeof heldWriteDb>,
  sample: AuthenticatedMetricsSample
) {
  let settled = false
  const resolving = resolveIngestPlanAndReconcileTopology(
    heldDb.db,
    SERVER_ID,
    sample,
    'self-hosted'
  ).then((result) => {
    // The handler returns once this settles, and the request's client closes.
    settled = true
    heldDb.state.requestOver = true
    return result
  })

  // Let the reads finish: the first write is now in flight and held open.
  for (let i = 0; i < 5; i += 1) await tick()
  const settledWhileHeld = settled

  heldDb.release()
  const result = await resolving
  await tick()
  return { result, settledWhileHeld }
}

test('the topology resync marker is written before ingest plan resolution returns', async () => {
  const heldDb = heldWriteDb([])
  const { result, settledWhileHeld } = await resolveWithHeldWrites(heldDb, durableSample())

  assertEquals(heldDb.state.writes, ['execute'], 'an unknown topology stamps the resync marker')
  assertEquals(settledWhileHeld, false, 'the request must wait for the marker write')
  assert(result.plan !== undefined)
  assertEquals(heldDb.state.failedAfterClose, 0, 'no write may run on the closed client')
})

test('a detected physical machine class is written before ingest plan resolution returns', async () => {
  // A server row with no recorded topology and no declared machine class,
  // whose resync marker was just stamped, so the machine class is the only write.
  const serverMetadata = { topologyResyncRequestedAt: new Date().toISOString() }
  const heldDb = heldWriteDb([
    { hardware: null, serverOptions: null, orgOptions: null, serverMetadata, machineClass: null },
  ])
  const sensor = { signalId: 'cpu.temperature' }
  const { result, settledWhileHeld } = await resolveWithHeldWrites(heldDb, durableSample([sensor]))

  assertEquals(heldDb.state.writes, ['update'], 'a sensor reading records the machine class')
  assertEquals(settledWhileHeld, false, 'the request must wait for the machine class write')
  assert(result.plan !== undefined)
  assertEquals(heldDb.state.failedAfterClose, 0, 'no write may run on the closed client')
})
