/**
 * Host-free coverage for principals reconcile enqueue (Db doubles only).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  enqueuePrincipalsReconcile,
  principalIdsOnServer,
  reconcilePrincipalAccess,
  reconcilePrincipalsAccess,
  serversForPrincipal,
} from './reconcile.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ACTOR = { actorType: 'user', actorId: 'actor-1' }
const SERVER_A = 'srv-a'
const SERVER_B = 'srv-b'
const PRINCIPAL = 'prin-1'

function commandRow(overrides: Record<string, unknown> = {}) {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    id: 'cmd-1',
    createdAt: now,
    updatedAt: now,
    serverId: SERVER_A,
    actorType: ACTOR.actorType,
    actorId: ACTOR.actorId,
    name: 'server.principals.reconcile',
    status: 'queued',
    attempts: 0,
    context: null,
    resultSummary: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: now,
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

function recordingQueue(fail = false): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: async (envelope) => {
      if (fail) throw new TypeError('queue unavailable')
      envelopes.push(envelope)
    },
  }
}

/**
 * Join queries return `{ serverId, principalId }` so both `serversForPrincipal`
 * and `principalIdsOnServer` can share one shape. Empty `principalIds` keeps
 * `loadPrincipalMaterial` from issuing extra selects.
 */
function reconcileDb(options: {
  joinRows?: Array<{ serverId: string; principalId: string }>
  insertEmpty?: boolean
}): Db {
  const joinRows = options.joinRows ?? []
  const created = commandRow()
  const failed = commandRow({ status: 'failed', errorMessage: 'Failed to enqueue principals reconcile' })

  const thenableValues = () => {
    const promise = Promise.resolve(undefined)
    return Object.assign(promise, {
      returning: () =>
        Promise.resolve(options.insertEmpty ? [] : [created]),
    })
  }

  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve(joinRows),
          }),
        }),
        where: () => Promise.resolve([]),
      }),
    }),
    // createCommandRecord writes command + dispatch in one transaction.
    transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(this)
    },
    insert: () => ({
      values: () => thenableValues(),
    }),
    update: () => ({
      set: () => ({
        where: () =>
          Object.assign(Promise.resolve(undefined), {
            returning: () => Promise.resolve([failed]),
          }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(undefined),
    }),
  } as unknown as Db
}

test('serversForPrincipal dedupes hosts that have an assigned environment', async () => {
  const db = reconcileDb({
    joinRows: [
      { serverId: SERVER_A, principalId: PRINCIPAL },
      { serverId: SERVER_A, principalId: PRINCIPAL },
      { serverId: SERVER_B, principalId: PRINCIPAL },
    ],
  })
  assertEquals(await serversForPrincipal(db, PRINCIPAL), [SERVER_A, SERVER_B])
})

test('principalIdsOnServer dedupes accounts materialized on one host', async () => {
  const db = reconcileDb({
    joinRows: [
      { serverId: SERVER_A, principalId: PRINCIPAL },
      { serverId: SERVER_A, principalId: PRINCIPAL },
      { serverId: SERVER_A, principalId: 'prin-2' },
    ],
  })
  assertEquals(await principalIdsOnServer(db, SERVER_A), [PRINCIPAL, 'prin-2'])
})

test('enqueuePrincipalsReconcile marks every server failed when the queue is missing', async () => {
  const outcome = await enqueuePrincipalsReconcile(
    reconcileDb({}),
    undefined,
    ACTOR,
    [SERVER_A, SERVER_B],
  )
  assertEquals(outcome, {
    queuedServerIds: [],
    failedServerIds: [SERVER_A, SERVER_B],
  })
})

test('enqueuePrincipalsReconcile queues a full-state command per server', async () => {
  const queue = recordingQueue()
  const outcome = await enqueuePrincipalsReconcile(
    reconcileDb({ joinRows: [] }),
    queue,
    ACTOR,
    [SERVER_A],
  )
  assertEquals(outcome, { queuedServerIds: [SERVER_A], failedServerIds: [] })
  assertEquals(queue.envelopes.length, 1)
  assertEquals(queue.envelopes[0]?.type, 'server.principals.reconcile')
  assertEquals(queue.envelopes[0]?.serverId, SERVER_A)
  assertEquals(queue.envelopes[0]?.attempt, 1)
})

test('enqueuePrincipalsReconcile marks failed when enqueue throws', async () => {
  const outcome = await enqueuePrincipalsReconcile(
    reconcileDb({ joinRows: [] }),
    recordingQueue(true),
    ACTOR,
    [SERVER_A],
  )
  assertEquals(outcome, { queuedServerIds: [], failedServerIds: [SERVER_A] })
})

test('enqueuePrincipalsReconcile marks failed when command insert is empty', async () => {
  const outcome = await enqueuePrincipalsReconcile(
    reconcileDb({ joinRows: [], insertEmpty: true }),
    recordingQueue(),
    ACTOR,
    [SERVER_A],
  )
  assertEquals(outcome, { queuedServerIds: [], failedServerIds: [SERVER_A] })
})

test('reconcilePrincipalAccess resolves hosts then enqueues', async () => {
  const queue = recordingQueue()
  const outcome = await reconcilePrincipalAccess(
    reconcileDb({
      joinRows: [{ serverId: SERVER_A, principalId: PRINCIPAL }],
    }),
    queue,
    ACTOR,
    PRINCIPAL,
  )
  assertEquals(outcome.queuedServerIds, [SERVER_A])
  assertEquals(outcome.failedServerIds, [])
})

test('reconcilePrincipalsAccess is a no-op for an empty id set', async () => {
  const outcome = await reconcilePrincipalsAccess(
    reconcileDb({}),
    recordingQueue(),
    ACTOR,
    [],
  )
  assertEquals(outcome, { queuedServerIds: [], failedServerIds: [] })
})

test('reconcilePrincipalsAccess dedupes hosts across principals', async () => {
  const queue = recordingQueue()
  const outcome = await reconcilePrincipalsAccess(
    reconcileDb({
      joinRows: [
        { serverId: SERVER_A, principalId: PRINCIPAL },
        { serverId: SERVER_A, principalId: 'prin-2' },
        { serverId: SERVER_B, principalId: 'prin-2' },
      ],
    }),
    queue,
    ACTOR,
    [PRINCIPAL, 'prin-2'],
  )
  assertEquals(outcome.queuedServerIds, [SERVER_A, SERVER_B])
  assertEquals(outcome.failedServerIds, [])
})
