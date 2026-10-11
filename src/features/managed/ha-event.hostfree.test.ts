/**
 * Host-free coverage for daemon-observed HA events (Db doubles only).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { type HaBindingLoaders, handleManagedHaEvent, reporterPrivateHosts } from './ha-event.ts'
import {
  AUTOMATIC_FAILOVER_COOLDOWN_MESSAGE,
  AUTOMATIC_FAILOVER_NO_QUEUE_MESSAGE,
} from './recovery.ts'

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
type DbCalls = { inserts: number; reads: number }

function fakeDb(resultSets: unknown[][], inserted?: unknown[], calls?: DbCalls): Db {
  const queue = [...resultSets]
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          if (calls) calls.reads += 1
          const promise = Promise.resolve(queue.shift() ?? [])
          return promise.then.bind(promise)
        }
        if (prop === 'catch' || prop === 'finally') return undefined
        return () => chain
      },
    }
  )
  return {
    select: () => chain,
    insert: () => {
      if (calls) calls.inserts += 1
      return {
        values: () => ({
          returning: () => Promise.resolve(inserted ?? []),
        }),
      }
    },
  } as unknown as Db
}

const ORG = 'org-1'
const OTHER_ORG = 'org-2'
const SERVER_B = '550e8400-e29b-41d4-a716-446655440001'
const SERVER_C = '550e8400-e29b-41d4-a716-446655440002'
const pgRow = { id: MANAGED_ID, engine: 'postgres', organizationId: ORG }
const mysqlRow = { id: MANAGED_ID, engine: 'mysql', organizationId: ORG }
const inOrg = [{ organizationId: ORG }]
const PRIMARY_DIAL = { host: '10.0.0.5', port: 3306 }

/** Binding lookups without a database: the reporter's feature + current primary dial. */
function binding(overrides: Partial<HaBindingLoaders> & { advertises?: boolean } = {}) {
  return {
    reporterBindsInstance: async () => overrides.advertises ?? false,
    primaryDial: async () => PRIMARY_DIAL,
    reporterPrivateHosts: async () => [],
    ...overrides,
  } satisfies HaBindingLoaders
}
const queue = { enqueue: async () => {} } as unknown as CommandQueue

function replicaMember(overrides: Record<string, unknown> = {}) {
  return member({
    id: 'mem-replica',
    serverId: SERVER_B,
    role: 'replica',
    replicaClass: 'failover',
    ordinal: 2,
    metadata: {
      replication: {
        state: 'streaming',
        observedAt: new Date().toISOString(),
        lagBytes: 0,
        lagSeconds: 0,
      },
    },
    ...overrides,
  })
}

test('reporterPrivateHosts resolves the reporter address from each remote member', async () => {
  const primary = member({ serverId: SERVER_B, privatePort: 45000 })
  const routes: Array<{ fromServerId: string; purpose: string }> = []
  const hosts = await reporterPrivateHosts(
    {} as Db,
    SERVER_B,
    primary,
    [
      primary,
      replicaMember({ serverId: SERVER_A }),
      replicaMember({ id: 'mem-read', serverId: SERVER_C, replicaClass: 'read', ordinal: 3 }),
    ],
    async (_db, params) => {
      routes.push({ fromServerId: params.fromServerId, purpose: params.purpose })
      const endpoint =
        params.fromServerId === SERVER_A
          ? { address: '10.0.0.6', transport: 'datacenter' as const }
          : {
              kind: 'private_path_unavailable' as const,
              fromServerId: params.fromServerId,
              toServerId: SERVER_B,
            }
      return new Map([[SERVER_B, endpoint]])
    }
  )
  assertEquals(hosts, ['10.0.0.6'])
  assertEquals(routes, [
    { fromServerId: SERVER_A, purpose: 'failover-replication' },
    { fromServerId: SERVER_C, purpose: 'read-replication' },
  ])
})

test('handleManagedHaEvent returns null when the managed row is gone', async () => {
  const result = await handleManagedHaEvent(
    fakeDb([[]]),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A }
  )
  assertEquals(result, null)
})

test('handleManagedHaEvent returns null for an unknown engine', async () => {
  const result = await handleManagedHaEvent(
    fakeDb([[{ ...pgRow, engine: 'not-an-engine' }]]),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A }
  )
  assertEquals(result, null)
})

