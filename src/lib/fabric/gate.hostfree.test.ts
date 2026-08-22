import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { CommandStatus } from '../commands/types.ts'
import { composeNetworkNamesByServer, type EnvironmentComposeNetwork } from '../db/fabric-records.ts'
import {
  awaitFabricReconcile,
  classifyFabricGate,
  type FabricGateRecord,
} from './gate.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject)
    },
  }
}

function gateRecord(
  id: string,
  serverId: string,
  status: CommandStatus,
  error: string | null = null,
): FabricGateRecord {
  return { id, serverId, status, error }
}

function commandRow(
  id: string,
  serverId: string,
  status: string,
  error?: string,
) {
  return {
    id,
    serverId,
    actorType: 'user',
    actorId: 'user-1',
    name: 'server.fabric.reconcile',
    status,
    attempts: 0,
    context: null,
    errorMessage: error ?? null,
    errorCode: null,
    resultSummary: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  }
}

function createCommandStatusDb(rowsByCall: unknown[][]): Db {
  let call = 0
  return {
    select() {
      return {
        from() {
          return {
            where() {
              const rows = rowsByCall[call] ?? rowsByCall[rowsByCall.length - 1] ?? []
              call += 1
              return thenable(rows)
            },
          }
        },
      }
    },
  } as unknown as Db
}

test('classifyFabricGate treats succeeded as ready', () => {
  assertEquals(
    classifyFabricGate([
      gateRecord('c1', 's1', 'succeeded'),
      gateRecord('c2', 's2', 'succeeded'),
    ]),
    { kind: 'ready' },
  )
})

test('classifyFabricGate treats other terminal statuses as failed', () => {
  assertEquals(
    classifyFabricGate([
      gateRecord('c1', 's1', 'succeeded'),
      gateRecord('c2', 's2', 'failed', 'apply failed'),
    ]),
    { kind: 'failed', serverId: 's2', commandId: 'c2', error: 'apply failed' },
  )
  assertEquals(
    classifyFabricGate([gateRecord('c1', 's1', 'timed_out')]).kind,
    'failed',
  )
  assertEquals(
    classifyFabricGate([gateRecord('c1', 's1', 'cancelled')]).kind,
    'failed',
  )
})

test('classifyFabricGate reports pending non-terminal rows', () => {
  assertEquals(
    classifyFabricGate([
      gateRecord('c1', 's1', 'succeeded'),
      gateRecord('c2', 's2', 'queued'),
    ]),
    { kind: 'pending', pending: [{ serverId: 's2', commandId: 'c2' }] },
  )
})

test('classifyFabricGate prefers failed over pending', () => {
  assertEquals(
    classifyFabricGate([
      gateRecord('c1', 's1', 'queued'),
      gateRecord('c2', 's2', 'failed', 'boom'),
    ]),
    { kind: 'failed', serverId: 's2', commandId: 'c2', error: 'boom' },
  )
})

test('awaitFabricReconcile returns ready immediately for an empty command list', async () => {
  const outcome = await awaitFabricReconcile({} as Db, { commands: [] })
  assertEquals(outcome, { kind: 'ready' })
})

test('awaitFabricReconcile returns immediately when the first poll succeeds', async () => {
  const db = createCommandStatusDb([
    [commandRow('c1', 's1', 'succeeded')],
  ])
  const outcome = await awaitFabricReconcile(db, {
    commands: [{ serverId: 's1', commandId: 'c1' }],
    timeoutMs: 20_000,
    pollIntervalMs: 500,
    sleep: () => Promise.reject(new TypeError('should not sleep')),
    now: () => 0,
  })
  assertEquals(outcome, { kind: 'ready' })
})

test('awaitFabricReconcile times out while commands stay pending', async () => {
  let nowMs = 0
  const db = createCommandStatusDb([
    [commandRow('c1', 's1', 'queued')],
  ])
  const outcome = await awaitFabricReconcile(db, {
    commands: [{ serverId: 's1', commandId: 'c1' }],
    timeoutMs: 1_000,
    pollIntervalMs: 500,
    sleep: (ms) => {
      nowMs += ms
      return Promise.resolve()
    },
    now: () => nowMs,
  })
  assertEquals(outcome.kind, 'pending')
  if (outcome.kind === 'pending') {
    assertEquals(outcome.pending, [{ serverId: 's1', commandId: 'c1' }])
  }
})

test('awaitFabricReconcile returns failed when a later poll is terminal', async () => {
  let nowMs = 0
  const db = createCommandStatusDb([
    [commandRow('c1', 's1', 'queued')],
    [commandRow('c1', 's1', 'failed', 'apply failed')],
  ])
  const outcome = await awaitFabricReconcile(db, {
    commands: [{ serverId: 's1', commandId: 'c1' }],
    timeoutMs: 20_000,
    pollIntervalMs: 500,
    sleep: (ms) => {
      nowMs += ms
      return Promise.resolve()
    },
    now: () => nowMs,
  })
  assertEquals(outcome, {
    kind: 'failed',
    serverId: 's1',
    commandId: 'c1',
    error: 'apply failed',
  })
})

test('composeNetworkNamesByServer maps unique sorted names per server', () => {
  const rows: EnvironmentComposeNetwork[] = [
    {
      networkId: 'n2',
      hostName: 'tpn_n2',
      segments: [
        { serverId: 's2', subnet: '10.192.2.0/24' },
        { serverId: 's1', subnet: '10.192.1.0/24' },
      ],
    },
    {
      networkId: 'n1',
      hostName: 'tpn_n1',
      segments: [
        { serverId: 's1', subnet: '10.192.0.0/24' },
        { serverId: 's1', subnet: '10.192.0.0/24' },
      ],
    },
  ]
  const map = composeNetworkNamesByServer(rows)
  assertEquals(map.get('s1'), ['tpn_n1', 'tpn_n2'])
  assertEquals(map.get('s2'), ['tpn_n2'])
})
