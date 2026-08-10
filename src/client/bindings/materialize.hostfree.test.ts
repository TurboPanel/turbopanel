/**
 * Host-free coverage for binding materialize helpers and error short-circuits.
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import type { ResolvedVariableMap } from '../variables/resolve-inherited.ts'
import {
  loadBindingOwnedKeysForService,
  materializeBinding,
  materializeBindingsForPrincipal,
  materializeBindingsForServices,
  reapplyBindingOwnedVariables,
} from './materialize.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const secrets = {} as DerivedSecretsConfig

/** Deep join chain used by materializeBinding (binding→…→workspace). */
function materializeJoinDb(limitRows: unknown[]): Db {
  const leaf = {
    where: () => ({
      limit: () => Promise.resolve(limitRows),
    }),
  }
  const j5 = { innerJoin: () => leaf }
  const j4 = { innerJoin: () => j5 }
  const j3 = { innerJoin: () => j4 }
  const j2 = { innerJoin: () => j3 }
  const j1 = { innerJoin: () => j2 }
  const j0 = { innerJoin: () => j1 }
  return {
    select: () => ({
      from: () => j0,
    }),
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

test('materializeBindingsForServices short-circuits empty service list', async () => {
  assertEquals(
    await materializeBindingsForServices({} as Db, secrets, []),
    { ok: true },
  )
})

test('materializeBinding returns binding_not_found when join misses', async () => {
  assertEquals(
    await materializeBinding(materializeJoinDb([]), secrets, 'missing'),
    { kind: 'binding_not_found' },
  )
})

test('materializeBinding returns binding_principal_invalid for non-database principals', async () => {
  assertEquals(
    await materializeBinding(
      materializeJoinDb([
        {
          id: 'b1',
          principalId: 'p1',
          serviceId: 's1',
          databaseName: 'app',
          keyPrefix: 'DATABASE',
          emitEngineDefaults: true,
          principalKind: 'system',
          principalUsername: 'u',
          principalPassword: 'enc',
          principalManagedId: 'm1',
          managedId: 'm1',
          managedEngine: 'postgres',
          managedOptions: {},
          organizationId: 'org',
        },
      ]),
      secrets,
      'b1',
    ),
    { kind: 'binding_principal_invalid' },
  )
})

test('materializeBinding returns binding_engine_unsupported for unknown engines', async () => {
  assertEquals(
    await materializeBinding(
      materializeJoinDb([
        {
          id: 'b1',
          principalId: 'p1',
          serviceId: 's1',
          databaseName: 'app',
          keyPrefix: 'DATABASE',
          emitEngineDefaults: true,
          principalKind: 'database',
          principalUsername: 'u',
          principalPassword: 'enc',
          principalManagedId: 'm1',
          managedId: 'm1',
          managedEngine: 'not-a-real-engine',
          managedOptions: {},
          organizationId: 'org',
        },
      ]),
      secrets,
      'b1',
    ),
    { kind: 'binding_engine_unsupported' },
  )
})

test('materializeBinding returns binding_password_unavailable when password blank', async () => {
  const { postgresEngineSpec } = await import('../../lib/managed/postgres.ts')
  assertEquals(
    await materializeBinding(
      materializeJoinDb([
        {
          id: 'b1',
          principalId: 'p1',
          serviceId: 's1',
          databaseName: 'app',
          keyPrefix: 'DATABASE',
          emitEngineDefaults: false,
          principalKind: 'database',
          principalUsername: 'u',
          principalPassword: '',
          principalManagedId: 'm1',
          managedId: 'm1',
          managedEngine: 'postgres',
          managedOptions: {
            settings: postgresEngineSpec.defaultSettings,
            databases: ['app'],
          },
          organizationId: 'org',
        },
      ]),
      secrets,
      'b1',
    ),
    { kind: 'binding_password_unavailable' },
  )
})

test('materializeBinding returns binding_password_unavailable when decrypt fails', async () => {
  const { postgresEngineSpec } = await import('../../lib/managed/postgres.ts')
  assertEquals(
    await materializeBinding(
      materializeJoinDb([
        {
          id: 'b1',
          principalId: 'p1',
          serviceId: 's1',
          databaseName: 'app',
          keyPrefix: 'DATABASE',
          emitEngineDefaults: false,
          principalKind: 'database',
          principalUsername: 'u',
          principalPassword: 'not-a-valid-enc-envelope',
          principalManagedId: 'm1',
          managedId: 'm1',
          managedEngine: 'postgres',
          managedOptions: {
            settings: postgresEngineSpec.defaultSettings,
            databases: ['app'],
          },
          organizationId: 'org',
        },
      ]),
      secrets,
      'b1',
    ),
    { kind: 'binding_password_unavailable' },
  )
})

test('materializeBindingsForServices / Principal propagate first error', async () => {
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
