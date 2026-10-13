/**
 * Host-free coverage for principals reconcile enqueue (Db doubles only).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  enqueuePrincipalsReconcile,
  principalIdsOnServer,
  reconcilePrincipalAccess,
  reconcilePrincipalsAccess,
  retireDeletedPrincipal,
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

const MATERIAL_ROW = { id: PRINCIPAL, username: 'prin_1', options: null, password: null }

/**
 * Join queries return `{ serverId, principalId }` so both `serversForPrincipal`
 * and `principalIdsOnServer` can share one shape. The plain select answers
 * `loadPrincipalMaterial` with `materialRows` (default: one account whenever
 * there are join rows, so a server with accounts gets a non-empty set).
 * `stillPlaced` answers `principalsStillOnServer` for `retireDeletedPrincipal`.
 */
function reconcileDb(options: {
  joinRows?: Array<{ serverId: string; principalId: string }>
  materialRows?: Array<typeof MATERIAL_ROW>
  stillPlaced?: string[]
  insertEmpty?: boolean
  /** Servers / accounts the placements table adds beyond the project reach. */
  placedServerIds?: string[]
  placedPrincipalIds?: string[]
}): Db {
  const joinRows = options.joinRows ?? []
  const created = commandRow()
  const failed = commandRow({
    status: 'failed',
    errorMessage: 'Failed to enqueue principals reconcile',
  })
  // `loadPrincipalMaterial` issues two plain selects per server (accounts,
  // then their keys); the first of each pair carries the material.
  let plainSelects = 0
  const nextPlainSelect = () =>
    plainSelects++ % 2 === 0
      ? (options.materialRows ?? (joinRows.length > 0 ? [MATERIAL_ROW] : []))
      : []

  const thenableValues = () => {
    const promise = Promise.resolve(undefined)
    return Object.assign(promise, {
      returning: () => Promise.resolve(options.insertEmpty ? [] : [created]),
    })
  }

  return {
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        innerJoin: () => ({
          // Placement account lookup: one join to `principal`.
          where: () =>
            Promise.resolve(
              (options.placedPrincipalIds ?? []).map((principalId) => ({ principalId }))
            ),
          innerJoin: () => ({
            where: () => Promise.resolve(joinRows),
          }),
        }),
        where: () =>
          Promise.resolve(
            // Placement server lookup selects only `serverId`; material lookups never do.
            fields && Object.keys(fields).join() === 'serverId'
              ? (options.placedServerIds ?? []).map((serverId) => ({ serverId }))
              : nextPlainSelect()
          ),
      }),
    }),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          leftJoin: () => ({
            where: () =>
              Promise.resolve((options.stillPlaced ?? []).map((username) => ({ username }))),
          }),
        }),
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

test('serversForPrincipal adds hosts only a placement knows (a principal whose project was deleted)', async () => {
  const db = reconcileDb({ placedServerIds: [SERVER_B, SERVER_A] })
  assertEquals(await serversForPrincipal(db, PRINCIPAL), [SERVER_B, SERVER_A])
  const both = reconcileDb({
    joinRows: [{ serverId: SERVER_A, principalId: PRINCIPAL }],
    placedServerIds: [SERVER_A, SERVER_B],
  })
  assertEquals(await serversForPrincipal(both, PRINCIPAL), [SERVER_A, SERVER_B])
})

test('principalIdsOnServer keeps an orphaned principal in the complete set via its placement', async () => {
  const db = reconcileDb({
    joinRows: [{ serverId: SERVER_A, principalId: PRINCIPAL }],
    placedPrincipalIds: ['prin-orphan', PRINCIPAL],
  })
  assertEquals(await principalIdsOnServer(db, SERVER_A), [PRINCIPAL, 'prin-orphan'])
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
  const outcome = await enqueuePrincipalsReconcile(reconcileDb({}), undefined, ACTOR, [
    SERVER_A,
    SERVER_B,
  ])
  assertEquals(outcome, {
    queuedServerIds: [],
    failedServerIds: [SERVER_A, SERVER_B],
  })
})

const ON_SERVER_A = [{ serverId: SERVER_A, principalId: PRINCIPAL }]