test('handleManagedHaEvent returns null when the cluster has no members', async () => {
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], []]),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A }
  )
  assertEquals(result, null)
})

test('handleManagedHaEvent resumes an in-flight recovery instead of opening another', async () => {
  const inflight = recoveryRow()
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], inOrg, [inflight]]),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-primary' },
    { reporterServerId: SERVER_A, binding: binding() }
  )
  assertEquals(result?.id, 'rec-1')
  assertEquals(result?.state, 'fencing')
  assertEquals(result?.kind, 'automatic-failover')
})

test('handleManagedHaEvent returns null when no primary or source member exists', async () => {
  const result = await handleManagedHaEvent(
    fakeDb([
      [mysqlRow],
      [member({ id: 'mem-other', role: 'replica', replicaClass: 'read' })],
      inOrg,
      [],
      [],
    ]),
    { managedId: MANAGED_ID, sourceMemberId: 'missing' },
    { reporterServerId: SERVER_A, binding: binding() }
  )
  assertEquals(result, null)
})

test('handleManagedHaEvent persists a blocked row when no failover candidate exists', async () => {
  const blocked = recoveryRow({ state: 'blocked', id: 'rec-blocked' })
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], inOrg, [], [], []], [blocked]),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A, binding: binding(), commandQueue: queue }
  )
  assertEquals(result?.id, 'rec-blocked')
  assertEquals(result?.state, 'blocked')
})

test('handleManagedHaEvent records a terminal blocked row when a candidate exists but the queue does not', async () => {
  const detecting = recoveryRow({
    id: 'rec-detect',
    state: 'blocked',
    metadata: { blockedReason: AUTOMATIC_FAILOVER_NO_QUEUE_MESSAGE },
  })
  const result = await handleManagedHaEvent(
    fakeDb(
      [
        [mysqlRow],
        [member(), replicaMember({ serverId: SERVER_A })],
        inOrg,
        [],
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
      [detecting]
    ),
    { managedId: MANAGED_ID, at: NOW },
    { reporterServerId: SERVER_A, binding: binding() }
  )
  assertEquals(result?.id, 'rec-detect')
  assertEquals(result?.state, 'blocked')
})

test('handleManagedHaEvent rejects a Postgres event with no detector (Orchestrator never sees Postgres)', async () => {
  const calls = { inserts: 0, reads: 0 }
  const result = await handleManagedHaEvent(
    fakeDb([[pgRow], [member()], inOrg], undefined, calls),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-primary' },
    { reporterServerId: SERVER_A, commandQueue: queue }
  )
  assertEquals(result, null)
  assertEquals(calls, { inserts: 0, reads: 3 })
})

test('handleManagedHaEvent rejects an explicit orchestrator event for Postgres', async () => {
  const calls = { inserts: 0, reads: 0 }
  const result = await handleManagedHaEvent(
    fakeDb([[pgRow], [member()], inOrg], undefined, calls),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-primary', detector: 'orchestrator' },
    { reporterServerId: SERVER_A, commandQueue: queue }
  )
  assertEquals(result, null)
  assertEquals(calls, { inserts: 0, reads: 3 })
})

test('handleManagedHaEvent rejects an event with no detector from a server hosting no member', async () => {
  const calls = { inserts: 0, reads: 0 }
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], inOrg], undefined, calls),
    { managedId: MANAGED_ID },
    { reporterServerId: '550e8400-e29b-41d4-a716-4466554400ff', commandQueue: queue }
  )
  assertEquals(result, null)
  assertEquals(calls, { inserts: 0, reads: 3 })
})

test('handleManagedHaEvent rejects an event from a member server in another organization', async () => {
  const calls = { inserts: 0, reads: 0 }
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], [{ organizationId: OTHER_ORG }]], undefined, calls),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A, commandQueue: queue }
  )
  assertEquals(result, null)
  assertEquals(calls, { inserts: 0, reads: 3 })
})

test("handleManagedHaEvent ignores a postgres-probe event from a server that is not the primary's", async () => {
  const calls = { inserts: 0, reads: 0 }
  const result = await handleManagedHaEvent(
    fakeDb([[pgRow], [member(), replicaMember()], inOrg], undefined, calls),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-primary', detector: 'postgres-probe' },
    { reporterServerId: SERVER_B, commandQueue: queue }
  )
  assertEquals(result, null)
  assertEquals(calls, { inserts: 0, reads: 3 })
})

