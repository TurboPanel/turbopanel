import { assertEquals } from '@std/assert'
import { getTableName } from 'drizzle-orm'
import type { PrivateEndpointError } from '../net/private-endpoint.ts'
import { SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME } from '../system/hierarchy.ts'
import type { ManagedMemberRow } from './members.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { CommandQueue } from '../commands/queue.ts'
import type { Db } from '../../db/connection.ts'
import {
  enqueueManagedHaReconcile,
  fanOutManagedHaReconcile,
  fanOutOrganizationHaReconcile,
  haReconcileEnqueuer,
  listOrganizationOrchestratorServerIds,
  selectOrchestratorHostServerIds,
  haClusterMemberRole,
  haClusterReplicaClass,
  haIdentity,
  haTeardownIfPresent,
  MANAGED_HA_RECONCILE_TTL_MS,
  resolveHaMemberDial,
  resolveLocalHaMemberDial,
  resolveRemoteHaMemberDial,
  toHaClusterMember,
  type HaEndpointMap,
} from './ha-desired.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_A = '550e8400-e29b-41d4-a716-446655440000'
/** Org-wide managed Docker network name — a `network.kind='managed'` row id. */
const MANAGED_NETWORK = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'
const SERVER_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const REMOTE_HOST = '203.0.113.10'

function member(overrides: Partial<ManagedMemberRow> = {}): ManagedMemberRow {
  return {
    id: 'mem-local',
    managedId: 'mgd-1',
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('haClusterMemberRole and replicaClass stay on the wire vocabulary', () => {
  assertEquals(haClusterMemberRole('primary'), 'primary')
  assertEquals(haClusterMemberRole('replica'), 'replica')
  assertEquals(haClusterMemberRole('standby'), 'replica')
  assertEquals(haClusterReplicaClass('read'), 'read')
  assertEquals(haClusterReplicaClass('failover'), 'failover')
  assertEquals(haClusterReplicaClass('other'), null)
  assertEquals(haClusterReplicaClass(null), null)
  assertEquals(MANAGED_HA_RECONCILE_TTL_MS, 300_000)
})

test('resolveLocalHaMemberDial prefers the allocated container name', () => {
  const named = resolveLocalHaMemberDial(member(), new Map([[1, 'pg-1']]), 5432)
  assertEquals(named, { host: 'pg-1', port: 5432, containerName: 'pg-1' })

  const fallback = resolveLocalHaMemberDial(member(), new Map(), 5433)
  assertEquals(fallback, { host: 'mem-local', port: 5433 })
})

test('resolveRemoteHaMemberDial requires a resolved endpoint and private port', () => {
  const remote = member({ id: 'mem-remote', serverId: SERVER_B, privatePort: 15432 })
  const ok: HaEndpointMap = new Map([[SERVER_B, { address: REMOTE_HOST, transport: 'datacenter' }]])
  assertEquals(resolveRemoteHaMemberDial(remote, ok), {
    host: REMOTE_HOST,
    port: 15432,
  })

  const missing: HaEndpointMap = new Map()
  assertEquals(resolveRemoteHaMemberDial(remote, missing), null)

  const unavailable: HaEndpointMap = new Map([
    [SERVER_B, { kind: 'private_path_unavailable' } as PrivateEndpointError],
  ])
  assertEquals(resolveRemoteHaMemberDial(remote, unavailable), null)

  assertEquals(
    resolveRemoteHaMemberDial(member({ serverId: SERVER_B, privatePort: null }), ok),
    null
  )
})

test('resolveHaMemberDial splits local versus remote members', () => {
  const endpoints: HaEndpointMap = new Map([
    [SERVER_B, { address: REMOTE_HOST, transport: 'fabric' }],
  ])
  const local = resolveHaMemberDial(member(), SERVER_A, new Map([[1, 'pg-1']]), 5432, endpoints)
  assertEquals(local?.containerName, 'pg-1')

  const remote = resolveHaMemberDial(
    member({ id: 'mem-remote', serverId: SERVER_B, privatePort: 15432 }),
    SERVER_A,
    new Map(),
    5432,
    endpoints
  )
  assertEquals(remote, { host: REMOTE_HOST, port: 15432 })
})

test('toHaClusterMember copies dial fields and promotion rule', () => {
  const mapped = toHaClusterMember(member({ replicaClass: 'failover' }), {
    host: 'pg-1',
    port: 5432,
    containerName: 'pg-1',
  })
  assertEquals(mapped.memberId, 'mem-local')
  assertEquals(mapped.role, 'primary')
  assertEquals(mapped.replicaClass, 'failover')
  assertEquals(mapped.host, 'pg-1')
  assertEquals(mapped.port, 5432)
  assertEquals(mapped.containerName, 'pg-1')
})

test('haIdentity and haTeardownIfPresent describe an absent Orchestrator', () => {
  assertEquals(haIdentity('svc-ha', 'svc-ha-ha'), {
    serviceId: 'svc-ha',
    composeServiceName: SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME,
    containerName: 'svc-ha-ha',
  })
  assertEquals(haTeardownIfPresent(SERVER_A, null, MANAGED_NETWORK), null)

  const payload = haTeardownIfPresent(
    SERVER_A,
    {
      workspaceId: 'ws',
      projectId: 'proj',
      environmentId: 'env',
      serviceId: 'svc-ha',
      containerRowId: 'row',
      containerName: 'svc-ha-ha',
    },
    MANAGED_NETWORK
  )
  assertEquals(payload?.desired, 'absent')
  assertEquals(payload?.serverId, SERVER_A)
  assertEquals(payload?.managedNetwork, MANAGED_NETWORK)
  assertEquals(payload?.identity.containerName, 'svc-ha-ha')
  assertEquals(payload?.clusters, [])
  assertEquals(payload?.raft, null)

  const unnamed = haTeardownIfPresent(
    SERVER_A,
    {
      workspaceId: 'ws',
      projectId: 'proj',
      environmentId: 'env',
      serviceId: 'svc-ha',
      containerRowId: 'row',
      containerName: undefined as unknown as string,
    },
    MANAGED_NETWORK
  )
  assertEquals(unnamed?.identity.containerName, 'svc-ha')
})

test('enqueueManagedHaReconcile is not_needed when the server has no organization', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  const secrets = parseTestSecretsConfig()
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(secrets, 'data-encryption')
  const result = await enqueueManagedHaReconcile(
    db,
    { enqueue: () => Promise.resolve() } as CommandQueue,
    {
      serverId: SERVER_A,
      actorType: 'system',
      actorId: 'actor-1',
      secretsConfig: secrets,
      dataEncryptionSecrets,
    }
  )
  assertEquals(result, { ok: false, reason: 'not_needed' })
})

test('fanOutManagedHaReconcile no-ops when no HA hosts are present', async () => {
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve([]),
        }),
        where: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Db
  const secrets = parseTestSecretsConfig()
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(secrets, 'data-encryption')
  await fanOutManagedHaReconcile(db, { enqueue: () => Promise.resolve() } as CommandQueue, {
    managedId: 'mgd-1',
    actorType: 'system',
    actorId: 'actor-1',
    secretsConfig: secrets,
    dataEncryptionSecrets,
  })
})

