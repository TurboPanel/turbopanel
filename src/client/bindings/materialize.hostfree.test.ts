/**
 * Host-free coverage for binding materialize helpers and error short-circuits.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import type { ResolvedVariableMap } from '../variables/resolve-inherited.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import {
  listBindingEmittedKeys,
  loadBindingOwnedKeysForService,
  materializeBinding,
  materializeBindingsForPrincipal,
  materializeBindingsForServices,
  reapplyBindingOwnedVariables,
  upsertBindingOwnedVariables,
} from './materialize.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function dataSecrets() {
  const config = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  return await deriveEncryptionSecretsConfig(config, 'data-encryption')
}

/**
 * Deep join chain used by materializeBinding (binding→…→organization).
 *
 * Self-referential on purpose: a fixed ladder of join stubs has to be recounted
 * every time the query gains a table (it grew an `organization` join to read the
 * org default SSL mode), and the failure mode is an unhelpful
 * "innerJoin is not a function" in ten unrelated tests.
 */
function materializeJoinDb(limitRows: unknown[]): Db {
  const chain: {
    innerJoin: () => typeof chain
    where: () => { limit: () => Promise<unknown[]> }
  } = {
    innerJoin: () => chain,
    where: () => ({ limit: () => Promise.resolve(limitRows) }),
  }
  return {
    select: () => ({
      from: () => chain,
    }),
  } as unknown as Db
}

/**
 * Queued select responses after the initial materialize join. Supports
 * `.limit()` / `.orderBy()` / thenable `.where()` chains used by CA + endpoint.
 */
function materializeFlowDb(
  joinRows: unknown[],
  followUps: unknown[][],
): Db {
  let n = 0
  return {
    select: () => {
      n += 1
      if (n === 1) {
        return materializeJoinDb(joinRows).select()
      }
      const rows = followUps[n - 2] ?? []
      const thenable = {
        limit: () => Promise.resolve(rows),
        orderBy: () => Promise.resolve(rows),
        then: (
          onFulfilled: (v: unknown) => unknown,
          onRejected?: (e: unknown) => unknown,
        ) => Promise.resolve(rows).then(onFulfilled, onRejected),
        catch: (onRejected: (e: unknown) => unknown) => Promise.resolve(rows).catch(onRejected),
        finally: (onFinally: () => void) => Promise.resolve(rows).finally(onFinally),
      }
      return {
        from: () => ({
          where: () => thenable,
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => thenable,
            }),
          }),
        }),
      }
    },
  } as unknown as Db
}

function selectThenInnerThenMaterialize(): Db {
  let n = 0
  return {
    select: () => {
      n += 1
      if (n === 1) {
        return {
          from: () => ({
            where: () => Promise.resolve([{ id: 'b1' }]),
          }),
        }
      }
      return materializeJoinDb([]).select()
    },
  } as unknown as Db
}

function baseBindingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    principalId: 'p1',
    serviceId: 's1',
    databaseName: 'app',
    keyPrefix: 'DATABASE',
    emitEngineDefaults: false,
    principalKind: 'database',
    principalUsername: 'u',
    principalPassword: 'tpsecret.placeholder',
    principalManagedId: 'm1',
    managedId: 'm1',
    managedEngine: 'postgres',
    managedOptions: {
      settings: postgresEngineSpec.defaultSettings,
      databases: ['app'],
    },
    organizationId: 'org',
    organizationOptions: {},
    ...overrides,
  }
}

test('materializeBindingsForServices short-circuits empty service list', async () => {
  assertEquals(
    await materializeBindingsForServices({} as Db, await dataSecrets(), []),
    { ok: true },
  )
})

test('listBindingEmittedKeys returns null for unsupported engines', () => {
  assertEquals(
    listBindingEmittedKeys({
      keyPrefix: 'DATABASE',
      emitEngineDefaults: true,
      engineCode: 'not-a-real-engine',
    }),
    null,
  )
})

test('materializeBinding returns binding_not_found when join misses', async () => {
  assertEquals(
    await materializeBinding(
      materializeJoinDb([]),
      await dataSecrets(),
      'missing',
    ),
    { kind: 'binding_not_found' },
  )
})

test('materializeBinding returns binding_principal_invalid for non-database principals', async () => {
  assertEquals(
    await materializeBinding(
      materializeJoinDb([
        baseBindingRow({
          principalKind: 'system',
          principalManagedId: 'm1',
        }),
      ]),
      await dataSecrets(),
      'b1',
    ),
    { kind: 'binding_principal_invalid' },
  )
})

test('materializeBinding returns binding_engine_unsupported for unknown engines', async () => {
  assertEquals(
    await materializeBinding(
      materializeJoinDb([
        baseBindingRow({ managedEngine: 'not-a-real-engine' }),
      ]),
      await dataSecrets(),
      'b1',
    ),
    { kind: 'binding_engine_unsupported' },
  )
})

test('materializeBinding returns binding_engine_unsupported when engine blank', async () => {
  assertEquals(
    await materializeBinding(
      materializeJoinDb([baseBindingRow({ managedEngine: null })]),
      await dataSecrets(),
      'b1',
    ),
    { kind: 'binding_engine_unsupported' },
  )
})

