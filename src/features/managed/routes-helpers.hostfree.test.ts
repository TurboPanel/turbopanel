/**
 * Host-free coverage for managed route pure helpers extracted from routes.ts.
 */

import { assertEquals } from '@std/assert'
import { BadRequestError } from '../../client/shared.ts'
import {
  assertFailoverReplicaTransportAllowed,
  buildDisasterRecoveryQueuedResponse,
  buildEmptyManagedDetailResponse,
  buildFencePromotePendingResponse,
  buildManagedDeleteHardResponse,
  buildManagedDeleteQueuedResponse,
  buildManagedForceHostCleanup,
  buildManagedDestroyQueuedResponse,
  buildManagedSslView,
  buildOrgManagedListEntry,
  buildPromoteQueuedResponse,
  buildQueuedFanoutResponse,
  buildStatusMemberView,
  canHardDeleteManaged,
  evaluateManagedDatabaseDelete,
  evaluateManagedLoginDropGuard,
  evaluateManagedLoginRotateGuard,
  evaluateOperatorPromoteGate,
  evaluatePromoteLagHttpGate,
  evaluatePromoteMemberRole,
  evaluatePromoteReplicaClass,
  evaluateReplicaClassConversion,
  evaluateReplicaPlacementPrechecks,
  managedStatusListenerParams,
  mergeManagedPatchSettings,
  nextDatabasesAfterCreate,
  nextDatabasesAfterDelete,
  operatorPromoteHttpResult,
  operatorPromoteRequiresFence,
  parseDisasterRecoveryPromoteBody,
  parseManagedConnectionRole,
  parseManagedCreateName,
  parseManagedLifecycleAction,
  parseMemberPatch,
  parseMemberReadEligibleCreate,
  parseMemberReadEligiblePatch,
  parsePromoteForce,
  parseReplicaClassCreate,
  pickPrimaryCommandResult,
  replicaEndpointPurpose,
  replicaPlacementNeedsDatacenter,
  validateManagedDatabaseCreateName,
} from './routes-helpers.ts'
import { postgresEngineSpec } from './postgres.ts'
import { privateEndpointErrorResponse } from '../net/private-endpoint.ts'
import { writeManagedSettings } from './options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseManagedLifecycleAction accepts start/stop/restart only', () => {
  assertEquals(parseManagedLifecycleAction({ action: 'start' }), {
    ok: true,
    action: 'start',
  })
  assertEquals(parseManagedLifecycleAction({ action: 'stop' }), {
    ok: true,
    action: 'stop',
  })
  assertEquals(parseManagedLifecycleAction({ action: 'restart' }), {
    ok: true,
    action: 'restart',
  })
  assertEquals(parseManagedLifecycleAction({ action: 'pause' }), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseManagedLifecycleAction({}), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
})

test('parseManagedCreateName accepts null/string and maps BadRequestError', () => {
  const omitted = parseManagedCreateName({})
  if (!omitted.ok) throw new TypeError('expected ok')
  assertEquals(omitted.name, null)

  const named = parseManagedCreateName({ name: 'Orders DB' })
  if (!named.ok) throw new TypeError('expected ok')
  assertEquals(named.name, 'Orders DB')

  const invalid = parseManagedCreateName({ name: '   ' })
  if (invalid.ok) throw new TypeError('expected invalid blank name')
  assertEquals(invalid, { ok: false, error: 'Invalid request', status: 400 })

  const wrongType = parseManagedCreateName({ name: 42 })
  if (wrongType.ok) throw new TypeError('expected non-string rejection')
  assertEquals(wrongType.status, 400)
})

test('parseManagedCreateName rethrows unexpected errors', () => {
  let threw = false
  try {
    parseManagedCreateName(
      new Proxy({} as Record<string, unknown>, {
        get(_target, prop) {
          if (prop === 'name') throw new TypeError('unexpected')
          return undefined
        },
        has(_target, prop) {
          return prop === 'name'
        },
      })
    )
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
    assertEquals(error instanceof BadRequestError, false)
  }
  assertEquals(threw, true)
})

