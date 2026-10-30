import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  fabricReconcileAction,
  readFabricReconcileOutcome,
  stampFabricReconcileFinished,
  stampFabricReconcilePending,
} from './reconcile-outcome.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** One relay row; `select` returns it, `update` replaces its metadata. */
function oneRelayDb(metadata: Record<string, unknown> = {}): {
  db: Db
  metadata: () => Record<string, unknown>
} {
  let current = metadata
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ relayId: 'r1', metadata: current }]),
      }),
    }),
    update: () => ({
      set: (values: { metadata: Record<string, unknown> }) => ({
        where: () => {
          current = values.metadata
          return Promise.resolve()
        },
      }),
    }),
  } as unknown as Db
  return { db, metadata: () => current }
}

test('the action follows the payload: apply, pause or remove', () => {
  assertEquals(fabricReconcileAction({ enabled: false, retainKeys: true }), 'pause')
  assertEquals(fabricReconcileAction({ enabled: false }), 'remove')
  assertEquals(
    fabricReconcileAction({ enabled: true, prefix: '10.192.0.0/16', peers: [] }),
    'apply'
  )
})

test('a pause is pending until the server answers, then failed with its own message', async () => {
  const relay = oneRelayDb({ appliedPayloadHash: 'h1' })
  await stampFabricReconcilePending(relay.db, {
    serverId: 's1',
    commandId: 'c1',
    action: 'pause',
  })
  assertEquals(readFabricReconcileOutcome(relay.metadata())?.state, 'pending')
  // Other metadata stays.
  assertEquals(relay.metadata().appliedPayloadHash, 'h1')

  await stampFabricReconcileFinished(relay.db, {
    serverId: 's1',
    commandId: 'c1',
    action: 'pause',
    ok: false,
    error: 'TurboFabric pause did not finish: delete tp0: Operation not permitted',
  })
  const outcome = readFabricReconcileOutcome(relay.metadata())
  assertEquals(outcome?.state, 'failed')
  assertEquals(
    outcome?.error,
    'TurboFabric pause did not finish: delete tp0: Operation not permitted'
  )
})

test('a late answer to an older command never overwrites the newer one', async () => {
  const relay = oneRelayDb()
  await stampFabricReconcilePending(relay.db, { serverId: 's1', commandId: 'c2', action: 'apply' })
  await stampFabricReconcileFinished(relay.db, {
    serverId: 's1',
    commandId: 'c1',
    action: 'pause',
    ok: true,
  })
  const outcome = readFabricReconcileOutcome(relay.metadata())
  assertEquals(outcome?.commandId, 'c2')
  assertEquals(outcome?.state, 'pending')
})

test('an apply that worked keeps its warnings', async () => {
  const relay = oneRelayDb()
  await stampFabricReconcilePending(relay.db, { serverId: 's1', commandId: 'c1', action: 'apply' })
  await stampFabricReconcileFinished(relay.db, {
    serverId: 's1',
    commandId: 'c1',
    action: 'apply',
    ok: true,
    warnings: ['LAN route 10.194.0.0/16 via 10.10.3.86 not installed: eth0 already routes it'],
  })
  const outcome = readFabricReconcileOutcome(relay.metadata())
  assertEquals(outcome?.state, 'done')
  assertEquals(outcome?.warnings?.length, 1)
  assertEquals(outcome?.error, undefined)
})

test('a malformed stored outcome reads as none', () => {
  assertEquals(readFabricReconcileOutcome({ reconcile: { commandId: 'c1' } }), null)
  assertEquals(readFabricReconcileOutcome(null), null)
})

test('a failed write is only logged', async () => {
  const db = {
    select: () => {
      throw new Error('db down')
    },
  } as unknown as Db
  await stampFabricReconcilePending(db, { serverId: 's1', commandId: 'c1', action: 'pause' })
})
