import { assertEquals } from '@std/assert'
import type { PrivateEndpointError } from '../../lib/net/private-endpoint.ts'
import { SYSTEM_ORCHESTRATOR_COMPOSE_SERVICE_NAME } from '../system/hierarchy.ts'
import type { ManagedMemberRow } from './members.ts'
import {
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
  const named = resolveLocalHaMemberDial(
    member(),
    new Map([[1, 'pg-1']]),
    5432,
  )
  assertEquals(named, { host: 'pg-1', port: 5432, containerName: 'pg-1' })

  const fallback = resolveLocalHaMemberDial(member(), new Map(), 5433)
  assertEquals(fallback, { host: 'mem-local', port: 5433 })
})

test('resolveRemoteHaMemberDial requires a resolved endpoint and private port', () => {
  const remote = member({ id: 'mem-remote', serverId: SERVER_B, privatePort: 15432 })
  const ok: HaEndpointMap = new Map([
    [SERVER_B, { address: REMOTE_HOST, transport: 'datacenter' }],
  ])
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
    null,
  )
})

test('resolveHaMemberDial splits local versus remote members', () => {
  const endpoints: HaEndpointMap = new Map([
    [SERVER_B, { address: REMOTE_HOST, transport: 'fabric' }],
  ])
  const local = resolveHaMemberDial(
    member(),
    SERVER_A,
    new Map([[1, 'pg-1']]),
    5432,
    endpoints,
  )
  assertEquals(local?.containerName, 'pg-1')

  const remote = resolveHaMemberDial(
    member({ id: 'mem-remote', serverId: SERVER_B, privatePort: 15432 }),
    SERVER_A,
    new Map(),
    5432,
    endpoints,
  )
  assertEquals(remote, { host: REMOTE_HOST, port: 15432 })
})

test('toHaClusterMember copies dial fields and promotion rule', () => {
  const mapped = toHaClusterMember(
    member({ replicaClass: 'failover' }),
    { host: 'pg-1', port: 5432, containerName: 'pg-1' },
  )
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
  assertEquals(haTeardownIfPresent(SERVER_A, null), null)

  const payload = haTeardownIfPresent(SERVER_A, {
    workspaceId: 'ws',
    projectId: 'proj',
    environmentId: 'env',
    serviceId: 'svc-ha',
    containerRowId: 'row',
    containerName: 'svc-ha-ha',
  })
  assertEquals(payload?.desired, 'absent')
  assertEquals(payload?.serverId, SERVER_A)
  assertEquals(payload?.identity.containerName, 'svc-ha-ha')
  assertEquals(payload?.clusters, [])
  assertEquals(payload?.raft, null)

  const unnamed = haTeardownIfPresent(SERVER_A, {
    workspaceId: 'ws',
    projectId: 'proj',
    environmentId: 'env',
    serviceId: 'svc-ha',
    containerRowId: 'row',
    containerName: undefined as unknown as string,
  })
  assertEquals(unnamed?.identity.containerName, 'svc-ha')
})