const SERVER_C = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SERVER_D = '8d0f7780-8536-41ef-955c-f18ad2a01bf8'
const ORG = '11111111-1111-4111-8111-111111111111'

function tableNameOf(value: unknown): string {
  try {
    return getTableName(value as never)
  } catch {
    return ''
  }
}

/**
 * Chainable fake: every select resolves to the rows `rowsFor` picks from the
 * `from` table and the joined tables (comma-separated). `where` is ignored.
 */
function routedDb(rowsFor: (from: string, join: string) => Record<string, unknown>[]): Db {
  return {
    select: () => ({
      from: (table: unknown) => {
        const joins: string[] = []
        const resolve = () => Promise.resolve(rowsFor(tableNameOf(table), joins.join(',')))
        const self = {
          innerJoin: (joinTable: unknown) => {
            joins.push(tableNameOf(joinTable))
            return self
          },
          where: () => self,
          limit: () => resolve(),
          then: (
            onFulfilled?: (value: Record<string, unknown>[]) => unknown,
            onRejected?: (reason: unknown) => unknown
          ) => resolve().then(onFulfilled, onRejected),
        }
        return self
      },
    }),
  } as unknown as Db
}

async function withRecordedEnqueues(fn: (attempted: string[]) => Promise<void>): Promise<void> {
  const original = haReconcileEnqueuer.enqueue
  const attempted: string[] = []
  haReconcileEnqueuer.enqueue = (_db, _queue, params) => {
    attempted.push(params.serverId)
    if (params.serverId === SERVER_D)
      return Promise.resolve({ ok: false, reason: 'enqueue_failed' })
    return Promise.resolve({
      ok: true,
      commandId: `cmd-${params.serverId}`,
      serverId: params.serverId,
    })
  }
  try {
    await fn(attempted)
  } finally {
    haReconcileEnqueuer.enqueue = original
  }
}

