/**
 * Host-free coverage for managed route pure helpers extracted from routes.ts.
 */

import { assertEquals } from '@std/assert'
import { BadRequestError } from '../shared.ts'
import {
  buildEmptyManagedDetailResponse,
  buildFencePromotePendingResponse,
  buildManagedDeleteHardResponse,
  buildManagedDeleteQueuedResponse,
  buildManagedDestroyQueuedResponse,
  buildOrgManagedListEntry,
  buildPromoteQueuedResponse,
  buildQueuedFanoutResponse,
  buildStatusMemberView,
  canHardDeleteManaged,
  evaluateManagedDatabaseDelete,
  evaluateManagedUserDropGuard,
  evaluateManagedUserRotateGuard,
  evaluatePromoteLagHttpGate,
  evaluatePromoteMemberRole,
  evaluateReplicaPlacementPrechecks,
  replicaEndpointPurpose,
  replicaPlacementNeedsDatacenter,
  assertFailoverReplicaTransportAllowed,
  evaluatePromoteReplicaClass,
  evaluateReplicaClassConversion,
  findManagedBackupById,
  mergeManagedPatchSettings,
  nextDatabasesAfterCreate,
  nextDatabasesAfterDelete,
  parseManagedCreateDisplayName,
  parseManagedLifecycleAction,
  parseMemberReadEligibleCreate,
  parseMemberReadEligiblePatch,
  parseMemberPatch,
  parsePromoteForce,
  parseReplicaClassCreate,
  pickPrimaryCommandResult,
  sortManagedBackupsDesc,
  validateManagedDatabaseCreateName,
} from './routes-helpers.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'

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

test('parseManagedCreateDisplayName accepts null/string and maps BadRequestError', () => {
  const omitted = parseManagedCreateDisplayName({})
  if (!omitted.ok) throw new TypeError('expected ok')
  assertEquals(omitted.displayName, null)

  const named = parseManagedCreateDisplayName({ name: 'Orders DB' })
  if (!named.ok) throw new TypeError('expected ok')
  assertEquals(named.displayName, 'Orders DB')

  const invalid = parseManagedCreateDisplayName({ name: '   ' })
  if (invalid.ok) throw new TypeError('expected invalid blank name')
  assertEquals(invalid, { ok: false, error: 'Invalid request', status: 400 })

  const wrongType = parseManagedCreateDisplayName({ name: 42 })
  if (wrongType.ok) throw new TypeError('expected non-string rejection')
  assertEquals(wrongType.status, 400)
})

test('parseManagedCreateDisplayName rethrows unexpected errors', () => {
  let threw = false
  try {
    parseManagedCreateDisplayName(
      new Proxy({} as Record<string, unknown>, {
        get(_target, prop) {
          if (prop === 'name') throw new TypeError('unexpected')
          return undefined
        },
        has(_target, prop) {
          return prop === 'name'
        },
      }),
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
    settings: { exposure: { enabled: true, bind: 'public' } },
  })
  if (!merged) throw new TypeError('expected merged')
  assertEquals(merged.exposure.enabled, true)
  assertEquals(merged.exposure.bind, 'public')

  const ignored = mergeManagedPatchSettings(postgresEngineSpec, base, {
    settings: 'nope',
  })
  if (!ignored) throw new TypeError('expected base when settings non-object')
  assertEquals(ignored.exposure.enabled, base.exposure.enabled)

  const invalid = mergeManagedPatchSettings(postgresEngineSpec, base, {
    settings: { image: '' },
  })
  assertEquals(invalid, null)
})

test('validateManagedDatabaseCreateName rejects bad names and duplicates', () => {
  const id = postgresEngineSpec.userOperations.identifier
  assertEquals(
    validateManagedDatabaseCreateName('good_db', ['postgres'], id),
    null,
  )
  assertEquals(
    validateManagedDatabaseCreateName('bad name', ['postgres'], id)?.error,
    'Invalid database name',
  )
  assertEquals(
    validateManagedDatabaseCreateName('postgres', ['postgres'], id),
    { ok: false, error: 'database_exists', status: 409 },
  )
})

test('evaluateManagedDatabaseDelete guards initial and missing names', () => {
  assertEquals(
    evaluateManagedDatabaseDelete('missing', ['postgres', 'app'], 'postgres'),
    { ok: false, error: 'Not found', status: 404 },
  )
  assertEquals(
    evaluateManagedDatabaseDelete('postgres', ['postgres', 'app'], 'postgres'),
    { ok: false, error: 'cannot_drop_initial_database', status: 409 },
  )
  assertEquals(
    evaluateManagedDatabaseDelete('app', ['postgres', 'app'], 'postgres'),
    null,
  )
})