test('enqueuePrincipalsReconcile queues a full-state command per server', async () => {
  const queue = recordingQueue()
  const outcome = await enqueuePrincipalsReconcile(
    reconcileDb({ joinRows: ON_SERVER_A }),
    queue,
    ACTOR,
    [SERVER_A]
  )
  assertEquals(outcome, { queuedServerIds: [SERVER_A], failedServerIds: [] })
  assertEquals(queue.envelopes.length, 1)
  assertEquals(queue.envelopes[0]?.type, 'server.principals.reconcile')
  assertEquals(queue.envelopes[0]?.serverId, SERVER_A)
  assertEquals(queue.envelopes[0]?.attempt, 1)
})

test('enqueuePrincipalsReconcile skips a server whose managed set is empty', async () => {
  // An empty set would tell the daemon to remove every key file on the host.
  const queue = recordingQueue()
  const outcome = await enqueuePrincipalsReconcile(reconcileDb({ joinRows: [] }), queue, ACTOR, [
    SERVER_A,
  ])
  assertEquals(outcome, { queuedServerIds: [], failedServerIds: [] })
  assertEquals(queue.envelopes, [])
})

test('enqueuePrincipalsReconcile still sends an empty set when there is an account to retire', async () => {
  const queue = recordingQueue()
  const outcome = await enqueuePrincipalsReconcile(
    reconcileDb({ joinRows: [] }),
    queue,
    ACTOR,
    [SERVER_A],
    { retirePrincipals: ['gone', 'gone'] }
  )
  assertEquals(outcome, { queuedServerIds: [SERVER_A], failedServerIds: [] })
  assertEquals(queue.envelopes.length, 1)
})

test('enqueuePrincipalsReconcile marks failed when enqueue throws', async () => {
  const outcome = await enqueuePrincipalsReconcile(
    reconcileDb({ joinRows: ON_SERVER_A }),
    recordingQueue(true),
    ACTOR,
    [SERVER_A]
  )
  assertEquals(outcome, { queuedServerIds: [], failedServerIds: [SERVER_A] })
})

test('enqueuePrincipalsReconcile marks failed when command insert is empty', async () => {
  const outcome = await enqueuePrincipalsReconcile(
    reconcileDb({ joinRows: ON_SERVER_A, insertEmpty: true }),
    recordingQueue(),
    ACTOR,
    [SERVER_A]
  )
  assertEquals(outcome, { queuedServerIds: [], failedServerIds: [SERVER_A] })
})

test('retireDeletedPrincipal retires on servers nothing else still places the login on', async () => {
  const queue = recordingQueue()
  const outcome = await retireDeletedPrincipal(
    reconcileDb({ joinRows: ON_SERVER_A }),
    queue,
    ACTOR,
    { serverIds: [SERVER_A, SERVER_B], appliedUsername: 'gone' }
  )
  assertEquals(outcome, { queuedServerIds: [SERVER_A, SERVER_B], failedServerIds: [] })
  assertEquals(
    queue.envelopes.map((envelope) => envelope.serverId),
    [SERVER_A, SERVER_B]
  )
})

test('retireDeletedPrincipal keeps the account where another row still places it', async () => {
  const queue = recordingQueue()
  const outcome = await retireDeletedPrincipal(
    reconcileDb({ joinRows: [], stillPlaced: ['gone'] }),
    queue,
    ACTOR,
    { serverIds: [SERVER_A], appliedUsername: 'gone' }
  )
  // Nothing to retire and no managed set left to send: no command at all.
  assertEquals(outcome, { queuedServerIds: [], failedServerIds: [] })
  assertEquals(queue.envelopes, [])
})

test('reconcilePrincipalAccess resolves hosts then enqueues', async () => {
  const queue = recordingQueue()
  const outcome = await reconcilePrincipalAccess(
    reconcileDb({
      joinRows: [{ serverId: SERVER_A, principalId: PRINCIPAL }],
    }),
    queue,
    ACTOR,
    PRINCIPAL
  )
  assertEquals(outcome.queuedServerIds, [SERVER_A])
  assertEquals(outcome.failedServerIds, [])
})

test('reconcilePrincipalsAccess is a no-op for an empty id set', async () => {
  const outcome = await reconcilePrincipalsAccess(reconcileDb({}), recordingQueue(), ACTOR, [])
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
    [PRINCIPAL, 'prin-2']
  )
  assertEquals(outcome.queuedServerIds, [SERVER_A, SERVER_B])
  assertEquals(outcome.failedServerIds, [])
})