async function fanOutParams() {
  const secrets = parseTestSecretsConfig()
  return {
    actorType: 'system' as const,
    actorId: 'actor-1',
    secretsConfig: secrets,
    dataEncryptionSecrets: await deriveEncryptionSecretsConfig(secrets, 'data-encryption'),
  }
}

test('selectOrchestratorHostServerIds keeps Raft voters and leftover Orchestrators only', () => {
  const ids = selectOrchestratorHostServerIds(
    [
      { serverId: SERVER_B, role: 'primary', replicaClass: null, engine: 'mysql' },
      { serverId: SERVER_A, role: 'replica', replicaClass: 'failover', engine: 'mariadb' },
      // Postgres never runs Orchestrator; a read replica is not a voter.
      { serverId: SERVER_C, role: 'primary', replicaClass: null, engine: 'postgres' },
      { serverId: SERVER_D, role: 'replica', replicaClass: 'read', engine: 'mysql' },
      { serverId: SERVER_B, role: 'replica', replicaClass: 'failover', engine: 'mysql' },
    ],
    // A server whose clusters were deleted still has its Orchestrator.
    [SERVER_D, SERVER_A]
  )
  assertEquals(
    ids,
    [SERVER_A, SERVER_B, SERVER_D].toSorted((a, b) => a.localeCompare(b))
  )
})

test('listOrganizationOrchestratorServerIds is empty without organizations', async () => {
  const db = routedDb(() => {
    throw new Error('no query expected')
  })
  assertEquals(await listOrganizationOrchestratorServerIds(db, []), [])
})

test('fanOutManagedHaReconcile reaches Raft peers outside the cluster', async () => {
  // The cluster's members are SERVER_A (primary) and SERVER_B (read replica).
  // SERVER_C hosts another MySQL cluster of the same organization: it is the
  // Raft leader the members' followers forward /api/discover to, so it must
  // get the same trust bundle and peer list. SERVER_D only has a leftover
  // Orchestrator (its clusters were deleted).
  const db = routedDb((from, join) => {
    const clusterMembers = [
      { serverId: SERVER_A, role: 'primary', replicaClass: null, engine: 'mysql' },
      { serverId: SERVER_B, role: 'replica', replicaClass: 'read', engine: 'mysql' },
    ]
    // This cluster's own members.
    if (from === 'replica' && join === 'managed') return clusterMembers
    // Every member row of the organization.
    if (from === 'replica' && join === 'managed,server') {
      return [
        ...clusterMembers,
        { serverId: SERVER_C, role: 'primary', replicaClass: null, engine: 'mysql' },
      ]
    }
    if (from === 'server') return [{ organizationId: ORG }, { organizationId: null }]
    if (from === 'environment') return [{ serverId: SERVER_D }, { serverId: null }]
    return []
  })
  await withRecordedEnqueues(async (attempted) => {
    await fanOutManagedHaReconcile(db, { enqueue: () => Promise.resolve() } as CommandQueue, {
      managedId: 'mgd-1',
      ...(await fanOutParams()),
    })
    assertEquals(attempted.toSorted(), [SERVER_A, SERVER_C, SERVER_D].toSorted())
  })
})

test('fanOutOrganizationHaReconcile queues every Orchestrator host and reports the queued ids', async () => {
  const db = routedDb((from, join) => {
    if (from === 'replica' && join === 'managed,server') {
      return [
        { serverId: SERVER_A, role: 'primary', replicaClass: null, engine: 'mariadb' },
        { serverId: SERVER_B, role: 'primary', replicaClass: null, engine: 'postgres' },
      ]
    }
    if (from === 'environment') return [{ serverId: SERVER_D }]
    return []
  })
  await withRecordedEnqueues(async (attempted) => {
    const ids = await fanOutOrganizationHaReconcile(
      db,
      { enqueue: () => Promise.resolve() } as CommandQueue,
      { organizationId: ORG, ...(await fanOutParams()) }
    )
    assertEquals(attempted.toSorted(), [SERVER_A, SERVER_D].toSorted())
    // SERVER_D's enqueue failed: it is logged, not reported as queued.
    assertEquals(ids, [`cmd-${SERVER_A}`])
  })
})