test('handleManagedHaEvent ignores a postgres-probe event naming a stale primary', async () => {
  const calls = { inserts: 0, reads: 0 }
  const result = await handleManagedHaEvent(
    fakeDb(
      [[pgRow], [member(), replicaMember({ id: 'mem-old', serverId: SERVER_A })], inOrg],
      undefined,
      calls
    ),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-old', detector: 'postgres-probe' },
    { reporterServerId: SERVER_A, commandQueue: queue }
  )
  assertEquals(result, null)
  assertEquals(calls, { inserts: 0, reads: 3 })
})

test('handleManagedHaEvent ignores a postgres-probe event for a MySQL cluster', async () => {
  const calls = { inserts: 0, reads: 0 }
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], inOrg], undefined, calls),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-primary', detector: 'postgres-probe' },
    { reporterServerId: SERVER_A, commandQueue: queue }
  )
  assertEquals(result, null)
  assertEquals(calls, { inserts: 0, reads: 3 })
})

test('handleManagedHaEvent runs the unchanged failover path for a valid postgres-probe event', async () => {
  const blocked = recoveryRow({
    state: 'blocked',
    id: 'rec-probe',
    metadata: { detector: 'postgres-probe', detectorEvidence: '{"failures":6}' },
  })
  const result = await handleManagedHaEvent(
    fakeDb([[pgRow], [member()], inOrg, [], [], []], [blocked]),
    {
      managedId: MANAGED_ID,
      sourceMemberId: 'mem-primary',
      detector: 'postgres-probe',
      evidence: { failures: 6 },
    },
    { reporterServerId: SERVER_A, commandQueue: queue }
  )
  assertEquals(result?.id, 'rec-probe')
  assertEquals(result?.state, 'blocked')
  assertEquals(result?.metadata.detectorEvidence, '{"failures":6}')
})

test('handleManagedHaEvent honours the persisted cooldown (a fresh process sees the journal row)', async () => {
  // Nothing in memory: the only input is the journal row of the previous
  // accepted failover, exactly what a restarted worker reads.
  const previous = recoveryRow({
    id: 'rec-prev',
    state: 'completed',
    targetMemberId: 'mem-replica',
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  })
  const cooldownRow = recoveryRow({
    id: 'rec-cooldown',
    state: 'blocked',
    metadata: { blockedReason: AUTOMATIC_FAILOVER_COOLDOWN_MESSAGE },
  })
  const calls = { inserts: 0, reads: 0 }
  const result = await handleManagedHaEvent(
    fakeDb([[pgRow], [member(), replicaMember()], inOrg, [], [previous]], [cooldownRow], calls),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-primary', detector: 'postgres-probe' },
    { reporterServerId: SERVER_A, commandQueue: queue }
  )
  // Refused: one visible terminal row, no fence/promote. The two extra reads
  // look for an identical refusal to count instead of inserting again.
  assertEquals(result?.state, 'blocked')
  assertEquals(result?.metadata.blockedReason, AUTOMATIC_FAILOVER_COOLDOWN_MESSAGE)
  assertEquals(calls, { inserts: 1, reads: 7 })
})

const STALE_REPLICA_OLD_PRIMARY = [member(), replicaMember()]

test('orchestrator event naming the current primary proceeds to failover', async () => {
  const blocked = recoveryRow({ state: 'blocked', id: 'rec-bound' })
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], inOrg, [], [], []], [blocked]),
    { managedId: MANAGED_ID, instanceHost: '10.0.0.5', instancePort: 3306 },
    { reporterServerId: SERVER_A, commandQueue: queue, binding: binding({ advertises: true }) }
  )
  assertEquals(result?.id, 'rec-bound')
})

test("orchestrator event naming the local primary's published private listener proceeds", async () => {
  const blocked = recoveryRow({ state: 'blocked', id: 'rec-local-private' })
  const result = await handleManagedHaEvent(
    fakeDb(
      [[mysqlRow], [member({ serverId: SERVER_B, privatePort: 45000 })], inOrg, [], [], []],
      [blocked]
    ),
    { managedId: MANAGED_ID, instanceHost: '10.0.0.6', instancePort: 45000 },
    {
      reporterServerId: SERVER_B,
      commandQueue: queue,
      binding: binding({
        advertises: true,
        primaryDial: async () => ({ host: 'primary-b', port: 3306 }),
        reporterPrivateHosts: async () => ['10.0.0.6'],
      }),
    }
  )
  assertEquals(result?.id, 'rec-local-private')
  assertEquals(result?.metadata.stale, undefined)
})