test('nextDatabasesAfterCreate/Delete sort and filter', () => {
  assertEquals(nextDatabasesAfterCreate(['zeta', 'alpha'], 'mid'), [
    'alpha',
    'mid',
    'zeta',
  ])
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
  assertEquals(parseReplicaClassCreate({}), { ok: true, replicaClass: 'failover' })
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

test('canHardDeleteManaged covers terminal and unplaced states', () => {
  assertEquals(canHardDeleteManaged('stopped', 's1'), true)
  assertEquals(canHardDeleteManaged('failed', 's1'), true)
  assertEquals(canHardDeleteManaged('provisioning', 's1'), true)
  assertEquals(canHardDeleteManaged('ready', null), true)
  assertEquals(canHardDeleteManaged('ready', 's1'), false)
  assertEquals(canHardDeleteManaged('applying', 's1'), false)
})

test('evaluateReplicaPlacementPrechecks blocks duplicate members only', () => {
  assertEquals(
    evaluateReplicaPlacementPrechecks(
      [{ serverId: 's1', role: 'primary' }],
      's1',
    ),
    { ok: false, error: 'managed_member_exists', status: 409 },
  )
  assertEquals(
    evaluateReplicaPlacementPrechecks(
      [{ serverId: 's1', role: 'primary' }],
      's2',
    ),
    null,
  )
})

test('replicaPlacementNeedsDatacenter is class-aware', () => {
  assertEquals(replicaPlacementNeedsDatacenter('fabric', 'read'), false)
  assertEquals(replicaPlacementNeedsDatacenter('public', 'read'), false)
  assertEquals(replicaPlacementNeedsDatacenter('datacenter', 'read'), true)
  assertEquals(replicaPlacementNeedsDatacenter('local', 'read'), true)
  assertEquals(replicaPlacementNeedsDatacenter('fabric', 'failover'), true)
  assertEquals(replicaPlacementNeedsDatacenter('public', 'failover'), true)
  assertEquals(replicaPlacementNeedsDatacenter('datacenter', 'failover'), true)
  assertEquals(replicaPlacementNeedsDatacenter('local', 'failover'), true)
})

test('assertFailoverReplicaTransportAllowed rejects fabric and public', () => {
  assertEquals(assertFailoverReplicaTransportAllowed('local'), null)
  assertEquals(assertFailoverReplicaTransportAllowed('datacenter'), null)
  assertEquals(assertFailoverReplicaTransportAllowed('fabric'), {
    kind: 'failover_replica_requires_datacenter_transport',
  })
  assertEquals(assertFailoverReplicaTransportAllowed('public'), {
    kind: 'failover_replica_requires_datacenter_transport',
  })
})

test('evaluateReplicaClassConversion allows failover to read and gates the reverse', () => {
  const replica = { role: 'replica', replicaClass: 'failover' as const }
  assertEquals(evaluateReplicaClassConversion(replica, 'read', false), null)
  assertEquals(
    evaluateReplicaClassConversion(
      { role: 'replica', replicaClass: 'read' },
      'failover',
      false,
    ),
    {
      ok: false,
      error: 'failover_replica_requires_datacenter_transport',
      status: 422,
    },
  )
  assertEquals(
    evaluateReplicaClassConversion(
      { role: 'replica', replicaClass: 'read' },
      'failover',
      true,
    ),
    null,
  )
  assertEquals(
    evaluateReplicaClassConversion({ role: 'primary', replicaClass: null }, 'read', true),
    { ok: false, error: 'Invalid request', status: 400 },
  )
})

test('replica add/promote/conversion route helpers encode class rules', () => {
  assertEquals(replicaEndpointPurpose('failover'), 'failover-replication')
  assertEquals(replicaEndpointPurpose('read'), 'read-replication')
  assertEquals(evaluatePromoteReplicaClass('failover', false), null)
  assertEquals(evaluatePromoteReplicaClass('read', false), {
    ok: false,
    error: 'managed_replica_not_promotable',
    status: 422,
  })
  assertEquals(evaluatePromoteReplicaClass('read', true), null)
  assertEquals(evaluatePromoteReplicaClass(null, false), {
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
  assertEquals(evaluateManagedUserRotateGuard({ managedRoot: true }), {
    ok: false,
    error: 'use_root_password_route',
    status: 400,
  })
  assertEquals(
    evaluateManagedUserRotateGuard({ managedReplication: true }),
    { ok: false, error: 'cannot_rotate_replication_user', status: 400 },
  )
  assertEquals(evaluateManagedUserRotateGuard({}), null)

  assertEquals(evaluateManagedUserDropGuard({ managedRoot: true }), {
    ok: false,
    error: 'cannot_drop_root_user',
    status: 400,
  })
  assertEquals(evaluateManagedUserDropGuard({}), null)
})

test('evaluatePromoteLagHttpGate honors force bypass', () => {
  assertEquals(
    evaluatePromoteLagHttpGate(undefined, true),
    null,
  )
  assertEquals(
    evaluatePromoteLagHttpGate(undefined, false),
    'managed_replica_not_streaming',
  )
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
      now,
    ),
    null,
  )
})

test('pickPrimaryCommandResult and queued response builders', () => {
  assertEquals(pickPrimaryCommandResult([]), undefined)
  assertEquals(
    pickPrimaryCommandResult([{ serverId: 'a' }, { commandId: 'c1', serverId: 'b' }]),
    { commandId: 'c1', serverId: 'b' },
  )
  assertEquals(
    pickPrimaryCommandResult([{ serverId: 'only' }]),
    { serverId: 'only' },
  )

  assertEquals(
    buildQueuedFanoutResponse(
      [{ commandId: 'cmd', serverId: 'srv' }],
      'fallback',
    ),
    {
      ok: true,
      results: [{ commandId: 'cmd', serverId: 'srv' }],
      commandId: 'cmd',
      serverId: 'srv',
      status: 'queued',
    },
  )
  assertEquals(
    buildQueuedFanoutResponse([{ serverId: undefined }], 'fallback'),
    {
      ok: true,
      results: [{ serverId: undefined }],
      commandId: undefined,
      serverId: 'fallback',
      status: 'queued',
    },
  )
})

test('empty detail / delete / destroy / promote response shapes', () => {
  assertEquals(buildEmptyManagedDetailResponse('postgres'), {
    managed: null,
    connection: null,
    settings: null,
    server: null,
    rootUsername: 'postgres',
    members: [],
  })
  assertEquals(buildManagedDeleteHardResponse(), { ok: true, deleted: true })
  assertEquals(
    buildManagedDeleteQueuedResponse(
      [{ commandId: 'd1', serverId: 's1' }],
      'fb',
    ),
    {
      ok: true,
      deleted: false,
      commandId: 'd1',
      serverId: 's1',
      results: [{ commandId: 'd1', serverId: 's1' }],
    },
  )
  assertEquals(
    buildManagedDestroyQueuedResponse({ commandId: 'x', serverId: 's' }),
    {
      ok: true,
      destroyCommandId: 'x',
      commandId: 'x',
      serverId: 's',
      status: 'queued',
    },
  )
  assertEquals(
    buildFencePromotePendingResponse({ commandId: 'f', serverId: 's' }),
    {
      ok: true,
      commandId: 'f',
      serverId: 's',
      status: 'queued',
      fenceCommandId: 'f',
      promotePending: true,
    },
  )
  assertEquals(
    buildPromoteQueuedResponse({ commandId: 'p', serverId: 's' }),
    { ok: true, commandId: 'p', status: 'queued', serverId: 's' },
  )
})

test('backup helpers sort and find by id', () => {
  const backups = [
    { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', createdAt: '2026-02-01T00:00:00.000Z' },
  ]
  assertEquals(sortManagedBackupsDesc(backups).map((b) => b.id), ['b', 'a'])
  assertEquals(findManagedBackupById(backups, 'a')?.id, 'a')
  assertEquals(findManagedBackupById(backups, 'missing'), undefined)
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
    },
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
    'public',
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
    undefined,
  )

  const entry = buildOrgManagedListEntry({
    serializedRow: { id: 'mg', engine: 'postgres' },
    engineDisplayName: 'PostgreSQL',
    environmentDisplayName: 'Production',
    projectId: 'p1',
    projectDisplayName: 'App',
    workspaceId: 'w1',
    workspaceDisplayName: 'Default',
    serverDisplayName: 'Host',
    members: [{ id: 'mem' }],
  })
  assertEquals(entry.id, 'mg')
  assertEquals(entry.engine, 'postgres')
  assertEquals(entry.engineDisplayName, 'PostgreSQL')
  assertEquals(entry.environmentDisplayName, 'Production')
  assertEquals(entry.projectId, 'p1')
  assertEquals(entry.projectDisplayName, 'App')
  assertEquals(entry.workspaceId, 'w1')
  assertEquals(entry.workspaceDisplayName, 'Default')
  assertEquals(entry.serverDisplayName, 'Host')
  assertEquals(entry.members, [{ id: 'mem' }])
})
