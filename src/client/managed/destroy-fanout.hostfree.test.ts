/**
 * Host-free coverage for the asynchronous `managed.destroy` fan-out.
 *
 * The route must return once the replica destroys are durably enqueued — never
 * poll for their completion — and the primary destroy must be carried on
 * command metadata so the consumer releases it only after every replica
 * succeeded. These tests pin the three paths that matter: the happy gate, the
 * failure path that leaves the primary intact, and the force path that
 * deliberately skips the gate.
 */

import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import { command } from '../../lib/db/schema.ts'
import {
  enqueueManagedDestroyFanout,
  MANAGED_DESTROY_GATE_METADATA_KEY,
} from './apply-prepare.ts'
import { parseManagedDestroyGate } from './destroy-gate.ts'
import type { ManagedMemberRow } from './members.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MANAGED_ID = '33333333-3333-4333-8333-333333333333'
const ENVIRONMENT_ID = '44444444-4444-4444-8444-444444444444'

function member(
  overrides: Partial<ManagedMemberRow> & Pick<ManagedMemberRow, 'id' | 'role'>,
): ManagedMemberRow {
  return {
    managedId: MANAGED_ID,
    serverId: `srv-${overrides.id}`,
    replicaClass: null,
    readEligible: false,
    ordinal: 1,
    replicationTransport: null,
    privatePort: null,
    status: 'ready',
    metadata: null,
    options: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

type RecordedCommand = {
  id: string
  serverId: string
  type: string
  metadata: Record<string, unknown> | undefined
  payload: Record<string, unknown>
}

function mockContext(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

/**
 * Minimal `createCommandRecord` double: one `command` insert followed by its
 * `dispatch` insert, inside a transaction.
 */
function stubDb(recorded: RecordedCommand[]): Db {
  let counter = 0
  // A fresh scope per transaction: the fan-out runs its enqueues concurrently,
  // so a shared "last inserted command" slot would cross the wires.
  const makeTx = () => {
    let pending: Omit<RecordedCommand, 'payload'> | null = null
    return {
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          if (table === command) {
            counter += 1
            const id = `cmd-${counter}`
            pending = {
              id,
              serverId: values.serverId as string,
              type: values.name as string,
              metadata: values.metadata as Record<string, unknown> | undefined,
            }
            return {
              returning: () =>
                Promise.resolve([{
                  id,
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                  serverId: values.serverId,
                  actorType: values.actorType,
                  actorId: values.actorId,
                  name: values.name,
                  status: 'queued',
                  attempts: 0,
                  context: null,
                  resultSummary: null,
                  errorCode: null,
                  errorMessage: null,
                  queuedAt: '2026-01-01T00:00:00.000Z',
                  dispatchStartedAt: null,
                  sentAt: null,
                  ackedAt: null,
                  startedAt: null,
                  finishedAt: null,
                  expiresAt: values.expiresAt ?? null,
                }]),
            }
          }
          if (!pending) throw new TypeError('dispatch insert without a command')
          recorded.push({
            ...pending,
            payload: values.payload as Record<string, unknown>,
          })
          pending = null
          return Promise.resolve([])
        },
      }),
    }
  }
  return {
    transaction: (fn: (t: ReturnType<typeof makeTx>) => Promise<unknown>) =>
      fn(makeTx()),
    // `transitionCommand` marks a command failed when the queue rejects.
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      }),
    }),
  } as unknown as Db
}

function okQueue(sent: CommandEnvelope[]): CommandQueue {
  return {
    enqueue: (envelope: CommandEnvelope) => {
      sent.push(envelope)
      return Promise.resolve()
    },
  } as unknown as CommandQueue
}

/** Fails only for `failServerId`, so one replica can fail while others queue. */
function partiallyFailingQueue(
  sent: CommandEnvelope[],
  failServerId: string,
): CommandQueue {
  return {
    enqueue: (envelope: CommandEnvelope) => {
      if (envelope.serverId === failServerId) {
        return Promise.reject(new Error('queue down'))
      }
      sent.push(envelope)
      return Promise.resolve()
    },
  } as unknown as CommandQueue
}

const PRIMARY = member({ id: 'p1', role: 'primary', ordinal: 1 })
const REPLICA_A = member({ id: 'r1', role: 'replica', ordinal: 2 })
const REPLICA_B = member({ id: 'r2', role: 'replica', ordinal: 3 })

function destroyParams(
  members: ManagedMemberRow[],
  force = false,
) {
  return {
    userId: 'user-1',
    managedId: MANAGED_ID,
    removeVolumes: true,
    members,
    deleteAfterDestroy: true,
    environmentId: ENVIRONMENT_ID,
    force,
  }
}

