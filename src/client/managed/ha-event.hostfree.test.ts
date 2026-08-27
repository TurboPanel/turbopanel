/**
 * Host-free coverage for daemon-observed HA events (Db doubles only).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { handleManagedHaEvent } from './ha-event.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MANAGED_ID = 'mgd-1'
const SERVER_A = '550e8400-e29b-41d4-a716-446655440000'
const NOW = '2026-01-01T00:00:00.000Z'

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-primary',
    managedId: MANAGED_ID,
    serverId: SERVER_A,
    role: 'primary',
    replicaClass: null,
    readEligible: true,
    ordinal: 1,
    replicationTransport: null,
    privatePort: 5432,
    status: 'ready',
    metadata: null,
    options: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function recoveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec-1',
    managedId: MANAGED_ID,
    kind: 'automatic-failover',
    sourcePrimaryMemberId: 'mem-primary',
    targetMemberId: null,
    state: 'fencing',
    startedAt: NOW,
    completedAt: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/**
 * Drizzle-shaped double: every builder method returns the same chain, and each
 * `await` consumes the next queued result set (queries run in call order).
 */
function fakeDb(resultSets: unknown[][], inserted?: unknown[]): Db {
  const queue = [...resultSets]
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          const promise = Promise.resolve(queue.shift() ?? [])
          return promise.then.bind(promise)
        }
        if (prop === 'catch' || prop === 'finally') return undefined
        return () => chain
      },
    },
  )
  return {
    select: () => chain,
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve(inserted ?? []),
      }),
    }),
  } as unknown as Db
}

test('handleManagedHaEvent returns null when the managed row is gone', async () => {
  const result = await handleManagedHaEvent(
    fakeDb([[]]),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A },
  )
  assertEquals(result, null)
})

test('handleManagedHaEvent returns null for an unknown engine', async () => {
  const result = await handleManagedHaEvent(
    fakeDb([[{ id: MANAGED_ID, engine: 'not-an-engine' }]]),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A },
  )
  assertEquals(result, null)
})

test('handleManagedHaEvent returns null when the cluster has no members', async () => {
  const result = await handleManagedHaEvent(
    fakeDb([[{ id: MANAGED_ID, engine: 'postgres' }], []]),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A },
  )
  assertEquals(result, null)
})

test('handleManagedHaEvent resumes an in-flight recovery instead of opening another', async () => {
  const inflight = recoveryRow()
  const result = await handleManagedHaEvent(
    fakeDb([
      [{ id: MANAGED_ID, engine: 'postgres' }],
      [member()],
      [inflight],
    ]),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-primary' },
    { reporterServerId: SERVER_A },
  )
  assertEquals(result?.id, 'rec-1')
  assertEquals(result?.state, 'fencing')
  assertEquals(result?.kind, 'automatic-failover')
})

test('handleManagedHaEvent returns null when no primary or source member exists', async () => {
  const result = await handleManagedHaEvent(
    fakeDb([
      [{ id: MANAGED_ID, engine: 'postgres' }],
      [member({ id: 'mem-other', role: 'replica', replicaClass: 'read' })],
      [],
    ]),
    { managedId: MANAGED_ID, sourceMemberId: 'missing' },
    { reporterServerId: SERVER_A },
  )
  assertEquals(result, null)
})

test('handleManagedHaEvent persists a blocked row when no failover candidate exists', async () => {
  const blocked = recoveryRow({ state: 'blocked', id: 'rec-blocked' })
  const result = await handleManagedHaEvent(
    fakeDb(
      [
        [{ id: MANAGED_ID, engine: 'postgres' }],
        [member()],
        [],
        [],
      ],
      [blocked],
    ),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A, commandQueue: { enqueue: async () => {} } as CommandQueue },
  )
  assertEquals(result?.id, 'rec-blocked')
  assertEquals(result?.state, 'blocked')
})

test('handleManagedHaEvent persists detecting when a candidate exists but the queue does not', async () => {
  const detecting = recoveryRow({
    id: 'rec-detect',
    state: 'detecting',
    targetMemberId: 'mem-replica',
  })
  const observedAt = new Date().toISOString()
  const result = await handleManagedHaEvent(
    fakeDb(
      [
        [{ id: MANAGED_ID, engine: 'postgres' }],
        [
          member(),
          member({
            id: 'mem-replica',
            role: 'replica',
            replicaClass: 'failover',
            ordinal: 2,
            metadata: {
              replication: {
                state: 'streaming',
                observedAt,
                lagBytes: 0,
                lagSeconds: 0,
              },
            },
          }),
        ],
        [],
        [
          {
            ipId: 'ip-1',
            serverId: SERVER_A,
            datacenterId: 'dc-east',
            networkId: 'net-1',
            address: '203.0.113.10',
          },
        ],
      ],
      [detecting],
    ),
    { managedId: MANAGED_ID, at: NOW },
    { reporterServerId: SERVER_A },
  )
  assertEquals(result?.id, 'rec-detect')
  assertEquals(result?.state, 'detecting')
})
