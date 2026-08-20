import { assertEquals } from '@std/assert'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import { buildConnectionPayload, parseManagedResidual, serializeManagedRow } from './serialize.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseManagedResidual returns empty for non-objects', () => {
  assertEquals(parseManagedResidual(null), {})
  assertEquals(parseManagedResidual([]), {})
  assertEquals(parseManagedResidual('x'), {})
})

test('parseManagedResidual keeps only typed residual fields', () => {
  assertEquals(
    parseManagedResidual({
      rootPrincipalId: 'prin-1',
      host: 'db.internal',
      port: 5432,
      error: 'boom',
      ignored: true,
      portAsString: '5432',
    }),
    {
      rootPrincipalId: 'prin-1',
      host: 'db.internal',
      port: 5432,
      error: 'boom',
    },
  )
})

test('serializeManagedRow projects residual host/port and strips them from metadata', () => {
  const serialized = serializeManagedRow(
    {
      id: 'managed-1',
      environmentId: 'env-1',
      name: 'Postgres',
      engine: 'postgres',
      status: 'ready',
      metadata: {
        rootPrincipalId: 'prin-1',
        host: '127.0.0.1',
        port: 5432,
        error: 'previous failure',
      },
      options: { databases: ['postgres'] },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    },
    'server-1',
  )

  assertEquals(serialized.engine, 'postgres')
  assertEquals(serialized.status, 'ready')
  assertEquals(serialized.host, '127.0.0.1')
  assertEquals(serialized.port, 5432)
  assertEquals(serialized.serverId, 'server-1')
  assertEquals(serialized.metadata, {
    rootPrincipalId: 'prin-1',
    error: 'previous failure',
  })
})

test('serializeManagedRow defaults unknown engine/status and null host/port', () => {
  const serialized = serializeManagedRow(
    {
      id: 'managed-2',
      environmentId: null,
      name: null,
      engine: 'not-an-engine',
      status: 'weird',
      metadata: null,
      options: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
    null,
  )

  assertEquals(serialized.engine, null)
  assertEquals(serialized.status, 'provisioning')
  assertEquals(serialized.host, null)
  assertEquals(serialized.port, null)
  assertEquals(serialized.serverId, null)
  assertEquals(serialized.metadata, {})
})

test('buildConnectionPayload delegates to the engine spec', () => {
  const info = buildConnectionPayload(postgresEngineSpec, {
    host: 'db.example',
    port: 5432,
    database: 'app',
    username: 'app_user',
    sslMode: 'verify-full',
  })

  assertEquals(info.host, 'db.example')
  assertEquals(info.port, 5432)
  assertEquals(info.database, 'app')
  assertEquals(info.username, 'app_user')
  assertEquals(info.dsn.includes('***'), true)
  // verify-full matches the SANs issued for the ProxySQL listener certificate
  // (container name + any exposed address).
  assertEquals(info.dsn.includes('sslmode=verify-full'), true)
})

test('buildConnectionPayload renders whatever effective mode it is handed', () => {
  // The caller resolves service override → org default → platform; the payload
  // builder must not re-derive or clamp it.
  assertEquals(
    buildConnectionPayload(postgresEngineSpec, {
      host: 'db.example',
      port: 5432,
      database: 'app',
      username: 'app_user',
      sslMode: 'prefer',
    }).dsn.includes('sslmode=prefer'),
    true,
  )
})

test('parseManagedResidual ignores wrong-typed residual fields', () => {
  assertEquals(
    parseManagedResidual({
      rootPrincipalId: 12,
      host: null,
      port: '5432',
      error: false,
    }),
    {},
  )
})

test('serializeManagedRow keeps rootPrincipalId without host when only that residual exists', () => {
  const serialized = serializeManagedRow(
    {
      id: 'managed-3',
      environmentId: 'env-3',
      name: 'Postgres',
      engine: 'postgres',
      status: 'stopped',
      metadata: { rootPrincipalId: 'prin-only' },
      options: {},
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
    'server-3',
  )
  assertEquals(serialized.status, 'stopped')
  assertEquals(serialized.host, null)
  assertEquals(serialized.port, null)
  assertEquals(serialized.metadata, { rootPrincipalId: 'prin-only' })
})