test('mergeManagedPatchSettings merges settings object and rejects invalid', () => {
  const base = postgresEngineSpec.parseSettings(postgresEngineSpec.defaultSettings)
  if (!base) throw new TypeError('expected defaults')

  const merged = mergeManagedPatchSettings(postgresEngineSpec, base, {
    settings: { ssl: { mode: 'require' } },
  })
  if (!merged) throw new TypeError('expected merged')
  assertEquals(merged.ssl.mode, 'require')

  const ignored = mergeManagedPatchSettings(postgresEngineSpec, base, {
    settings: 'nope',
  })
  if (!ignored) throw new TypeError('expected base when settings non-object')
  assertEquals(ignored, base)

  const invalid = mergeManagedPatchSettings(postgresEngineSpec, base, {
    settings: { image: '' },
  })
  assertEquals(invalid, null)
})

test('validateManagedDatabaseCreateName rejects bad names and duplicates', () => {
  const id = postgresEngineSpec.userOperations.identifier
  assertEquals(validateManagedDatabaseCreateName('good_db', ['postgres'], id), null)
  assertEquals(
    validateManagedDatabaseCreateName('bad name', ['postgres'], id)?.error,
    'Invalid database name'
  )
  assertEquals(validateManagedDatabaseCreateName('postgres', ['postgres'], id), {
    ok: false,
    error: 'database_exists',
    status: 409,
  })
})

test('evaluateManagedDatabaseDelete guards initial and missing names', () => {
  assertEquals(evaluateManagedDatabaseDelete('missing', ['postgres', 'app'], 'postgres'), {
    ok: false,
    error: 'Not found',
    status: 404,
  })
  assertEquals(evaluateManagedDatabaseDelete('postgres', ['postgres', 'app'], 'postgres'), {
    ok: false,
    error: 'cannot_drop_initial_database',
    status: 409,
  })
  assertEquals(evaluateManagedDatabaseDelete('app', ['postgres', 'app'], 'postgres'), null)
})

test('nextDatabasesAfterCreate/Delete sort and filter', () => {
  assertEquals(nextDatabasesAfterCreate(['zeta', 'alpha'], 'mid'), ['alpha', 'mid', 'zeta'])
  assertEquals(nextDatabasesAfterDelete(['a', 'b', 'c'], 'b'), ['a', 'c'])
})