test('stale remote primary with the same private port as the local primary is rejected', async () => {
  const calls = { inserts: 0, reads: 0 }
  const stale = recoveryRow({ state: 'blocked', id: 'rec-stale-port', metadata: { stale: true } })
  const result = await handleManagedHaEvent(
    fakeDb(
      [
        [mysqlRow],
        [
          member({ serverId: SERVER_B, privatePort: 45000 }),
          replicaMember({ id: 'mem-old-primary', serverId: SERVER_A, privatePort: 45000 }),
        ],
        inOrg,
      ],
      [stale],
      calls
    ),
    { managedId: MANAGED_ID, instanceHost: '10.0.0.5', instancePort: 45000 },
    {
      reporterServerId: SERVER_B,
      commandQueue: queue,
      binding: binding({
        advertises: true,
        primaryDial: async () => ({ host: 'primary-b', port: 3306 }),
        reporterPrivateHosts: async () => ['10.0.0.6'],
      }),
    }
  )
  assertEquals(result?.id, 'rec-stale-port')
  assertEquals(result?.metadata.stale, true)
  assertEquals(calls, { inserts: 1, reads: 5 })
})

test('orchestrator event matching host case-insensitively still proceeds', async () => {
  const blocked = recoveryRow({ state: 'blocked', id: 'rec-bound' })
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], inOrg, [], [], []], [blocked]),
    { managedId: MANAGED_ID, instanceHost: 'DB-1', instancePort: 3306 },
    {
      reporterServerId: SERVER_A,
      commandQueue: queue,
      binding: binding({ primaryDial: async () => ({ host: 'db-1', port: 3306 }) }),
    }
  )
  assertEquals(result?.id, 'rec-bound')
})

test('orchestrator event naming another instance is recorded stale and never fences', async () => {
  const calls = { inserts: 0, reads: 0 }
  const stale = recoveryRow({ state: 'blocked', id: 'rec-stale', metadata: { stale: true } })
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], STALE_REPLICA_OLD_PRIMARY, inOrg], [stale], calls),
    { managedId: MANAGED_ID, instanceHost: '10.0.0.9', instancePort: 3306 },
    { reporterServerId: SERVER_A, commandQueue: queue, binding: binding({ advertises: true }) }
  )
  assertEquals(result?.id, 'rec-stale')
  // One terminal row (after the blocked-row dedupe lookup); no candidate, datacenter, or command reads followed.
  assertEquals(calls, { inserts: 1, reads: 5 })
})

function coldPgDb(blocked: unknown) {
  const pins = [SERVER_A, SERVER_B].map((serverId, index) => ({
    ipId: `ip-${index}`,
    serverId,
    datacenterId: 'dc-east',
    networkId: 'net-1',
    address: `203.0.113.${10 + index}`,
  }))
  const cold = replicaMember({ metadata: { replication: { state: 'stopped', observedAt: NOW } } })
  return fakeDb([[pgRow], [member(), cold], inOrg, [], [], pins], [blocked])
}

test('handleManagedHaEvent probes a cold Postgres standby, anchored on the detector span', async () => {
  const blocked = recoveryRow({ state: 'blocked', id: 'rec-cold' })
  const calls: unknown[] = []
  const result = await handleManagedHaEvent(
    coldPgDb(blocked),
    {
      managedId: MANAGED_ID,
      sourceMemberId: 'mem-primary',
      detector: 'postgres-probe',
      evidence: { failures: 6, spanMs: 25_000 },
    },
    {
      reporterServerId: SERVER_A,
      commandQueue: queue,
      probeStandby: (target) => {
        calls.push(target)
        return Promise.resolve(null)
      },
      nowMs: () => 1_000_000,
    }
  )
  assertEquals(result?.id, 'rec-cold')
  assertEquals(calls, [
    { memberId: 'mem-replica', managedId: MANAGED_ID, serverId: SERVER_B, engine: 'postgres' },
  ])
})

