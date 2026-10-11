/**
 * Host-free coverage for the HA recovery completion gate: a failover is not
 * `completed` until every ingress (ProxySQL on each routing server) confirmed
 * the new primary.
 */

import { assertEquals, assertStringIncludes } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { command, recovery, replica, server } from '../../db/schema.ts'
import {
  decideIngressGate,
  evaluateIngressGate,
  failRecoveryIngressNotQueued,
  parkRecoveryAtIngressGate,
  settleIngressCommandForRecovery,
} from './ha-ingress-gate.ts'
import { onRecoveryCommandTimedOut } from './ha-recovery.ts'

/** Jest/Mocha-shaped alias so Sonar sees the tests (see ha-recovery.hostfree.test.ts). */
const test = Deno.test.bind(Deno)

const REC_ID = '00000000-0000-4000-8000-000000000010'
const MANAGED_ID = '00000000-0000-4000-8000-000000000001'
const SERVER_A = '550e8400-e29b-41d4-a716-446655440000'
const SERVER_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const SERVER_C = '7ba7b810-9dad-11d1-80b4-00c04fd430c9'
const NOW = '2026-01-01T00:00:00.000Z'

type RecoveryRow = Record<string, unknown> & {
  state: string
  metadata: Record<string, unknown>
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const chain: Record<string, unknown> = {}
  const self = () => chain
  chain.where = self
  chain.orderBy = self
  chain.limit = self
  chain.for = self
  chain.returning = () => promise
  chain.then = promise.then.bind(promise)
  chain.catch = promise.catch.bind(promise)
  chain.finally = promise.finally.bind(promise)
  return chain
}

function recoveryRow(overrides: Partial<RecoveryRow> = {}): RecoveryRow {
  return {
    id: REC_ID,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    options: null,
    managedId: MANAGED_ID,
    kind: 'switchover',
    sourcePrimaryMemberId: '00000000-0000-4000-8000-000000000020',
    targetMemberId: '00000000-0000-4000-8000-000000000021',
    state: 'repointing',
    startedAt: NOW,
    completedAt: null,
    ...overrides,
  }
}

function harness(opts: {
  recovery: RecoveryRow
  commands?: Array<{ id: string; serverId: string; status: string }>
  writers?: number
}) {
  let stored = opts.recovery
  const commands = opts.commands ?? []
  const writers = opts.writers ?? 1
  const servers = [
    { id: SERVER_A, name: 'alpha' },
    { id: SERVER_B, name: 'beta' },
    { id: SERVER_C, name: 'gamma' },
  ]
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === recovery) return thenableRows([stored])
        if (table === command) return thenableRows(commands)
        if (table === server) return thenableRows(servers)
        if (table === replica) {
          return thenableRows(
            Array.from({ length: writers }, (_, index) => ({
              id: `member-${index}`,
              managedId: MANAGED_ID,
              serverId: SERVER_A,
              role: 'primary',
              ordinal: index + 1,
              metadata: null,
              options: null,
              createdAt: NOW,
              updatedAt: NOW,
            }))
          )
        }
        return thenableRows([])
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        if (table === recovery) stored = { ...stored, ...patch } as RecoveryRow
        return {
          where: () => thenableRows(table === recovery ? [stored] : []),
        }
      },
    }),
    transaction: (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  }
  return {
    db: db as unknown as Db,
    commands,
    recovery: () => stored,
  }
}

test('decideIngressGate waits while any ingress command is still live', () => {
  const decision = decideIngressGate({
    requiredServerIds: [SERVER_A, SERVER_B],
    commands: [
      { id: 'c1', serverId: SERVER_A, status: 'succeeded' },
      { id: 'c2', serverId: SERVER_B, status: 'running' },
    ],
  })
  assertEquals(decision, { kind: 'wait' })
})

test('decideIngressGate completes only when every required server confirmed', () => {
  assertEquals(
    decideIngressGate({
      requiredServerIds: [SERVER_A, SERVER_B],
      commands: [
        { id: 'c1', serverId: SERVER_A, status: 'succeeded' },
        { id: 'c2', serverId: SERVER_B, status: 'succeeded' },
      ],
    }),
    { kind: 'complete' }
  )
  assertEquals(decideIngressGate({ requiredServerIds: [], commands: [] }), {
    kind: 'complete',
  })
})

test('decideIngressGate names servers whose repoint failed, timed out or was never queued', () => {
  const decision = decideIngressGate({
    requiredServerIds: [SERVER_A, SERVER_B, SERVER_C],
    commands: [
      { id: 'c1', serverId: SERVER_A, status: 'succeeded' },
      { id: 'c2', serverId: SERVER_B, status: 'timed_out' },
    ],
  })
  assertEquals(decision, { kind: 'degraded', serverIds: [SERVER_B, SERVER_C] })
})

test('the row stays at reconciling-ingress until the last ingress confirms', async () => {
  const h = harness({
    recovery: recoveryRow(),
    commands: [
      { id: 'c1', serverId: SERVER_A, status: 'succeeded' },
      { id: 'c2', serverId: SERVER_B, status: 'running' },
    ],
  })
  await parkRecoveryAtIngressGate(h.db, REC_ID, {
    requiredServerIds: [SERVER_A, SERVER_B],
    commandIds: ['c1', 'c2'],
  })
  // Trunk marked this completed as soon as the commands were queued.
  assertEquals(h.recovery().state, 'reconciling-ingress')
  assertEquals(h.recovery().metadata.ingressCommandIds, ['c1', 'c2'])

  await settleIngressCommandForRecovery(h.db, REC_ID)
  assertEquals(h.recovery().state, 'reconciling-ingress')

  h.commands[1].status = 'succeeded'
  await settleIngressCommandForRecovery(h.db, REC_ID)
  assertEquals(h.recovery().state, 'completed')
})