test('parsePromoteForce and readEligible parsers', () => {
  assertEquals(parsePromoteForce({ force: true }), true)
  assertEquals(parsePromoteForce({ force: false }), false)
  assertEquals(parsePromoteForce({}), false)
  assertEquals(parseMemberReadEligibleCreate({ readEligible: true }), true)
  assertEquals(parseMemberReadEligibleCreate({ readEligible: 'yes' }), false)

  assertEquals(parseMemberReadEligiblePatch({ readEligible: false }), {
    ok: true,
    readEligible: false,
  })
  assertEquals(parseMemberReadEligiblePatch({}), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseReplicaClassCreate({}), {
    ok: true,
    replicaClass: 'failover',
  })
  assertEquals(parseReplicaClassCreate({ replicaClass: 'read' }), {
    ok: true,
    replicaClass: 'read',
  })
  assertEquals(parseReplicaClassCreate({ replicaClass: 'nope' }), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseMemberPatch({ replicaClass: 'read' }), {
    ok: true,
    replicaClass: 'read',
  })
  assertEquals(parseMemberPatch({ readEligible: true, replicaClass: 'failover' }), {
    ok: true,
    readEligible: true,
    replicaClass: 'failover',
  })
  assertEquals(parseMemberPatch({}), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
})

test('canHardDeleteManaged is true only when unplaced', () => {
  assertEquals(canHardDeleteManaged(null), true)
  assertEquals(canHardDeleteManaged(undefined), true)
  assertEquals(canHardDeleteManaged('s1'), false)
})

test('evaluateReplicaPlacementPrechecks blocks duplicate members only', () => {
  assertEquals(evaluateReplicaPlacementPrechecks([{ serverId: 's1', role: 'primary' }], 's1'), {
    ok: false,
    error: 'managed_member_exists',
    status: 409,
  })
  assertEquals(evaluateReplicaPlacementPrechecks([{ serverId: 's1', role: 'primary' }], 's2'), null)
})

test('replicaPlacementNeedsDatacenter is class-aware', () => {
  assertEquals(replicaPlacementNeedsDatacenter('fabric', 'read'), false)
  assertEquals(replicaPlacementNeedsDatacenter('public', 'read'), false)
  assertEquals(replicaPlacementNeedsDatacenter('datacenter', 'read'), true)
  assertEquals(replicaPlacementNeedsDatacenter('local', 'read'), true)
  assertEquals(replicaPlacementNeedsDatacenter('fabric', 'failover'), false)
  assertEquals(replicaPlacementNeedsDatacenter('public', 'failover'), true)
  assertEquals(replicaPlacementNeedsDatacenter('datacenter', 'failover'), true)
  assertEquals(replicaPlacementNeedsDatacenter('local', 'failover'), true)
})

test('assertFailoverReplicaTransportAllowed allows fabric and rejects public', () => {
  assertEquals(assertFailoverReplicaTransportAllowed('local'), null)
  assertEquals(assertFailoverReplicaTransportAllowed('datacenter'), null)
  assertEquals(assertFailoverReplicaTransportAllowed('fabric'), null)
  assertEquals(assertFailoverReplicaTransportAllowed('public'), {
    kind: 'failover_replica_requires_datacenter_transport',
  })
})

test('untrusted_network_needs_fabric maps to a 422 with an error-only body', async () => {
  // The managed routes surface resolver errors through
  // `privateEndpointErrorResponse` (replica create / member class patch);
  // the untrusted-datacenter refusal must keep its own code rather than
  // collapsing into `failover_replica_requires_datacenter_transport`.
  const c = {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Parameters<typeof privateEndpointErrorResponse>[0]
  const response = privateEndpointErrorResponse(c, {
    kind: 'untrusted_network_needs_fabric',
    fromServerId: 's-replica',
    toServerId: 's-primary',
    datacenterId: 'dc-untrusted',
  })
  assertEquals(response.status, 422)
  assertEquals(await response.json(), {
    error: 'untrusted_network_needs_fabric',
  })
  // A trusted-derived `datacenter` transport still passes the class gate.
  assertEquals(assertFailoverReplicaTransportAllowed('datacenter'), null)
})

test('evaluateReplicaClassConversion allows failover to read and gates the reverse', () => {
  const replica = { role: 'replica', replicaClass: 'failover' as const }
  assertEquals(evaluateReplicaClassConversion(replica, 'read', false), null)
  assertEquals(
    evaluateReplicaClassConversion({ role: 'replica', replicaClass: 'read' }, 'failover', false),
    {
      ok: false,
      error: 'failover_replica_requires_datacenter_transport',
      status: 422,
    }
  )
  assertEquals(
    evaluateReplicaClassConversion({ role: 'replica', replicaClass: 'read' }, 'failover', true),
    null
  )
  assertEquals(
    evaluateReplicaClassConversion({ role: 'primary', replicaClass: null }, 'read', true),
    { ok: false, error: 'Invalid request', status: 400 }
  )
})

test('replica add/promote/conversion route helpers encode class rules', () => {
  assertEquals(replicaEndpointPurpose('failover'), 'failover-replication')
  assertEquals(replicaEndpointPurpose('read'), 'read-replication')
  assertEquals(evaluatePromoteReplicaClass('failover'), null)
  assertEquals(evaluatePromoteReplicaClass('read'), {
    ok: false,
    error: 'managed_replica_not_promotable',
    status: 422,
  })
  assertEquals(evaluatePromoteReplicaClass(null), {
    ok: false,
    error: 'managed_replica_not_promotable',
    status: 422,
  })
})

test('evaluatePromoteMemberRole requires replica', () => {
  assertEquals(evaluatePromoteMemberRole('replica'), null)
  assertEquals(evaluatePromoteMemberRole('primary'), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
})

test('user rotate/drop guards', () => {
  assertEquals(evaluateManagedLoginRotateGuard('root'), {
    ok: false,
    error: 'use_root_password_route',
    status: 400,
  })
  assertEquals(evaluateManagedLoginRotateGuard('replication'), {
    ok: false,
    error: 'cannot_rotate_replication_user',
    status: 400,
  })
  assertEquals(evaluateManagedLoginRotateGuard('user'), null)

  assertEquals(evaluateManagedLoginDropGuard('root'), {
    ok: false,
    error: 'cannot_drop_root_user',
    status: 400,
  })
  assertEquals(evaluateManagedLoginDropGuard('user'), null)
})

test('evaluatePromoteLagHttpGate honors force bypass', () => {
  assertEquals(evaluatePromoteLagHttpGate(undefined, true), null)
  assertEquals(evaluatePromoteLagHttpGate(undefined, false), 'managed_replica_not_streaming')
  const now = Date.parse('2026-08-10T12:00:00.000Z')
  assertEquals(
    evaluatePromoteLagHttpGate(
      {
        state: 'streaming',
        lagBytes: 1,
        lagSeconds: 1,
        observedAt: '2026-08-10T11:59:50.000Z',
      },
      false,
      now
    ),
    null
  )
})

test('evaluateOperatorPromoteGate requires fullyApplied for mysql-family engines', () => {
  const fresh = {
    state: 'streaming',
    lagBytes: 0,
    lagSeconds: 0,
    observedAt: '2026-08-10T12:00:00.000Z',
    fullyApplied: false,
  }
  const now = Date.parse('2026-08-10T12:00:01.000Z')
  assertEquals(
    evaluateOperatorPromoteGate(
      { ...fresh, receivedLsn: '0/100', replayLsn: '0/100' },
      false,
      now,
      'postgres'
    ),
    null
  )
  assertEquals(
    evaluateOperatorPromoteGate(fresh, false, now, 'mariadb'),
    'managed_replica_not_fully_applied'
  )
  assertEquals(
    evaluateOperatorPromoteGate({ ...fresh, fullyApplied: true }, false, now, 'mysql'),
    null
  )
  assertEquals(evaluateOperatorPromoteGate(fresh, true, now, 'mariadb'), null)
})

test('evaluateOperatorPromoteGate accepts an idle mysql pair only when a fence will run', () => {
  const idle = {
    state: 'streaming',
    lagSeconds: 0,
    observedAt: '2026-08-10T12:00:00.000Z',
    executedGtid: '3e11fa47-71ca-11e1-9e33-c80aa9429562:1-10',
  }
  const now = Date.parse('2026-08-10T12:00:01.000Z')
  const refused = 'managed_replica_not_fully_applied'
  const gate = (r: unknown, engine = 'mysql', fence: boolean | 'unset' = true, at = now) =>
    evaluateOperatorPromoteGate(r, false, at, engine, fence === 'unset' ? undefined : fence)
  assertEquals(gate(idle), null)
  // Dead source or no primary row (no fence, no required position): refused.
  assertEquals(gate(idle, 'mysql', false), refused)
  assertEquals(gate(idle, 'mysql', 'unset'), refused)
  // MariaDB positions mean something else: never the idle clause.
  assertEquals(gate(idle, 'mariadb'), refused)
  // Behind, unknown lag, nothing applied, or a received set the replica has not applied.
  assertEquals(gate({ ...idle, fullyApplied: false }), refused)
  assertEquals(gate({ ...idle, lagSeconds: undefined }), refused)
  assertEquals(gate({ ...idle, executedGtid: undefined }), refused)
  assertEquals(gate({ ...idle, receivedGtid: 'a:1-12' }), refused)
  // Applier or IO thread off, or a stale reading, never passes.
  assertEquals(gate({ ...idle, state: 'reconnecting' }), 'managed_replica_not_streaming')
  assertEquals(gate(idle, 'mysql', true, now + 60_000), 'managed_replica_health_stale')
  // A real fully-applied reading still passes without a fence.
  assertEquals(gate({ ...idle, fullyApplied: true }, 'mysql', false), null)
  // Only the idle pass carries the fence requirement on to the switchover.
  assertEquals(operatorPromoteRequiresFence(idle, false, 'mysql'), true)
  assertEquals(operatorPromoteRequiresFence({ ...idle, fullyApplied: true }, false, 'mysql'), false)
  assertEquals(operatorPromoteRequiresFence(idle, true, 'mysql'), false)
  assertEquals(operatorPromoteRequiresFence(idle, false, 'postgres'), false)
})

test('pickPrimaryCommandResult and queued response builders', () => {
  assertEquals(pickPrimaryCommandResult([]), undefined)
  assertEquals(
    pickPrimaryCommandResult([
      { serverId: 'a' },
      {
        commandId: 'c1',
        serverId: 'b',
      },
    ]),
    { commandId: 'c1', serverId: 'b' }
  )
  assertEquals(pickPrimaryCommandResult([{ serverId: 'only' }]), { serverId: 'only' })

  assertEquals(buildQueuedFanoutResponse([{ commandId: 'cmd', serverId: 'srv' }], 'fallback'), {
    ok: true,
    results: [{ commandId: 'cmd', serverId: 'srv' }],
    commandId: 'cmd',
    serverId: 'srv',
    status: 'queued',
  })
  assertEquals(buildQueuedFanoutResponse([{ serverId: undefined }], 'fallback'), {
    ok: true,
    results: [{ serverId: undefined }],
    commandId: undefined,
    serverId: 'fallback',
    status: 'queued',
  })
})

test('empty detail / delete / destroy / promote response shapes', () => {
  assertEquals(buildEmptyManagedDetailResponse(), {
    managed: null,
    connection: null,
    endpoints: [],
    connections: [],
    addressNeeded: false,
    // Nothing placed yet, so there is no host whose publish could be reported.
    exposure: null,
    settings: null,
    // No org default configured, so a not-yet-created cluster still reports the
    // platform TLS policy it will inherit.
    ssl: {
      configured: null,
      effective: 'require',
      organizationDefault: null,
      raisedForExternalAccess: false,
    },
    release: null,
    server: null,
    rootUsername: null,
    members: [],
    recovery: null,
  })
  assertEquals(buildEmptyManagedDetailResponse('verify-full').ssl, {
    configured: null,
    effective: 'verify-full',
    organizationDefault: 'verify-full',
    raisedForExternalAccess: false,
  })
  // A service override wins over the org default in both directions.
  assertEquals(buildManagedSslView('prefer', 'verify-full'), {
    configured: 'prefer',
    effective: 'prefer',
    organizationDefault: 'verify-full',
    raisedForExternalAccess: false,
  })
  // Under external access a mode without SSL is shown raised to require.
  assertEquals(buildManagedSslView('disable', undefined, true), {
    configured: 'disable',
    effective: 'require',
    organizationDefault: null,
    raisedForExternalAccess: true,
  })
  assertEquals(buildManagedDeleteHardResponse(), { ok: true, deleted: true })
  assertEquals(
    buildManagedForceHostCleanup(
      [{ serverId: 's-online' }, { serverId: 's-offline' }, { serverId: 's-offline' }],
      [
        { serverId: 's-online', status: 'queued' },
        { serverId: 's-offline', status: 'failed' },
      ],
      new Map([
        ['s-online', true],
        ['s-offline', false],
      ])
    ),
    [
      { serverId: 's-online', status: 'queued', online: true },
      { serverId: 's-offline', status: 'failed', online: false },
    ]
  )
  assertEquals(
    buildManagedDeleteHardResponse({
      hostCleanup: [
        { serverId: 's-online', status: 'queued', online: true },
        { serverId: 's-offline', status: 'failed', online: false },
      ],
    }),
    {
      ok: true,
      deleted: true,
      hostCleanup: [
        { serverId: 's-online', status: 'queued', online: true },
        { serverId: 's-offline', status: 'failed', online: false },
      ],
      note: 'The cleanup will run when 1 offline server(s) reconnect within 7 days.',
    }
  )
  assertEquals(
    buildManagedDeleteHardResponse({
      hostCleanup: [{ serverId: 's-online', status: 'queued', online: true }],
    }),
    {
      ok: true,
      deleted: true,
      hostCleanup: [{ serverId: 's-online', status: 'queued', online: true }],
    }
  )
  assertEquals(buildManagedDeleteQueuedResponse([{ commandId: 'd1', serverId: 's1' }], 'fb'), {
    ok: true,
    deleted: false,
    commandId: 'd1',
    serverId: 's1',
    results: [{ commandId: 'd1', serverId: 's1' }],
  })
  assertEquals(buildManagedDestroyQueuedResponse({ commandId: 'x', serverId: 's' }), {
    ok: true,
    destroyCommandId: 'x',
    commandId: 'x',
    serverId: 's',
    status: 'queued',
  })
  assertEquals(buildFencePromotePendingResponse({ commandId: 'f', serverId: 's' }), {
    ok: true,
    commandId: 'f',
    serverId: 's',
    status: 'queued',
    fenceCommandId: 'f',
    promotePending: true,
  })
  assertEquals(buildPromoteQueuedResponse({ commandId: 'p', serverId: 's' }), {
    ok: true,
    commandId: 'p',
    status: 'queued',
    serverId: 's',
  })
})

test('operatorPromoteHttpResult maps switchover enqueue to HTTP', () => {
  assertEquals(operatorPromoteHttpResult({ ok: false, error: 'conflict', status: 409 }), {
    status: 409,
    body: { error: 'conflict' },
  })
  assertEquals(
    operatorPromoteHttpResult({
      ok: true,
      commandId: 'f',
      serverId: 's',
      fencePending: true,
    }),
    {
      status: 200,
      body: buildFencePromotePendingResponse({ commandId: 'f', serverId: 's' }),
    }
  )
  assertEquals(
    operatorPromoteHttpResult({
      ok: true,
      commandId: 'p',
      serverId: 's',
      fencePending: false,
    }),
    {
      status: 200,
      body: buildPromoteQueuedResponse({ commandId: 'p', serverId: 's' }),
    }
  )
})

test('buildStatusMemberView and org list entry', () => {
  assertEquals(
    buildStatusMemberView({
      id: 'm1',
      serverId: 's1',
      role: 'replica',
      replicaClass: 'read',
      status: 'ready',
      replicationTransport: 'fabric',
      privatePort: 54000,
      replication: { state: 'streaming' },
    }),
    {
      id: 'm1',
      serverId: 's1',
      role: 'replica',
      replicaClass: 'read',
      status: 'ready',
      replicationTransport: 'fabric',
      privatePort: 54000,
      replication: { state: 'streaming' },
    }
  )
  assertEquals(
    buildStatusMemberView({
      id: 'm1-public',
      serverId: 's1',
      role: 'replica',
      status: 'ready',
      replicationTransport: 'public',
      privatePort: 54000,
    }).replicationTransport,
    'public'
  )
  assertEquals(
    buildStatusMemberView({
      id: 'm2',
      serverId: 's2',
      role: 'primary',
      status: null,
      replicationTransport: null,
      privatePort: null,
    }).replication,
    undefined
  )

  const entry = buildOrgManagedListEntry({
    serializedRow: { id: 'mg', engine: 'postgres' },
    engineDisplayName: 'PostgreSQL',
    environmentName: 'Production',
    projectId: 'p1',
    projectName: 'App',
    workspaceId: 'w1',
    workspaceName: 'Default',
    serverName: 'Host',
    members: [{ id: 'mem' }],
  })
  assertEquals(entry.id, 'mg')
  assertEquals(entry.engine, 'postgres')
  assertEquals(entry.engineDisplayName, 'PostgreSQL')
  assertEquals(entry.environmentName, 'Production')
  assertEquals(entry.projectId, 'p1')
  assertEquals(entry.projectName, 'App')
  assertEquals(entry.workspaceId, 'w1')
  assertEquals(entry.workspaceName, 'Default')
  assertEquals(entry.serverName, 'Host')
  assertEquals(entry.members, [{ id: 'mem' }])
})

test('managedStatusListenerParams skips unplaced, uncatalogued, and unreadable rows', () => {
  const settings = postgresEngineSpec.parseSettings(postgresEngineSpec.defaultSettings)
  if (!settings) {
    throw new TypeError('failed to parse default postgres settings')
  }
  const options = writeManagedSettings(settings)

  assertEquals(managedStatusListenerParams(null), null)
  assertEquals(
    managedStatusListenerParams({
      serverId: null,
      engine: 'postgres',
      options,
    }),
    null
  )
  assertEquals(
    managedStatusListenerParams({
      serverId: 's1',
      engine: 'nope',
      options,
    }),
    null
  )
  assertEquals(
    managedStatusListenerParams({
      serverId: 's1',
      engine: 'redis',
      options,
    }),
    null
  )
  assertEquals(
    managedStatusListenerParams({
      serverId: 's1',
      engine: 'postgres',
      options: { settings: { image: '' } },
    }),
    null
  )
  assertEquals(
    managedStatusListenerParams({
      serverId: 's1',
      engine: 'postgres',
      options,
    }),
    {
      serverId: 's1',
      engineCode: 'postgres',
      engineDefaultPort: postgresEngineSpec.defaultPort,
    }
  )
})

test('parseManagedConnectionRole defaults absent values to read-write', () => {
  assertEquals(parseManagedConnectionRole(undefined), 'read-write')
  assertEquals(parseManagedConnectionRole(null), 'read-write')
  assertEquals(parseManagedConnectionRole('read-write'), 'read-write')
  assertEquals(parseManagedConnectionRole('read-only'), 'read-only')
  assertEquals(parseManagedConnectionRole('write-only'), null)
  assertEquals(parseManagedConnectionRole(1), null)
})

test('parseDisasterRecoveryPromoteBody requires confirm and a member id', () => {
  assertEquals(parseDisasterRecoveryPromoteBody({}), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseDisasterRecoveryPromoteBody({ confirm: true }), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseDisasterRecoveryPromoteBody({ confirm: true, memberId: '' }), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseDisasterRecoveryPromoteBody({ confirm: false, memberId: 'mem-1' }), {
    ok: false,
    error: 'Invalid request',
    status: 400,
  })
  assertEquals(parseDisasterRecoveryPromoteBody({ confirm: true, memberId: 'mem-1' }), {
    ok: true,
    memberId: 'mem-1',
  })
})

test('buildDisasterRecoveryQueuedResponse names source and target', () => {
  assertEquals(
    buildDisasterRecoveryQueuedResponse({
      commandId: 'cmd-1',
      serverId: 'srv-target',
      fencePending: true,
      lagBytes: 12,
      sourceMemberId: 'mem-src',
      sourceServerId: 'srv-src',
      sourceDatacenterId: 'dc-src',
      targetMemberId: 'mem-tgt',
      targetServerId: 'srv-target',
      targetDatacenterId: null,
    }),
    {
      ok: true,
      commandId: 'cmd-1',
      status: 'queued',
      serverId: 'srv-target',
      fencePending: true,
      kind: 'disaster-recovery',
      lagBytes: 12,
      source: {
        memberId: 'mem-src',
        serverId: 'srv-src',
        datacenterId: 'dc-src',
      },
      target: {
        memberId: 'mem-tgt',
        serverId: 'srv-target',
        datacenterId: null,
      },
    }
  )
})

test('evaluateOperatorPromoteGate refuses a reading older than a few seconds', () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z')
  const reading = (observedAt: string) => ({
    state: 'streaming',
    lagBytes: 0,
    lagSeconds: 0,
    observedAt,
  })
  // A replica whose threads stopped 3 s ago still reads `streaming` in a
  // reading taken a minute ago: the stored 120 s window used to accept it.
  assertEquals(evaluatePromoteLagHttpGate(reading('2026-08-10T11:59:00.000Z'), false, now), null)
  assertEquals(
    evaluateOperatorPromoteGate(reading('2026-08-10T11:59:00.000Z'), false, now),
    'managed_replica_health_stale'
  )
  assertEquals(evaluateOperatorPromoteGate(reading('2026-08-10T11:59:50.000Z'), false, now), null)
})

test('evaluateOperatorPromoteGate refuses a replica that has not applied what it received', () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z')
  const base = { state: 'streaming', observedAt: '2026-08-10T11:59:55.000Z' }
  const mysql = 'mysql'
  assertEquals(
    evaluateOperatorPromoteGate({ ...base, fullyApplied: true }, false, now, mysql),
    null
  )
  assertEquals(
    evaluateOperatorPromoteGate({ ...base, fullyApplied: false }, false, now, mysql),
    'managed_replica_not_fully_applied'
  )
  assertEquals(
    evaluateOperatorPromoteGate({ ...base }, false, now, mysql),
    'managed_replica_not_fully_applied'
  )
  assertEquals(
    evaluateOperatorPromoteGate({ ...base, state: 'reconnecting' }, false, now, mysql),
    'managed_replica_not_streaming'
  )
  assertEquals(
    evaluateOperatorPromoteGate({ ...base, fullyApplied: false }, true, now, mysql),
    null
  )
})

test('evaluateOperatorPromoteGate postgres received vs replayed LSN', () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z')
  const base = {
    state: 'streaming',
    observedAt: '2026-08-10T11:59:55.000Z',
    lagBytes: 0,
    lagSeconds: 0,
  }
  const pg = 'postgres'
  assertEquals(
    evaluateOperatorPromoteGate(
      { ...base, receivedLsn: '0/3000148', replayLsn: '0/2FFC147' },
      false,
      now,
      pg
    ),
    'managed_replica_lagging'
  )
  assertEquals(
    evaluateOperatorPromoteGate(
      { ...base, receivedLsn: '0/3000100', replayLsn: '0/3000100' },
      false,
      now,
      pg
    ),
    null
  )
  assertEquals(evaluateOperatorPromoteGate({ ...base }, false, now, pg), 'managed_replica_lagging')
})
