/**
 * Host-free coverage for binding collision helpers, serializers, and wire maps.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import {
  assertNoBindingKeyConflicts,
  BINDING_ENGINE_DEFAULTS_IN_USE_ERROR,
  BINDING_ENDPOINT_UNAVAILABLE_ERROR,
  BINDING_KEY_CONFLICT_ERROR,
  BINDING_KEY_PREFIX_IN_USE_ERROR,
  bindingDatabaseTargetHttpStatus,
  bindingMaterializeHttpPayload,
  checkBindingDatabaseTarget,
  detectBindingCreateConflicts,
  detectBindingUpdateConflicts,
  findBindingKeyConflicts,
  isBindableDatabasePrincipal,
  isEngineDefaultsInUse,
  isKeyOwnedByBindingOnService,
  isPostgresUniqueViolation,
  isPrefixInUse,
  mapBindingUniqueViolation,
  parseBindingKeyPrefix,
  parseBindingsListFilter,
  parseEmitEngineDefaults,
  resolveBindingPrincipalEngine,
  resolveBindingPrincipalManagedId,
  resolvePatchBindingFields,
  resolveServiceIdForHosting,
  serializeBindingRow,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    orderBy: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function selectQueueDb(responses: unknown[][]): Db {
  let i = 0
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = responses[i] ?? []
          i += 1
          return thenableRows(rows)
        },
        innerJoin: () => ({
          where: () => {
            const rows = responses[i] ?? []
            i += 1
            return thenableRows(rows)
          },
        }),
      }),
    }),
  } as unknown as Db
}

test('parseBindingKeyPrefix rejects reserved and non-string values', () => {
  assertEquals(parseBindingKeyPrefix(12).ok, false)
  assertEquals(parseBindingKeyPrefix('TURBOPANEL').ok, false)
  assertEquals(parseBindingKeyPrefix(null), {
    ok: true,
    prefix: 'DATABASE',
  })
  assertEquals(parseBindingKeyPrefix('APP_DB'), { ok: true, prefix: 'APP_DB' })
})

test('parseEmitEngineDefaults validates booleans only', () => {
  assertEquals(parseEmitEngineDefaults(undefined), { ok: true, value: true })
  assertEquals(parseEmitEngineDefaults(null), { ok: true, value: true })
  assertEquals(parseEmitEngineDefaults(false), { ok: true, value: false })
  assertEquals(parseEmitEngineDefaults('no').ok, false)
})

test('isPostgresUniqueViolation detects Postgres 23505', () => {
  assertEquals(isPostgresUniqueViolation({ code: '23505' }), true)
  assertEquals(isPostgresUniqueViolation({ code: '23503' }), false)
  assertEquals(isPostgresUniqueViolation(null), false)
  assertEquals(isPostgresUniqueViolation('23505'), false)
})

test('bindingMaterializeHttpPayload maps endpoint failures to 422', () => {
  assertEquals(
    bindingMaterializeHttpPayload({ kind: 'binding_endpoint_unavailable' }),
    { status: 422, body: { error: BINDING_ENDPOINT_UNAVAILABLE_ERROR } },
  )
  assertEquals(
    bindingMaterializeHttpPayload({ kind: 'datacenter_ip_required' }),
    { status: 422, body: { error: BINDING_ENDPOINT_UNAVAILABLE_ERROR } },
  )
  assertEquals(
    bindingMaterializeHttpPayload({ kind: 'private_path_unavailable' }),
    { status: 422, body: { error: BINDING_ENDPOINT_UNAVAILABLE_ERROR } },
  )
  assertEquals(
    bindingMaterializeHttpPayload({ kind: 'binding_password_unavailable' }),
    { status: 400, body: { error: 'binding_password_unavailable' } },
  )
})

test('checkBindingDatabaseTarget validates engine + database', () => {
  assertEquals(
    checkBindingDatabaseTarget({ engine: 'not-real', options: {} }, 'app'),
    'binding_engine_unsupported',
  )
  assertEquals(
    checkBindingDatabaseTarget(
      { engine: 'postgres', options: 'bad' },
      'app',
    ),
    'Invalid managed options',
  )
  assertEquals(
    checkBindingDatabaseTarget(
      {
        engine: 'postgres',
        options: {
          settings: postgresEngineSpec.defaultSettings,
          databases: ['app'],
        },
      },
      'missing',
    ),
    'database_not_found',
  )
  assertEquals(
    checkBindingDatabaseTarget(
      {
        engine: 'postgres',
        options: {
          settings: postgresEngineSpec.defaultSettings,
          databases: ['app'],
        },
      },
      'app',
    ),
    null,
  )
})

test('resolvePatchBindingFields applies and validates overrides', () => {
  const base = { keyPrefix: 'DATABASE', emitEngineDefaults: true }
  assertEquals(resolvePatchBindingFields({}, base), {
    ok: true,
    keyPrefix: 'DATABASE',
    emitEngineDefaults: true,
  })
  assertEquals(
    resolvePatchBindingFields({ keyPrefix: 'APP', emitEngineDefaults: false }, base),
    { ok: true, keyPrefix: 'APP', emitEngineDefaults: false },
  )
  assertEquals(
    resolvePatchBindingFields({ keyPrefix: 'TURBOPANEL' }, base).ok,
    false,
  )
  assertEquals(
    resolvePatchBindingFields({ emitEngineDefaults: 'yes' }, base).ok,
    false,
  )
})

test('findBindingKeyConflicts returns null for empty key sets', async () => {
  assertEquals(
    await findBindingKeyConflicts(selectQueueDb([]), {
      serviceId: 'svc',
      keys: [],
    }),
    null,
  )
})

test('findBindingKeyConflicts reports service-scoped user variable first', async () => {
  const conflict = await findBindingKeyConflicts(
    selectQueueDb([[{ key: 'DATABASE_URL' }]]),
    { serviceId: 'svc', keys: ['DATABASE_URL'] },
  )
  assertEquals(conflict, 'DATABASE_URL')
})

test('findBindingKeyConflicts excludeBindingId still finds foreign rows', async () => {
  const conflict = await findBindingKeyConflicts(
    selectQueueDb([[{ key: 'DATABASE_URL' }]]),
    {
      serviceId: 'svc',
      keys: ['DATABASE_URL'],
      excludeBindingId: 'binding-other',
    },
  )
  assertEquals(conflict, 'DATABASE_URL')
})

test('findBindingKeyConflicts checks hosting-scoped keys when service is clean', async () => {
  const conflict = await findBindingKeyConflicts(
    selectQueueDb([
      [], // service miss
      [{ id: 'h1' }, { id: 'h2' }], // hostings
      [{ key: 'DATABASE_PASSWORD' }], // hosting hit
    ]),
    { serviceId: 'svc', keys: ['DATABASE_PASSWORD'] },
  )
  assertEquals(conflict, 'DATABASE_PASSWORD')
})

test('findBindingKeyConflicts returns null when hostings absent', async () => {
  assertEquals(
    await findBindingKeyConflicts(
      selectQueueDb([[], []]),
      { serviceId: 'svc', keys: ['DATABASE_URL'] },
    ),
    null,
  )
})

test('assertNoBindingKeyConflicts maps emitted key collisions', async () => {
  const ok = await assertNoBindingKeyConflicts(selectQueueDb([[]]), {
    serviceId: 'svc',
    keyPrefix: 'DATABASE',
    emitEngineDefaults: false,
    engineCode: 'postgres',
  })
  assertEquals(ok, { ok: true })

  const bad = await assertNoBindingKeyConflicts(
    selectQueueDb([[{ key: 'DATABASE_URL' }]]),
    {
      serviceId: 'svc',
      keyPrefix: 'DATABASE',
      emitEngineDefaults: false,
      engineCode: 'postgres',
      excludeBindingId: 'b1',
    },
  )
  assertEquals(bad, { ok: false, key: 'DATABASE_URL' })
  assertEquals(BINDING_KEY_CONFLICT_ERROR, 'binding_key_conflict')
})

test('assertNoBindingKeyConflicts short-circuits unknown engines', async () => {
  assertEquals(
    await assertNoBindingKeyConflicts(selectQueueDb([]), {
      serviceId: 'svc',
      keyPrefix: 'DATABASE',
      emitEngineDefaults: true,
      engineCode: 'not-a-real-engine',
    }),
    { ok: true },
  )
})

test('detectBindingCreateConflicts covers prefix / defaults / keys', async () => {
  assertEquals(
    await detectBindingCreateConflicts(
      selectQueueDb([[{ id: 'b1' }]]),
      {
        serviceId: 'svc',
        keyPrefix: 'DB',
        emitEngineDefaults: false,
        engineCode: 'postgres',
      },
    ),
    { error: BINDING_KEY_PREFIX_IN_USE_ERROR },
  )

  assertEquals(
    await detectBindingCreateConflicts(
      selectQueueDb([
        [], // prefix free
        [{ id: 'b1' }], // defaults in use
      ]),
      {
        serviceId: 'svc',
        keyPrefix: 'DB',
        emitEngineDefaults: true,
        engineCode: 'postgres',
      },
    ),
    { error: BINDING_ENGINE_DEFAULTS_IN_USE_ERROR },
  )

  assertEquals(
    await detectBindingCreateConflicts(
      selectQueueDb([
        [], // prefix free
        [{ key: 'DATABASE_URL' }], // key conflict (emit=false skips defaults)
      ]),
      {
        serviceId: 'svc',
        keyPrefix: 'DATABASE',
        emitEngineDefaults: false,
        engineCode: 'postgres',
      },
    ),
    { error: BINDING_KEY_CONFLICT_ERROR, key: 'DATABASE_URL' },
  )

  assertEquals(
    await detectBindingCreateConflicts(
      selectQueueDb([
        [], // prefix
        [], // service keys clean
        [], // no hostings
      ]),
      {
        serviceId: 'svc',
        keyPrefix: 'DATABASE',
        emitEngineDefaults: false,
        engineCode: 'postgres',
      },
    ),
    null,
  )
})

test('detectBindingUpdateConflicts only checks changed fields', async () => {
  assertEquals(
    await detectBindingUpdateConflicts(
      selectQueueDb([[{ id: 'other' }]]),
      {
        id: 'b1',
        serviceId: 'svc',
        previousKeyPrefix: 'DATABASE',
        previousEmitEngineDefaults: false,
        nextKeyPrefix: 'APP',
        nextEmitEngineDefaults: false,
        engineCode: 'postgres',
      },
    ),
    { error: BINDING_KEY_PREFIX_IN_USE_ERROR },
  )

  assertEquals(
    await detectBindingUpdateConflicts(
      selectQueueDb([[{ id: 'other' }]]),
      {
        id: 'b1',
        serviceId: 'svc',
        previousKeyPrefix: 'DATABASE',
        previousEmitEngineDefaults: false,
        nextKeyPrefix: 'DATABASE',
        nextEmitEngineDefaults: true,
        engineCode: 'postgres',
      },
    ),
    { error: BINDING_ENGINE_DEFAULTS_IN_USE_ERROR },
  )

  assertEquals(
    await detectBindingUpdateConflicts(
      selectQueueDb([[]]),
      {
        id: 'b1',
        serviceId: 'svc',
        previousKeyPrefix: 'DATABASE',
        previousEmitEngineDefaults: true,
        nextKeyPrefix: 'DATABASE',
        nextEmitEngineDefaults: true,
        engineCode: 'postgres',
      },
    ),
    null,
  )
})

test('isPrefixInUse / isEngineDefaultsInUse / isKeyOwnedByBindingOnService', async () => {
  assertEquals(
    await isPrefixInUse(selectQueueDb([[{ id: 'b1' }]]), 'svc', 'DB'),
    true,
  )
  assertEquals(
    await isPrefixInUse(selectQueueDb([[]]), 'svc', 'DB', 'exclude'),
    false,
  )
  assertEquals(
    await isEngineDefaultsInUse(selectQueueDb([[{ id: 'b1' }]]), 'svc'),
    true,
  )
  assertEquals(
    await isEngineDefaultsInUse(selectQueueDb([[]]), 'svc', 'exclude'),
    false,
  )
  assertEquals(
    await isKeyOwnedByBindingOnService(
      selectQueueDb([[{ id: 'v1' }]]),
      'svc',
      'DATABASE_URL',
    ),
    true,
  )
  assertEquals(
    await isKeyOwnedByBindingOnService(selectQueueDb([[]]), 'svc', 'X'),
    false,
  )
})

test('resolveBindingPrincipalManagedId / Engine', async () => {
  assertEquals(
    await resolveBindingPrincipalManagedId(selectQueueDb([[]]), 'p1'),
    null,
  )
  assertEquals(
    await resolveBindingPrincipalManagedId(
      selectQueueDb([[{ managedId: 'm1' }]]),
      'p1',
    ),
    'm1',
  )
  assertEquals(
    await resolveBindingPrincipalEngine(selectQueueDb([[]]), 'p1'),
    { managedId: null, engineCode: 'postgres' },
  )
  assertEquals(
    await resolveBindingPrincipalEngine(
      selectQueueDb([[{ managedId: 'm1' }], [{ engine: 'mysql' }]]),
      'p1',
    ),
    { managedId: 'm1', engineCode: 'mysql' },
  )
  assertEquals(
    await resolveBindingPrincipalEngine(
      selectQueueDb([[{ managedId: 'm1' }], [{}]]),
      'p1',
    ),
    { managedId: 'm1', engineCode: 'postgres' },
  )
})

test('resolveServiceIdForHosting returns null when missing', async () => {
  assertEquals(
    await resolveServiceIdForHosting(selectQueueDb([[]]), 'hosting'),
    null,
  )
  assertEquals(
    await resolveServiceIdForHosting(
      selectQueueDb([[{ serviceId: 'svc-1' }]]),
      'hosting',
    ),
    'svc-1',
  )
})

test('serializeBindingRow fills keys without endpoint when cluster empty', async () => {
  const row = {
    id: 'b1',
    principalId: 'p1',
    serviceId: 'svc',
    databaseName: 'app',
    keyPrefix: 'DATABASE',
    emitEngineDefaults: false,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  }

  const bare = await serializeBindingRow(selectQueueDb([[]]), row)
  assertEquals(bare.managedId, null)
  assertEquals(bare.keys, [])
  assertEquals(bare.endpoint, null)

  const withManaged = await serializeBindingRow(
    selectQueueDb([
      [{ managedId: 'm1', username: 'u' }],
      [{
        id: 'm1',
        engine: 'postgres',
        options: {
          settings: postgresEngineSpec.defaultSettings,
          databases: ['app'],
        },
        environmentId: 'env-m',
      }],
      [], // resolveBindingEndpoint members → unavailable
    ]),
    row,
  )
  assertEquals(withManaged.engine, 'postgres')
  assertEquals(withManaged.managedEnvironmentId, 'env-m')
  assertEquals(withManaged.keys.includes('DATABASE_URL'), true)
  assertEquals(withManaged.endpoint, null)
  assertEquals(withManaged.readSplit, null)
})

test('parseBindingsListFilter requires exactly one filter', () => {
  assertEquals(
    parseBindingsListFilter({
      serviceId: undefined,
      environmentId: undefined,
      managedEnvironmentId: undefined,
    }).ok,
    false,
  )
  assertEquals(
    parseBindingsListFilter({
      serviceId: 's1',
      environmentId: 'e1',
      managedEnvironmentId: undefined,
    }).ok,
    false,
  )
  assertEquals(
    parseBindingsListFilter({
      serviceId: 's1',
      environmentId: undefined,
      managedEnvironmentId: undefined,
    }),
    { ok: true, filter: { kind: 'service', serviceId: 's1' } },
  )
  assertEquals(
    parseBindingsListFilter({
      serviceId: undefined,
      environmentId: undefined,
      managedEnvironmentId: 'me1',
    }),
    {
      ok: true,
      filter: { kind: 'managedEnvironment', managedEnvironmentId: 'me1' },
    },
  )
  assertEquals(
    parseBindingsListFilter({
      serviceId: undefined,
      environmentId: 'e1',
      managedEnvironmentId: undefined,
    }),
    { ok: true, filter: { kind: 'environment', environmentId: 'e1' } },
  )
})

test('bindingDatabaseTargetHttpStatus and unique-violation mapping', () => {
  assertEquals(bindingDatabaseTargetHttpStatus('database_not_found'), 404)
  assertEquals(bindingDatabaseTargetHttpStatus('Invalid database name'), 400)
  assertEquals(
    mapBindingUniqueViolation(
      Object.assign(new Error('uniq_binding_service_engine_defaults'), {
        code: '23505',
      }),
    ),
    { error: BINDING_ENGINE_DEFAULTS_IN_USE_ERROR, status: 409 },
  )
  assertEquals(
    mapBindingUniqueViolation(
      Object.assign(new Error('uniq_binding_service_prefix'), { code: '23505' }),
    ),
    { error: BINDING_KEY_PREFIX_IN_USE_ERROR, status: 409 },
  )
  assertEquals(
    mapBindingUniqueViolation(Object.assign(new Error('other'), { code: '23505' })),
    null,
  )
})

test('isBindableDatabasePrincipal rejects root and replication metadata', () => {
  assertEquals(
    isBindableDatabasePrincipal({
      kind: 'database',
      managedId: 'm1',
      metadata: {},
    }),
    true,
  )
  assertEquals(
    isBindableDatabasePrincipal({
      kind: 'database',
      managedId: 'm1',
      metadata: { managedRoot: true },
    }),
    false,
  )
  assertEquals(
    isBindableDatabasePrincipal({
      kind: 'database',
      managedId: 'm1',
      metadata: { managedReplication: true },
    }),
    false,
  )
  assertEquals(
    isBindableDatabasePrincipal({
      kind: 'system',
      managedId: 'm1',
      metadata: {},
    }),
    false,
  )
})