test('materializeBinding returns binding_cluster_invalid for bad options', async () => {
  assertEquals(
    await materializeBinding(
      materializeJoinDb([baseBindingRow({ managedOptions: 'nope' })]),
      await dataSecrets(),
      'b1',
    ),
    { kind: 'binding_cluster_invalid' },
  )
})

test('materializeBinding returns binding_password_unavailable when password blank', async () => {
  assertEquals(
    await materializeBinding(
      materializeJoinDb([baseBindingRow({ principalPassword: '' })]),
      await dataSecrets(),
      'b1',
    ),
    { kind: 'binding_password_unavailable' },
  )
})

test('materializeBinding returns binding_password_unavailable when decrypt fails', async () => {
  assertEquals(
    await materializeBinding(
      materializeJoinDb([
        baseBindingRow({ principalPassword: 'not-a-valid-enc-envelope' }),
      ]),
      await dataSecrets(),
      'b1',
    ),
    { kind: 'binding_password_unavailable' },
  )
})

test('materializeBinding returns binding_ca_unavailable when CA is unsealed', async () => {
  const secrets = await dataSecrets()
  const password = await encryptSecret(secrets, 's3cret')
  assertEquals(
    await materializeBinding(
      materializeFlowDb(
        [baseBindingRow({ principalPassword: password })],
        [
          [{
            certificatePem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
            privateKeyPem: 'plaintext-not-sealed',
            caState: 'active',
            caGeneration: 1,
          }],
        ],
      ),
      secrets,
      'b1',
    ),
    { kind: 'binding_ca_unavailable' },
  )
})

test('materializeBinding returns binding_endpoint_unavailable when cluster has no members', async () => {
  const secrets = await dataSecrets()
  const password = await encryptSecret(secrets, 's3cret')
  const sealedKey = await encryptSecret(secrets, 'ca-key')
  assertEquals(
    await materializeBinding(
      materializeFlowDb(
        [baseBindingRow({ principalPassword: password })],
        [
          [{
            certificatePem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
            privateKeyPem: sealedKey,
            caState: 'active',
            caGeneration: 1,
          }],
          [], // loadClusterMembers → empty
        ],
      ),
      secrets,
      'b1',
    ),
    { kind: 'binding_endpoint_unavailable' },
  )
})

test('materializeBindingsForServices / Principal propagate first error', async () => {
  const secrets = await dataSecrets()
  assertEquals(
    await materializeBindingsForServices(
      selectThenInnerThenMaterialize(),
      secrets,
      ['svc'],
    ),
    { kind: 'binding_not_found' },
  )

  assertEquals(
    await materializeBindingsForPrincipal(
      selectThenInnerThenMaterialize(),
      secrets,
      'principal',
    ),
    { kind: 'binding_not_found' },
  )
})

test('materializeBindingsForPrincipal returns ok when principal has no bindings', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await materializeBindingsForPrincipal(db, await dataSecrets(), 'p1'),
    { ok: true },
  )
})

test('upsertBindingOwnedVariables inserts updates and deletes stale keys', async () => {
  const secrets = await dataSecrets()
  const updates: Array<Record<string, unknown>> = []
  const inserts: Array<Record<string, unknown>> = []
  const deletes: unknown[] = []

  const tx = {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            { id: 'v-url', key: 'DATABASE_URL' },
            { id: 'v-stale', key: 'DATABASE_OLD' },
          ]),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          updates.push(patch)
          return Promise.resolve()
        },
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserts.push(row)
        return Promise.resolve()
      },
    }),
    delete: () => ({
      where: (cond: unknown) => {
        deletes.push(cond)
        return Promise.resolve()
      },
    }),
  }

  const db = {
    transaction: async (fn: (inner: typeof tx) => Promise<void>) => {
      await fn(tx)
    },
  } as unknown as Db

  await upsertBindingOwnedVariables(db, secrets, {
    bindingId: 'b1',
    serviceId: 'svc',
    desired: [
      { key: 'DATABASE_URL', value: 'postgres://x', isSecret: true },
      { key: 'DATABASE_HOST', value: 'db', isSecret: false },
    ],
  })

  assertEquals(updates.length, 1)
  assertEquals(typeof updates[0]?.value, 'string')
  assertEquals(
    String(updates[0]?.value).startsWith('tpsecret.'),
    true,
  )
  assertEquals(inserts.length, 1)
  assertEquals(inserts[0]?.key, 'DATABASE_HOST')
  assertEquals(inserts[0]?.value, 'db')
  assertEquals(deletes.length, 1)
})

test('reapplyBindingOwnedVariables and loadBindingOwnedKeysForService', async () => {
  const rows = [
    {
      key: 'DATABASE_URL',
      value: 'sealed',
      isSecret: true,
      isLiteral: true,
      forBuild: false,
      forRuntime: true,
    },
  ]
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as Db

  const map: ResolvedVariableMap = new Map([
    [
      'DATABASE_URL',
      {
        value: 'hosting-shadow',
        isSecret: false,
        isLiteral: false,
        forBuild: false,
        forRuntime: true,
      },
    ],
  ])
  await reapplyBindingOwnedVariables(db, 'svc', map)
  assertEquals(map.get('DATABASE_URL')?.value, 'sealed')
  assertEquals(map.get('DATABASE_URL')?.isSecret, true)

  const keys = await loadBindingOwnedKeysForService(db, 'svc')
  assertEquals(keys.has('DATABASE_URL'), true)
})