test('handleManagedHaEvent never probes without a usable detector span', async () => {
  const blocked = recoveryRow({ state: 'blocked', id: 'rec-cold' })
  let probed = 0
  await handleManagedHaEvent(
    coldPgDb(blocked),
    {
      managedId: MANAGED_ID,
      sourceMemberId: 'mem-primary',
      detector: 'postgres-probe',
      evidence: { failures: 6 },
    },
    {
      reporterServerId: SERVER_A,
      commandQueue: queue,
      probeStandby: () => {
        probed += 1
        return Promise.resolve(null)
      },
    }
  )
  assertEquals(probed, 0)
})

test('orchestrator event with a matching host but another port is stale', async () => {
  const calls = { inserts: 0, reads: 0 }
  await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], inOrg], [recoveryRow({ state: 'blocked' })], calls),
    { managedId: MANAGED_ID, instanceHost: '10.0.0.5', instancePort: 3307 },
    { reporterServerId: SERVER_A, commandQueue: queue, binding: binding() }
  )
  assertEquals(calls, { inserts: 1, reads: 5 })
})

test('orchestrator event without an instance from a daemon that advertises the feature is stale', async () => {
  const calls = { inserts: 0, reads: 0 }
  await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], inOrg], [recoveryRow({ state: 'blocked' })], calls),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A, commandQueue: queue, binding: binding({ advertises: true }) }
  )
  assertEquals(calls, { inserts: 1, reads: 5 })
})

test('orchestrator event without an instance from an old daemon keeps the legacy behavior', async () => {
  const blocked = recoveryRow({ state: 'blocked', id: 'rec-legacy' })
  const result = await handleManagedHaEvent(
    fakeDb([[mysqlRow], [member()], inOrg, [], [], []], [blocked]),
    { managedId: MANAGED_ID },
    { reporterServerId: SERVER_A, commandQueue: queue, binding: binding({ advertises: false }) }
  )
  assertEquals(result?.id, 'rec-legacy')
})

test('a postgres-probe event is not subject to the Orchestrator binding', async () => {
  const blocked = recoveryRow({ state: 'blocked', id: 'rec-probe' })
  const result = await handleManagedHaEvent(
    fakeDb([[pgRow], [member()], inOrg, [], [], []], [blocked]),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-primary', detector: 'postgres-probe' },
    {
      reporterServerId: SERVER_A,
      commandQueue: queue,
      binding: binding({ advertises: true, primaryDial: async () => null }),
    }
  )
  assertEquals(result?.id, 'rec-probe')
})

test('a boot-hold report is answered, never treated as a dead primary: no failover row, no probe', async () => {
  const calls: DbCalls = { inserts: 0, reads: 0 }
  const answers: Array<Record<string, unknown>> = []
  const result = await handleManagedHaEvent(
    fakeDb([[pgRow], [member(), replicaMember()]], undefined, calls),
    { managedId: MANAGED_ID, sourceMemberId: 'mem-primary', detector: 'boot-hold' },
    {
      reporterServerId: SERVER_A,
      commandQueue: queue,
      autoFailover: 'on',
      probeStandby: () => {
        throw new TypeError('a boot-hold report must never probe a standby')
      },
      bootHold: (_db, input) => {
        answers.push(input as unknown as Record<string, unknown>)
        return Promise.resolve('released')
      },
    }
  )
  assertEquals(result, null)
  assertEquals(calls.inserts, 0)
  assertEquals(answers.length, 1)
  // The authenticated session's server id is what the answer is keyed on.
  assertEquals(answers[0]?.reporterServerId, SERVER_A)
  assertEquals(answers[0]?.sourceMemberId, 'mem-primary')
  assertEquals(answers[0]?.engine, 'postgres')
})

test('a boot-hold report for a cluster the control plane does not know is dropped', async () => {
  const answers: unknown[] = []
  const result = await handleManagedHaEvent(
    fakeDb([[]]),
    { managedId: MANAGED_ID, detector: 'boot-hold' },
    {
      reporterServerId: SERVER_A,
      bootHold: () => {
        answers.push(1)
        return Promise.resolve('released')
      },
    }
  )
  assertEquals(result, null)
  assertEquals(answers.length, 0)
})
