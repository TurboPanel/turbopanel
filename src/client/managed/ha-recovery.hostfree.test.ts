/**
 * Host-free coverage for durable HA recovery enqueue + journal advance.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE,
  AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE,
  type RecoveryRecord,
} from '../../lib/managed/recovery.ts'
import {
  container,
  environment,
  ip,
  managed,
  replica,
  recovery,
  server,
} from '../../lib/db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveEncryptionSecretsConfig } from '../authn/secrets.ts'
import type { ManagedMemberRow } from './members.ts'
import {
  beginAutomaticFailover,
  beginDisasterRecovery,
  beginOperatorSwitchover,
  fencePhaseFromCommandMetadata,
  firstDatacenterId,
  isServerConnected,
  loadDatacenterSets,
  logRecoveryAdvanceFailure,
  onFenceCommandFailed,
  onFenceCommandSucceeded,
  onPromoteSucceeded,
  onRecoveryCommandFailed,
  recoveryIdFromCommandMetadata,
} from './ha-recovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MANAGED_ID = '00000000-0000-4000-8000-000000000001'
const REC_ID = '00000000-0000-4000-8000-000000000010'
const MEM_PRIMARY = '00000000-0000-4000-8000-000000000020'
const MEM_REPLICA = '00000000-0000-4000-8000-000000000021'
const MEM_READ = '00000000-0000-4000-8000-000000000022'
const SERVER_A = '550e8400-e29b-41d4-a716-446655440000'
const SERVER_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const ACTOR_ID = '00000000-0000-4000-8000-000000000099'
const DC_A = 'dc-east'
const DC_B = 'dc-west'
const NOW = '2026-01-01T00:00:00.000Z'
const ACTOR = { actorType: 'system' as const, actorId: ACTOR_ID }

type RecoveryRow = {
  id: string
  createdAt: string
  updatedAt: string
  metadata: unknown
  options: unknown
  managedId: string
  kind: string
  sourcePrimaryMemberId: string
  targetMemberId: string | null
  state: string
  startedAt: string
  completedAt: string | null
}

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const chain: Record<string, unknown> = {}
  const self = () => chain
  chain.where = self
  chain.orderBy = self
  chain.limit = self
  chain.innerJoin = self
  chain.leftJoin = self
  chain.returning = () => promise
  chain.then = promise.then.bind(promise)
  chain.catch = promise.catch.bind(promise)
  chain.finally = promise.finally.bind(promise)
  return chain
}

function healthyReplication() {
  return {
    state: 'streaming',
    observedAt: new Date().toISOString(),
    lagBytes: 0,
    lagSeconds: 0,
  }
}

function member(overrides: Partial<ManagedMemberRow> = {}): ManagedMemberRow {
  return {
    id: MEM_PRIMARY,
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

function failoverReplica(
  overrides: Partial<ManagedMemberRow> = {},
): ManagedMemberRow {
  return member({
    id: MEM_REPLICA,
    role: 'replica',
    replicaClass: 'failover',
    ordinal: 2,
    metadata: { replication: healthyReplication() },
    ...overrides,
  })
}

function recoveryRow(overrides: Partial<RecoveryRow> = {}): RecoveryRow {
  return {
    id: REC_ID,
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
    options: null,
    managedId: MANAGED_ID,
    kind: 'automatic-failover',
    sourcePrimaryMemberId: MEM_PRIMARY,
    targetMemberId: MEM_REPLICA,
    state: 'fencing',
    startedAt: NOW,
    completedAt: null,
    ...overrides,
  }
}

function okQueue(): CommandQueue & { envelopes: unknown[] } {
  const envelopes: unknown[] = []
  return {
    envelopes,
    enqueue: (envelope) => {
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

function failingQueue(): CommandQueue {
  return {
    enqueue: () => Promise.reject(new TypeError('queue unavailable')),
  }
}

/** Drain enqueue fails; later stop/promote enqueues still land. */
function failFirstThenOkQueue(): CommandQueue & { envelopes: unknown[] } {
  const envelopes: unknown[] = []
  let calls = 0
  return {
    envelopes,
    enqueue: (envelope) => {
      calls += 1
      if (calls === 1) {
        return Promise.reject(new TypeError('drain queue unavailable'))
      }
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

function sharedDatacenterPins() {
  return [
    {
      ipId: 'ip-a',
      serverId: SERVER_A,
      datacenterId: DC_A,
      networkId: 'net-1',
      address: '203.0.113.10',
    },
    {
      ipId: 'ip-b',
      serverId: SERVER_B,
      datacenterId: DC_A,
      networkId: 'net-1',
      address: '203.0.113.20',
    },
  ]
}

function commandRow(values: Record<string, unknown>, id: string) {
  return {
    id,
    createdAt: NOW,
    updatedAt: NOW,
    serverId: values.serverId ?? SERVER_A,
    actorType: values.actorType ?? 'system',
    actorId: values.actorId ?? ACTOR_ID,
    name: values.name ?? 'managed.promote',
    status: values.status ?? 'queued',
    attempts: values.attempts ?? 0,
    context: values.context ?? null,
    resultSummary: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: values.queuedAt ?? NOW,
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: values.expiresAt ?? null,
  }
}

type HarnessOpts = {
  members?: ManagedMemberRow[]
  pins?: Array<Record<string, unknown>>
  recovery?: RecoveryRow | null
  connected?: boolean[]
  haPresent?: boolean
  containerNames?: Array<string | undefined>
}

type RecoveryHarness = {
  db: Db
  managedStatus: string[]
  nodePatches: Array<Record<string, unknown>>
  commandInserts: Array<Record<string, unknown>>
  recovery: () => RecoveryRow | null
}

function createHarness(opts: HarnessOpts = {}): RecoveryHarness {
  const members = opts.members ?? []
  const pins = opts.pins ?? []
  const connected = [...(opts.connected ?? [])]
  const containerNames = [...(opts.containerNames ?? [])]
  let stored = opts.recovery === undefined ? null : opts.recovery
  const managedStatus: string[] = []
  const nodePatches: Array<Record<string, unknown>> = []
  const commandInserts: Array<Record<string, unknown>> = []
  let commandSeq = 0
  let lastCommand: ReturnType<typeof commandRow> | null = null

  const haHierarchy = opts.haPresent
    ? [{
      workspaceId: 'ws',
      projectId: 'proj',
      environmentId: 'env',
      serviceId: 'svc-ha',
      containerRowId: 'row',
      containerName: 'svc-ha-ha',
    }]
    : []

  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === recovery) {
          return thenableRows(stored ? [stored] : [])
        }
        if (table === server) {
          const next = connected.shift()
          return thenableRows([{ connected: next !== false }])
        }
        if (table === ip) return thenableRows(pins)
        if (table === environment) return thenableRows(haHierarchy)
        if (table === container) {
          const name = containerNames.shift()
          if (name === undefined && containerNames.length === 0 && opts.containerNames === undefined) {
            return thenableRows([{ containerName: 'pg-local' }])
          }
          return thenableRows(name ? [{ containerName: name }] : [])
        }
        if (table === replica) return thenableRows(members)
        return thenableRows([])
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (
          table === recovery ||
          (typeof values.kind === 'string' &&
            typeof values.sourcePrimaryMemberId === 'string')
        ) {
          stored = recoveryRow({
            ...values,
            id: REC_ID,
            metadata: values.metadata ?? {},
          })
          return thenableRows([stored])
        }
        commandSeq += 1
        lastCommand = commandRow(values, `cmd-${commandSeq}`)
        commandInserts.push(values)
        return thenableRows([lastCommand])
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        if (table === recovery && stored) {
          stored = { ...stored, ...patch }
        }
        if (table === managed && typeof patch.status === 'string') {
          managedStatus.push(patch.status)
        }
        if (table === replica) nodePatches.push(patch)
        const rows = table === recovery && stored
          ? [stored]
          : table === server
          ? []
          : lastCommand
          ? [{ ...lastCommand, ...patch }]
          : []
        return {
          where: () => thenableRows(rows),
        }
      },
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
    transaction: (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  }

  return {
    db: db as unknown as Db,
    managedStatus,
    nodePatches,
    commandInserts,
    recovery: () => stored,
  }
}

function expectOk(
  result: { ok: true; commandId: string; recoveryId: string } | { ok: false },
): asserts result is { ok: true; commandId: string; recoveryId: string } {
  if (!result.ok) {
    throw new TypeError('expected recovery enqueue to succeed')
  }
}

function expectRecord(row: RecoveryRecord | null): RecoveryRecord {
  if (!row) throw new TypeError('expected a recovery record')
  return row
}

test('firstDatacenterId returns the lex-smallest pin or null', () => {
  const sets = new Map<string, Set<string>>([
    [SERVER_A, new Set([DC_B, DC_A])],
  ])
  assertEquals(firstDatacenterId(sets, SERVER_A), DC_A)
  assertEquals(firstDatacenterId(sets, 'missing'), null)
  assertEquals(firstDatacenterId(new Map([[SERVER_A, new Set()]]), SERVER_A), null)
})

test('recoveryIdFromCommandMetadata requires a non-empty string', () => {
  assertEquals(recoveryIdFromCommandMetadata(undefined), null)
  assertEquals(recoveryIdFromCommandMetadata(null), null)
  assertEquals(recoveryIdFromCommandMetadata({}), null)
  assertEquals(recoveryIdFromCommandMetadata({ recoveryId: '' }), null)
  assertEquals(recoveryIdFromCommandMetadata({ recoveryId: 12 }), null)
  assertEquals(recoveryIdFromCommandMetadata({ recoveryId: 'rec-1' }), 'rec-1')
})

test('fencePhaseFromCommandMetadata accepts only drain or stop', () => {
  assertEquals(fencePhaseFromCommandMetadata(undefined), null)
  assertEquals(fencePhaseFromCommandMetadata({ fencePhase: 'promote' }), null)
  assertEquals(fencePhaseFromCommandMetadata({ fencePhase: 'drain' }), 'drain')
  assertEquals(fencePhaseFromCommandMetadata({ fencePhase: 'stop' }), 'stop')
})

test('logRecoveryAdvanceFailure is a warn-only helper', () => {
  logRecoveryAdvanceFailure('cmd-1', 'queue unavailable')
})

test('isServerConnected is true only for a connected row', async () => {
  const online = createHarness({ connected: [true] })
  assertEquals(await isServerConnected(online.db, SERVER_A), true)

  const offline = createHarness({ connected: [false] })
  assertEquals(await isServerConnected(offline.db, SERVER_A), false)
})

test('loadDatacenterSets groups valid pins and skips empty membership', async () => {
  const empty = createHarness()
  const none = await loadDatacenterSets(empty.db, [])
  assertEquals(none.size, 0)

  const harness = createHarness({
    pins: [
      {
        ipId: 'ip-1',
        serverId: SERVER_A,
        datacenterId: DC_B,
        networkId: 'net-1',
        address: '203.0.113.10',
      },
      {
        ipId: 'ip-2',
        serverId: SERVER_A,
        datacenterId: DC_A,
        networkId: 'net-2',
        address: '203.0.113.11',
      },
      {
        ipId: 'ip-bad',
        serverId: null,
        datacenterId: DC_A,
        networkId: 'net-3',
        address: 'not-an-ip',
      },
    ],
  })
  const sets = await loadDatacenterSets(harness.db, [
    member(),
    failoverReplica({ serverId: SERVER_A }),
  ])
  const ids = [...(sets.get(SERVER_A) ?? [])].sort((a, b) => a.localeCompare(b))
  assertEquals(ids, [DC_A, DC_B])
  assertEquals(firstDatacenterId(sets, SERVER_A), DC_A)
})

test('beginAutomaticFailover returns the in-flight journal row', async () => {
  const inflight = recoveryRow({ state: 'fencing' })
  const harness = createHarness({ recovery: inflight })
  const row = expectRecord(
    await beginAutomaticFailover({
      db: harness.db,
      commandQueue: okQueue(),
      managedId: MANAGED_ID,
      engine: 'postgres',
      members: [member(), failoverReplica()],
      actor: ACTOR,
    }),
  )
  assertEquals(row.id, REC_ID)
  assertEquals(row.state, 'fencing')
})

test('beginAutomaticFailover returns null without a primary or source member', async () => {
  const harness = createHarness()
  const row = await beginAutomaticFailover({
    db: harness.db,
    commandQueue: okQueue(),
    managedId: MANAGED_ID,
    engine: 'postgres',
    members: [failoverReplica()],
    actor: ACTOR,
  })
  assertEquals(row, null)
})

test('beginAutomaticFailover falls back to sourceMemberId when no primary role exists', async () => {
  const harness = createHarness({
    pins: [{
      ipId: 'ip-1',
      serverId: SERVER_A,
      datacenterId: DC_A,
      networkId: 'net-1',
      address: '203.0.113.10',
    }],
  })
  const source = member({ role: 'replica', replicaClass: 'read' })
  const row = expectRecord(
    await beginAutomaticFailover({
      db: harness.db,
      commandQueue: null,
      managedId: MANAGED_ID,
      engine: 'postgres',
      members: [source],
      sourceMemberId: MEM_PRIMARY,
      actor: ACTOR,
    }),
  )
  assertEquals(row.state, 'blocked')
  assertEquals(row.metadata.blockedReason, AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE)
})

test('beginAutomaticFailover persists blocked when no same-DC failover replica exists', async () => {
  const harness = createHarness({
    pins: [{
      ipId: 'ip-1',
      serverId: SERVER_A,
      datacenterId: DC_A,
      networkId: 'net-1',
      address: '203.0.113.10',
    }],
  })
  const row = expectRecord(
    await beginAutomaticFailover({
      db: harness.db,
      commandQueue: okQueue(),
      managedId: MANAGED_ID,
      engine: 'postgres',
      members: [member(), failoverReplica({ replicaClass: 'read' })],
      actor: ACTOR,
    }),
  )
  assertEquals(row.state, 'blocked')
  assertEquals(row.kind, 'automatic-failover')
  assertEquals(row.metadata.blockedReason, AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE)
})

test('beginAutomaticFailover persists blocked when the failover replica is unhealthy', async () => {
  const harness = createHarness({
    pins: [
      {
        ipId: 'ip-a',
        serverId: SERVER_A,
        datacenterId: DC_A,
        networkId: 'net-1',
        address: '203.0.113.10',
      },
      {
        ipId: 'ip-b',
        serverId: SERVER_A,
        datacenterId: DC_A,
        networkId: 'net-1',
        address: '203.0.113.11',
      },
    ],
  })
  const row = expectRecord(
    await beginAutomaticFailover({
      db: harness.db,
      commandQueue: okQueue(),
      managedId: MANAGED_ID,
      engine: 'postgres',
      members: [
        member(),
        failoverReplica({ metadata: { replication: { state: 'disconnected' } } }),
      ],
      actor: ACTOR,
    }),
  )
  assertEquals(row.state, 'blocked')
  assertEquals(row.metadata.blockedReason, AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE)
})

test('beginAutomaticFailover parks detecting when a candidate exists but the queue does not', async () => {
  const harness = createHarness({
    pins: [{
      ipId: 'ip-1',
      serverId: SERVER_A,
      datacenterId: DC_A,
      networkId: 'net-1',
      address: '203.0.113.10',
    }],
  })
  const row = expectRecord(
    await beginAutomaticFailover({
      db: harness.db,
      commandQueue: null,
      managedId: MANAGED_ID,
      engine: 'postgres',
      members: [member(), failoverReplica()],
      actor: ACTOR,
    }),
  )
  assertEquals(row.state, 'detecting')
  assertEquals(row.targetMemberId, MEM_REPLICA)
  assertEquals(row.metadata.sourceDatacenterId, DC_A)
  assertEquals(row.metadata.targetDatacenterId, DC_A)
})

test('beginAutomaticFailover blocks when the old primary is offline and unfenced', async () => {
  const harness = createHarness({
    pins: [{
      ipId: 'ip-1',
      serverId: SERVER_A,
      datacenterId: DC_A,
      networkId: 'net-1',
      address: '203.0.113.10',
    }],
    connected: [false],
  })
  const row = expectRecord(
    await beginAutomaticFailover({
      db: harness.db,
      commandQueue: okQueue(),
      managedId: MANAGED_ID,
      engine: 'postgres',
      members: [member(), failoverReplica()],
      actor: ACTOR,
    }),
  )
  assertEquals(row.state, 'blocked')
  assertEquals(harness.managedStatus.includes('ready'), true)
  assertEquals(
    harness.nodePatches.some((patch) => patch.status === 'needs_resync'),
    true,
  )
})

test('beginAutomaticFailover fences a reachable primary and records drain/stop commands', async () => {
  const queue = okQueue()
  const harness = createHarness({
    pins: [{
      ipId: 'ip-1',
      serverId: SERVER_A,
      datacenterId: DC_A,
      networkId: 'net-1',
      address: '203.0.113.10',
    }],
    connected: [true, true],
  })
  const row = expectRecord(
    await beginAutomaticFailover({
      db: harness.db,
      commandQueue: queue,
      managedId: MANAGED_ID,
      engine: 'postgres',
      members: [member(), failoverReplica()],
      actor: ACTOR,
    }),
  )
  assertEquals(row.state, 'fencing')
  assertEquals(row.kind, 'automatic-failover')
  assertEquals(queue.envelopes.length >= 2, true)
  assertEquals(harness.managedStatus.includes('applying'), true)
  const stored = harness.recovery()
  if (!stored) throw new TypeError('expected stored fencing row')
  const metadata = stored.metadata as { fenceCommandIds?: string[] }
  assertEquals((metadata.fenceCommandIds ?? []).length >= 2, true)
})

test('beginOperatorSwitchover is managed_busy while a journal row is in flight', async () => {
  const harness = createHarness({
    recovery: recoveryRow({ kind: 'switchover', state: 'promoting' }),
  })
  const result = await beginOperatorSwitchover({
    db: harness.db,
    commandQueue: okQueue(),
    managedId: MANAGED_ID,
    engine: 'postgres',
    source: member(),
    target: failoverReplica(),
    members: [member(), failoverReplica()],
    actor: ACTOR,
  })
  assertEquals(result, { ok: false, error: 'managed_busy', status: 409 })
})

test('beginOperatorSwitchover promotes when the old primary is already offline', async () => {
  const queue = okQueue()
  const harness = createHarness({ connected: [false] })
  const result = await beginOperatorSwitchover({
    db: harness.db,
    commandQueue: queue,
    managedId: MANAGED_ID,
    engine: 'postgres',
    source: member(),
    target: failoverReplica(),
    members: [member(), failoverReplica()],
    actor: ACTOR,
  })
  expectOk(result)
  assertEquals(result.fencePending, false)
  assertEquals(result.recoveryId, REC_ID)
  assertEquals(queue.envelopes.length, 1)
  assertEquals(
    (queue.envelopes[0] as { type: string }).type,
    'managed.promote',
  )
  assertEquals(harness.managedStatus.includes('applying'), true)
})

test('beginOperatorSwitchover recovers via Orchestrator when HA is present', async () => {
  const queue = okQueue()
  const harness = createHarness({ connected: [false], haPresent: true })
  const result = await beginOperatorSwitchover({
    db: harness.db,
    commandQueue: queue,
    managedId: MANAGED_ID,
    engine: 'mysql',
    source: member(),
    target: failoverReplica({ privatePort: 15432 }),
    members: [member(), failoverReplica({ privatePort: 15432 })],
    actor: ACTOR,
  })
  expectOk(result)
  assertEquals((queue.envelopes[0] as { type: string }).type, 'managed.ha.failover')
  const stored = harness.recovery()
  if (!stored) throw new TypeError('expected stored recovery')
  const metadata = stored.metadata as { failoverCommandId?: string; haPresent?: boolean }
  assertEquals(metadata.haPresent, true)
  assertEquals(typeof metadata.failoverCommandId, 'string')
})

test('beginOperatorSwitchover resolves a remote memberDialHost onto the recover payload', async () => {
  const queue = okQueue()
  const harness = createHarness({
    connected: [false],
    haPresent: true,
    pins: sharedDatacenterPins(),
    containerNames: ['pg-target'],
  })
  const target = failoverReplica({ serverId: SERVER_B, privatePort: 15432 })
  const result = await beginOperatorSwitchover({
    db: harness.db,
    commandQueue: queue,
    managedId: MANAGED_ID,
    engine: 'postgres',
    source: member(),
    target,
    members: [member(), target],
    actor: ACTOR,
  })
  expectOk(result)
  const recover = harness.commandInserts.find((row) => {
    if (typeof row.payload !== 'object' || row.payload === null) return false
    return (row.payload as { phase?: string }).phase === 'recover'
  })
  if (!recover || typeof recover.payload !== 'object' || recover.payload === null) {
    throw new TypeError('expected a recover failover command payload')
  }
  const payload = recover.payload as {
    sourceHost?: string
    targetHost?: string
    sourcePort?: number
    targetPort?: number
    phase?: string
  }
  assertEquals(payload.phase, 'recover')
  assertEquals(payload.sourceHost, '203.0.113.10')
  assertEquals(payload.sourcePort, 5432)
  assertEquals(payload.targetHost, 'pg-target')
  assertEquals(payload.targetPort, 15432)
})

test('beginOperatorSwitchover returns 503 when the promote queue is down', async () => {
  const harness = createHarness({ connected: [false] })
  const result = await beginOperatorSwitchover({
    db: harness.db,
    commandQueue: failingQueue(),
    managedId: MANAGED_ID,
    engine: 'postgres',
    source: member(),
    target: failoverReplica(),
    members: [member(), failoverReplica()],
    actor: ACTOR,
  })
  assertEquals(result, { ok: false, error: 'Command queue unavailable', status: 503 })
})

test('beginOperatorSwitchover fences a reachable primary', async () => {
  const queue = okQueue()
  const harness = createHarness({ connected: [true, true] })
  const result = await beginOperatorSwitchover({
    db: harness.db,
    commandQueue: queue,
    managedId: MANAGED_ID,
    engine: 'mariadb',
    source: member(),
    target: failoverReplica(),
    members: [member(), failoverReplica()],
    actor: ACTOR,
  })
  expectOk(result)
  assertEquals(result.fencePending, true)
  assertEquals(queue.envelopes.length >= 2, true)
  assertEquals(
    (queue.envelopes[queue.envelopes.length - 1] as { type: string }).type,
    'managed.lifecycle',
  )
})

test('beginOperatorSwitchover skips drain on disconnected peers and still stops the writer', async () => {
  const queue = okQueue()
  const harness = createHarness({
    connected: [true, true, false],
    containerNames: ['src-ctr'],
  })
  const result = await beginOperatorSwitchover({
    db: harness.db,
    commandQueue: queue,
    managedId: MANAGED_ID,
    engine: 'postgres',
    source: member(),
    target: failoverReplica({ serverId: SERVER_B, privatePort: null }),
    members: [
      member(),
      failoverReplica({ serverId: SERVER_B, privatePort: null }),
    ],
    actor: ACTOR,
  })
  expectOk(result)
  assertEquals(result.fencePending, true)
  const types = queue.envelopes.map((envelope) => (envelope as { type: string }).type)
  assertEquals(types.includes('managed.lifecycle'), true)
})

test('beginOperatorSwitchover returns 503 when the fence stop command cannot enqueue', async () => {
  const harness = createHarness({ connected: [true, true] })
  const result = await beginOperatorSwitchover({
    db: harness.db,
    commandQueue: failingQueue(),
    managedId: MANAGED_ID,
    engine: 'postgres',
    source: member(),
    target: failoverReplica(),
    members: [member(), failoverReplica()],
    actor: ACTOR,
  })
  assertEquals(result, { ok: false, error: 'Command queue unavailable', status: 503 })
})

test('beginOperatorSwitchover continues fencing when a drain enqueue fails', async () => {
  const queue = failFirstThenOkQueue()
  const harness = createHarness({ connected: [true, true] })
  const result = await beginOperatorSwitchover({
    db: harness.db,
    commandQueue: queue,
    managedId: MANAGED_ID,
    engine: 'postgres',
    source: member(),
    target: failoverReplica(),
    members: [member(), failoverReplica()],
    actor: ACTOR,
  })
  expectOk(result)
  assertEquals(result.fencePending, true)
  assertEquals(queue.envelopes.length, 1)
  assertEquals((queue.envelopes[0] as { type: string }).type, 'managed.lifecycle')
  const stored = harness.recovery()
  if (!stored) throw new TypeError('expected stored fencing row')
  const metadata = stored.metadata as { fenceCommandIds?: string[] }
  assertEquals((metadata.fenceCommandIds ?? []).length, 1)
  assertEquals(
    harness.commandInserts.some((row) => row.name === 'managed.ha.failover'),
    true,
  )
  assertEquals(
    harness.commandInserts.some((row) => row.name === 'managed.lifecycle'),
    true,
  )
})

test('beginDisasterRecovery continues promote when the old site is gone', async () => {
  const queue = okQueue()
  const harness = createHarness({ connected: [false] })
  const result = await beginDisasterRecovery({
    db: harness.db,
    commandQueue: queue,
    managedId: MANAGED_ID,
    engine: 'postgres',
    source: member(),
    target: failoverReplica({ replicaClass: 'read', serverId: SERVER_B }),
    members: [
      member(),
      failoverReplica({ replicaClass: 'read', serverId: SERVER_B }),
    ],
    actor: ACTOR,
    extraMetadata: { sourceDatacenterId: DC_A, targetDatacenterId: DC_B },
  })
  expectOk(result)
  assertEquals(result.fencePending, false)
  const stored = harness.recovery()
  if (!stored) throw new TypeError('expected stored disaster-recovery row')
  assertEquals(stored.kind, 'disaster-recovery')
  const metadata = stored.metadata as {
    sourceDatacenterId?: string
    promoteCommandId?: string
  }
  assertEquals(metadata.sourceDatacenterId, DC_A)
  assertEquals(typeof metadata.promoteCommandId, 'string')
})

test('onFenceCommandSucceeded is a no-op for a missing or terminal journal', async () => {
  const missing = createHarness({ recovery: null })
  await onFenceCommandSucceeded(missing.db, okQueue(), {
    recoveryId: REC_ID,
    commandId: 'cmd-1',
    fencePhase: 'drain',
    engine: 'postgres',
    actor: ACTOR,
  })

  const terminal = createHarness({
    recovery: recoveryRow({ state: 'completed' }),
  })
  await onFenceCommandSucceeded(terminal.db, okQueue(), {
    recoveryId: REC_ID,
    commandId: 'cmd-1',
    fencePhase: 'stop',
    engine: 'postgres',
    actor: ACTOR,
  })
  assertEquals(terminal.recovery()?.state, 'completed')
})

test('onFenceCommandSucceeded keeps fencing while other fence commands remain', async () => {
  const harness = createHarness({
    recovery: recoveryRow({
      metadata: { fenceCommandIds: ['cmd-drain', 'cmd-stop'] },
    }),
  })
  await onFenceCommandSucceeded(harness.db, okQueue(), {
    recoveryId: REC_ID,
    commandId: 'cmd-drain',
    fencePhase: 'drain',
    engine: 'postgres',
    actor: ACTOR,
  })
  const stored = harness.recovery()
  if (!stored) throw new TypeError('expected stored recovery')
  assertEquals(stored.state, 'fencing')
  const metadata = stored.metadata as { fenceCommandIds?: string[]; drainApplied?: boolean }
  assertEquals(metadata.fenceCommandIds, ['cmd-stop'])
  assertEquals(metadata.drainApplied, true)
})

test('onFenceCommandSucceeded blocks automatic failover when fencing is unproven', async () => {
  const harness = createHarness({
    recovery: recoveryRow({
      kind: 'automatic-failover',
      metadata: { fenceCommandIds: ['cmd-stop'] },
    }),
  })
  await onFenceCommandSucceeded(harness.db, okQueue(), {
    recoveryId: REC_ID,
    commandId: 'cmd-stop',
    fencePhase: 'stop',
    engine: 'postgres',
    actor: ACTOR,
  })
  assertEquals(harness.recovery()?.state, 'blocked')
  assertEquals(harness.managedStatus.includes('ready'), true)
})

test('onFenceCommandSucceeded promotes after a proven fence', async () => {
  const queue = okQueue()
  const members = [member(), failoverReplica()]
  const harness = createHarness({
    members,
    recovery: recoveryRow({
      kind: 'switchover',
      metadata: {
        fenceCommandIds: ['cmd-stop'],
        drainApplied: true,
      },
    }),
  })
  await onFenceCommandSucceeded(harness.db, queue, {
    recoveryId: REC_ID,
    commandId: 'cmd-stop',
    fencePhase: 'stop',
    engine: 'postgres',
    actor: ACTOR,
  })
  assertEquals(queue.envelopes.length, 1)
  assertEquals((queue.envelopes[0] as { type: string }).type, 'managed.promote')
  const metadata = harness.recovery()?.metadata as { promoteCommandId?: string; fenced?: boolean }
  assertEquals(typeof metadata.promoteCommandId, 'string')
  assertEquals(metadata.fenced, true)
})

test('onFenceCommandSucceeded recovers via Orchestrator after a proven HA fence', async () => {
  const queue = okQueue()
  const harness = createHarness({
    members: [member(), failoverReplica()],
    recovery: recoveryRow({
      kind: 'switchover',
      metadata: {
        fenceCommandIds: ['cmd-stop'],
        drainApplied: true,
        haPresent: true,
      },
    }),
  })
  await onFenceCommandSucceeded(harness.db, queue, {
    recoveryId: REC_ID,
    commandId: 'cmd-stop',
    fencePhase: 'stop',
    engine: 'postgres',
    actor: ACTOR,
  })
  assertEquals((queue.envelopes[0] as { type: string }).type, 'managed.ha.failover')
})

test('onFenceCommandSucceeded does not enqueue when source or target members are gone', async () => {
  const queue = okQueue()
  const harness = createHarness({
    members: [member()],
    recovery: recoveryRow({
      kind: 'switchover',
      metadata: { fenceCommandIds: ['cmd-stop'], drainApplied: true },
    }),
  })
  await onFenceCommandSucceeded(harness.db, queue, {
    recoveryId: REC_ID,
    commandId: 'cmd-stop',
    fencePhase: 'stop',
    engine: 'postgres',
    actor: ACTOR,
  })
  assertEquals(queue.envelopes.length, 0)
})

test('onFenceCommandSucceeded does not enqueue promote without a command queue', async () => {
  const harness = createHarness({
    members: [member(), failoverReplica()],
    recovery: recoveryRow({
      kind: 'switchover',
      metadata: { fenceCommandIds: ['cmd-stop'], drainApplied: true },
    }),
  })
  await onFenceCommandSucceeded(harness.db, undefined, {
    recoveryId: REC_ID,
    commandId: 'cmd-stop',
    fencePhase: 'stop',
    engine: 'postgres',
    actor: ACTOR,
  })
  assertEquals(harness.recovery()?.state, 'promoting')
})

test('onFenceCommandFailed advances once the last fence command is gone', async () => {
  const harness = createHarness({
    recovery: recoveryRow({
      kind: 'automatic-failover',
      metadata: { fenceCommandIds: ['cmd-drain'] },
    }),
  })
  await onFenceCommandFailed(harness.db, okQueue(), {
    recoveryId: REC_ID,
    commandId: 'cmd-drain',
    engine: 'postgres',
    actor: ACTOR,
  })
  assertEquals(harness.recovery()?.state, 'blocked')
})

test('onFenceCommandFailed is a no-op for a missing journal', async () => {
  const harness = createHarness({ recovery: null })
  await onFenceCommandFailed(harness.db, okQueue(), {
    recoveryId: REC_ID,
    commandId: 'cmd-1',
    engine: 'postgres',
    actor: ACTOR,
  })
  assertEquals(harness.recovery(), null)
})

test('onPromoteSucceeded is a no-op for a missing or terminal journal', async () => {
  await onPromoteSucceeded(
    createHarness({ recovery: null }).db,
    undefined,
    {},
    REC_ID,
    ACTOR_ID,
  )
  const terminal = createHarness({
    recovery: recoveryRow({ state: 'failed' }),
  })
  await onPromoteSucceeded(terminal.db, undefined, {}, REC_ID, ACTOR_ID)
  assertEquals(terminal.recovery()?.state, 'failed')
})

test('onPromoteSucceeded completes when exactly one writer remains', async () => {
  const harness = createHarness({
    members: [member(), failoverReplica()],
    recovery: recoveryRow({ kind: 'switchover', state: 'promoting' }),
  })
  await onPromoteSucceeded(harness.db, undefined, {}, REC_ID, ACTOR_ID)
  assertEquals(harness.recovery()?.state, 'completed')
})

test('onPromoteSucceeded fans out ingress and HA reconcile when secrets are present', async () => {
  const queue = okQueue()
  const harness = createHarness({
    members: [member(), failoverReplica()],
    recovery: recoveryRow({ kind: 'switchover', state: 'promoting' }),
  })
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  await onPromoteSucceeded(
    harness.db,
    queue,
    { secretsConfig, dataEncryptionSecrets },
    REC_ID,
    ACTOR_ID,
  )
  assertEquals(harness.recovery()?.state, 'completed')
})

test('onPromoteSucceeded fails when writer count is not exactly one', async () => {
  const harness = createHarness({
    members: [member(), member({ id: MEM_READ, ordinal: 3 })],
    recovery: recoveryRow({ kind: 'switchover', state: 'promoting' }),
  })
  await onPromoteSucceeded(harness.db, undefined, {}, REC_ID, ACTOR_ID)
  assertEquals(harness.recovery()?.state, 'failed')
})

test('onPromoteSucceeded reclassifies leftover failover members after disaster recovery', async () => {
  const members = [
    member({ id: MEM_REPLICA, role: 'primary', serverId: SERVER_A }),
    member({
      id: MEM_PRIMARY,
      role: 'replica',
      replicaClass: 'failover',
      serverId: SERVER_B,
      ordinal: 2,
    }),
    member({
      id: MEM_READ,
      role: 'replica',
      replicaClass: 'read',
      serverId: SERVER_A,
      ordinal: 3,
    }),
  ]
  const harness = createHarness({
    members,
    pins: [
      {
        ipId: 'ip-a',
        serverId: SERVER_A,
        datacenterId: DC_A,
        networkId: 'net-1',
        address: '203.0.113.10',
      },
      {
        ipId: 'ip-b',
        serverId: SERVER_B,
        datacenterId: DC_B,
        networkId: 'net-2',
        address: '203.0.113.20',
      },
    ],
    recovery: recoveryRow({
      kind: 'disaster-recovery',
      state: 'promoting',
      sourcePrimaryMemberId: MEM_PRIMARY,
      targetMemberId: MEM_REPLICA,
    }),
  })
  await onPromoteSucceeded(harness.db, undefined, {}, REC_ID, ACTOR_ID)
  assertEquals(
    harness.nodePatches.some((patch) => patch.replicaClass === 'read'),
    true,
  )
  assertEquals(harness.recovery()?.state, 'completed')
})

test('onPromoteSucceeded skips reclassify when the new primary member is missing', async () => {
  const harness = createHarness({
    members: [member()],
    recovery: recoveryRow({
      kind: 'disaster-recovery',
      state: 'promoting',
      targetMemberId: 'missing-target',
    }),
  })
  await onPromoteSucceeded(harness.db, undefined, {}, REC_ID, ACTOR_ID)
  assertEquals(harness.nodePatches.length, 0)
  assertEquals(harness.recovery()?.state, 'completed')
})

test('onRecoveryCommandFailed marks a live journal failed', async () => {
  const harness = createHarness({
    recovery: recoveryRow({ state: 'promoting' }),
  })
  await onRecoveryCommandFailed(harness.db, REC_ID)
  assertEquals(harness.recovery()?.state, 'failed')
})

test('onRecoveryCommandFailed ignores a missing or terminal journal', async () => {
  const missing = createHarness({ recovery: null })
  await onRecoveryCommandFailed(missing.db, REC_ID)
  assertEquals(missing.recovery(), null)

  const terminal = createHarness({
    recovery: recoveryRow({ state: 'blocked' }),
  })
  await onRecoveryCommandFailed(terminal.db, REC_ID)
  assertEquals(terminal.recovery()?.state, 'blocked')
})

test('beginAutomaticFailover returns the latest row when fencing enqueue fails', async () => {
  const harness = createHarness({
    pins: [{
      ipId: 'ip-1',
      serverId: SERVER_A,
      datacenterId: DC_A,
      networkId: 'net-1',
      address: '203.0.113.10',
    }],
    connected: [true, true],
  })
  const row = expectRecord(
    await beginAutomaticFailover({
      db: harness.db,
      commandQueue: failingQueue(),
      managedId: MANAGED_ID,
      engine: 'postgres',
      members: [member(), failoverReplica()],
      actor: ACTOR,
    }),
  )
  assertEquals(row.id, REC_ID)
})