test('a result that lands before the row is parked is judged at once', async () => {
  const h = harness({
    recovery: recoveryRow(),
    commands: [{ id: 'c1', serverId: SERVER_A, status: 'succeeded' }],
  })
  await parkRecoveryAtIngressGate(h.db, REC_ID, {
    requiredServerIds: [SERVER_A],
    commandIds: ['c1'],
  })
  assertEquals(h.recovery().state, 'completed')
})

test('an ingress that failed ends the row failed, naming the server, never completed', async () => {
  const h = harness({
    recovery: recoveryRow({
      state: 'reconciling-ingress',
      metadata: {
        ingressCommandIds: ['c1', 'c2'],
        ingressServerIds: [SERVER_A, SERVER_B],
      },
    }),
    commands: [
      { id: 'c1', serverId: SERVER_A, status: 'succeeded' },
      { id: 'c2', serverId: SERVER_B, status: 'failed' },
    ],
  })
  await evaluateIngressGate(h.db, REC_ID)
  const row = h.recovery()
  assertEquals(row.state, 'failed')
  assertEquals(row.metadata.needsOperator, true)
  assertEquals(row.metadata.ingressNotRepointed, [SERVER_B])
  assertStringIncludes(String(row.metadata.failedReason), 'beta')
  assertStringIncludes(String(row.metadata.failedReason), 'Degraded')
})

test('a server whose repoint could not even be queued keeps the row from completing', async () => {
  const h = harness({ recovery: recoveryRow(), commands: [] })
  await parkRecoveryAtIngressGate(h.db, REC_ID, {
    requiredServerIds: [SERVER_C],
    commandIds: [],
  })
  assertEquals(h.recovery().state, 'failed')
  assertEquals(h.recovery().metadata.ingressNotRepointed, [SERVER_C])
})

test('all ingress confirmed but the cluster has two writers still fails the row', async () => {
  const h = harness({
    recovery: recoveryRow(),
    commands: [{ id: 'c1', serverId: SERVER_A, status: 'succeeded' }],
    writers: 2,
  })
  await parkRecoveryAtIngressGate(h.db, REC_ID, {
    requiredServerIds: [SERVER_A],
    commandIds: ['c1'],
  })
  assertEquals(h.recovery().state, 'failed')
})

test('nothing queued at all ends the row failed for the operator', async () => {
  const h = harness({ recovery: recoveryRow() })
  await failRecoveryIngressNotQueued(h.db, REC_ID, [SERVER_A, SERVER_B])
  assertEquals(h.recovery().state, 'failed')
  assertEquals(h.recovery().metadata.needsOperator, true)
  assertEquals(h.recovery().metadata.ingressNotRepointed, [SERVER_A, SERVER_B])
})

test('judging a row that is not parked at the gate changes nothing', async () => {
  const h = harness({
    recovery: recoveryRow({ state: 'promoting' }),
    commands: [{ id: 'c1', serverId: SERVER_A, status: 'succeeded' }],
  })
  await evaluateIngressGate(h.db, REC_ID)
  await settleIngressCommandForRecovery(h.db, null)
  assertEquals(h.recovery().state, 'promoting')
})

test('an ingress command the sweep timed out settles the row through the timeout hook', async () => {
  const h = harness({
    recovery: recoveryRow({
      state: 'reconciling-ingress',
      metadata: {
        ingressCommandIds: ['c1', 'c2'],
        ingressServerIds: [SERVER_A, SERVER_B],
      },
    }),
    commands: [
      { id: 'c1', serverId: SERVER_A, status: 'succeeded' },
      { id: 'c2', serverId: SERVER_B, status: 'timed_out' },
    ],
  })
  await onRecoveryCommandTimedOut(h.db, {
    recoveryId: REC_ID,
    commandId: 'c2',
    type: 'managed.ingress.reconcile',
    fencePhase: null,
  })
  assertEquals(h.recovery().state, 'failed')
  assertEquals(h.recovery().metadata.ingressNotRepointed, [SERVER_B])
})

test('an expired TTL transitions to timed_out and settles a reconciling-ingress recovery to failed', async () => {
  const h = harness({
    recovery: recoveryRow({
      state: 'reconciling-ingress',
      metadata: {
        ingressCommandIds: ['c1', 'c2'],
        ingressServerIds: [SERVER_A, SERVER_B],
      },
    }),
    commands: [
      { id: 'c1', serverId: SERVER_A, status: 'succeeded' },
      { id: 'c2', serverId: SERVER_B, status: 'running' },
    ],
  })

  // Simulate what happens when a command record expires and needs to be transitioned
  h.commands[1].status = 'timed_out'
  await settleIngressCommandForRecovery(h.db, REC_ID)

  assertEquals(h.recovery().state, 'failed')
  assertEquals(h.recovery().metadata.needsOperator, true)
  assertEquals(h.recovery().metadata.ingressNotRepointed, [SERVER_B])
})

test('a missing dispatch payload transitions to failed and settles a recovery to failed', async () => {
  const h = harness({
    recovery: recoveryRow({
      state: 'reconciling-ingress',
      metadata: {
        ingressCommandIds: ['c1'],
        ingressServerIds: [SERVER_A],
      },
    }),
    commands: [{ id: 'c1', serverId: SERVER_A, status: 'running' }],
  })

  // Simulate what happens when a command fails due to missing dispatch payload
  h.commands[0].status = 'failed'
  await settleIngressCommandForRecovery(h.db, REC_ID)

  assertEquals(h.recovery().state, 'failed')
  assertEquals(h.recovery().metadata.needsOperator, true)
  assertEquals(h.recovery().metadata.ingressNotRepointed, [SERVER_A])
})