test('destroy fan-out enqueues replicas only and defers the primary to metadata', async () => {
  const recorded: RecordedCommand[] = []
  const sent: CommandEnvelope[] = []
  const results = await enqueueManagedDestroyFanout(
    mockContext(),
    stubDb(recorded),
    okQueue(sent),
    destroyParams([PRIMARY, REPLICA_A, REPLICA_B]),
  )
  if (results instanceof Response) throw new TypeError('expected results')

  // Only the two replicas reach the queue in this pass.
  assertEquals(recorded.length, 2)
  assertEquals(sent.length, 2)
  assertEquals(
    recorded.map((row) => row.payload.memberId).toSorted(),
    ['r1', 'r2'],
  )
  for (const row of recorded) {
    assertEquals(row.payload.deleteMemberAfterDestroy, true)
    // The row-removing marker never rides on a replica.
    assertEquals(row.payload.deleteAfterDestroy, undefined)
  }

  // The primary is reported queued so the UI tracks it, without a command row.
  const primaryResult = results.find((row) => row.memberId === 'p1')
  assertEquals(primaryResult?.status, 'queued')
  assertEquals(primaryResult?.commandId, undefined)

  // Both replica commands carry the same gate, and the gate carries the
  // primary's fully-formed destroy payload.
  const gates = recorded.map((row) =>
    parseManagedDestroyGate(row.metadata?.[MANAGED_DESTROY_GATE_METADATA_KEY])
  )
  assertEquals(gates.every((gate) => gate !== null), true)
  assertEquals(gates[0]?.gateId, gates[1]?.gateId)
  assertEquals(gates[0]?.memberIds, ['r1', 'r2'])
  assertEquals(gates[0]?.followups.length, 1)
  assertEquals(gates[0]?.followups[0]?.memberId, 'p1')
  assertEquals(gates[0]?.followups[0]?.serverId, 'srv-p1')
  assertEquals(gates[0]?.followups[0]?.payload.deleteAfterDestroy, true)
  assertEquals(gates[0]?.followups[0]?.payload.managedId, MANAGED_ID)
  assertEquals(gates[0]?.followups[0]?.payload.environmentId, ENVIRONMENT_ID)
  assertEquals(
    gates[0]?.followups[0]?.payload.deleteMemberAfterDestroy,
    undefined,
  )
})

test('destroy fan-out leaves the primary intact when a replica cannot be enqueued', async () => {
  const recorded: RecordedCommand[] = []
  const sent: CommandEnvelope[] = []
  const results = await enqueueManagedDestroyFanout(
    mockContext(),
    stubDb(recorded),
    partiallyFailingQueue(sent, 'srv-r2'),
    destroyParams([PRIMARY, REPLICA_A, REPLICA_B]),
  )
  if (results instanceof Response) throw new TypeError('expected results')

  // A replica that never reached the queue can never open the gate, so the
  // primary must not be enqueued — and must be reported as failed, not queued.
  assertEquals(sent.map((envelope) => envelope.serverId), ['srv-r1'])
  assertEquals(
    recorded.filter((row) => row.payload.memberId === 'p1').length,
    0,
  )
  const primaryResult = results.find((row) => row.memberId === 'p1')
  assertEquals(primaryResult?.status, 'failed')
  assertEquals(
    primaryResult?.error,
    'Replica destroy failed before primary enqueue',
  )
  assertEquals(
    results.find((row) => row.memberId === 'r2')?.status,
    'failed',
  )
})

test('force destroy skips the gate and enqueues every member at once', async () => {
  const recorded: RecordedCommand[] = []
  const sent: CommandEnvelope[] = []
  const results = await enqueueManagedDestroyFanout(
    mockContext(),
    stubDb(recorded),
    okQueue(sent),
    destroyParams([PRIMARY, REPLICA_A, REPLICA_B], true),
  )
  if (results instanceof Response) throw new TypeError('expected results')

  assertEquals(recorded.length, 3)
  assertEquals(sent.length, 3)
  // Nothing is deferred: a force teardown must not depend on a replica host
  // that may be broken or offline.
  for (const row of recorded) {
    assertEquals(row.metadata?.[MANAGED_DESTROY_GATE_METADATA_KEY], undefined)
  }
  assertEquals(results.every((row) => row.status === 'queued'), true)
  assertEquals(results.every((row) => typeof row.commandId === 'string'), true)
  const primaryRow = recorded.find((row) => row.payload.memberId === 'p1')
  assertEquals(primaryRow?.payload.deleteAfterDestroy, true)
})

test('a single-member destroy needs no gate', async () => {
  const recorded: RecordedCommand[] = []
  const sent: CommandEnvelope[] = []
  const results = await enqueueManagedDestroyFanout(
    mockContext(),
    stubDb(recorded),
    okQueue(sent),
    destroyParams([PRIMARY]),
  )
  if (results instanceof Response) throw new TypeError('expected results')

  assertEquals(recorded.length, 1)
  assertEquals(recorded[0]?.metadata, undefined)
  assertEquals(results[0]?.status, 'queued')
  assertEquals(typeof results[0]?.commandId, 'string')
})

test('parseManagedDestroyGate rejects anything malformed', () => {
  assertEquals(parseManagedDestroyGate(null), null)
  assertEquals(parseManagedDestroyGate([]), null)
  assertEquals(parseManagedDestroyGate({}), null)
  assertEquals(
    parseManagedDestroyGate({ gateId: '', memberIds: ['r1'], followups: [] }),
    null,
  )
  assertEquals(
    parseManagedDestroyGate({ gateId: 'g', memberIds: [], followups: [] }),
    null,
  )
  assertEquals(
    parseManagedDestroyGate({ gateId: 'g', memberIds: [1], followups: [] }),
    null,
  )
  assertEquals(
    parseManagedDestroyGate({ gateId: 'g', memberIds: ['r1'] }),
    null,
  )
  // A follow-up without a payload object is not a destroy this can enqueue.
  assertEquals(
    parseManagedDestroyGate({
      gateId: 'g',
      memberIds: ['r1'],
      followups: [{ serverId: 's', memberId: 'p1', payload: null }],
    }),
    null,
  )
  assertEquals(
    parseManagedDestroyGate({
      gateId: 'g',
      memberIds: ['r1'],
      followups: [{ serverId: 's', memberId: 'p1', payload: { a: 1 } }],
    }),
    {
      gateId: 'g',
      memberIds: ['r1'],
      followups: [{ serverId: 's', memberId: 'p1', payload: { a: 1 } }],
    },
  )
})
