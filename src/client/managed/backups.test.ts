import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import type { ManagedEngineSpec } from '../../lib/managed/types.ts'
import type { ManagedContext } from './context.ts'
import type { ManagedBackupRecord, ManagedRowOptions } from './options.ts'
import {
  buildManagedBackupCreatePayload,
  buildManagedBackupDeletePayload,
  buildManagedRestorePayload,
  enqueueManagedBackup,
  enqueueManagedRestore,
  isManagedBackupApiError,
  mapManagedBackupApiError,
  resolveBackupDatabase,
} from './backups.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function buildContext(spec: ManagedEngineSpec): ManagedContext {
  return {
    environmentId: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    envDisplayName: 'Production',
    catalogCode: 'postgres',
    spec,
    serverId: '00000000-0000-4000-8000-000000000003',
    organizationId: '00000000-0000-4000-8000-000000000004',
  }
}

function buildOptions(overrides?: Partial<ManagedRowOptions>): ManagedRowOptions {
  const settings = postgresEngineSpec.parseSettings(postgresEngineSpec.defaultSettings)
  if (!settings) throw new TypeError('failed to build default settings fixture')
  return {
    settings,
    databases: ['postgres', 'app'],
    backups: [],
    ...overrides,
  }
}

function buildRecord(overrides?: Partial<ManagedBackupRecord>): ManagedBackupRecord {
  return {
    id: 'bk_abc123',
    createdAt: '2024-01-01T00:00:00.000Z',
    sizeBytes: 1024,
    checksum: 'a'.repeat(64),
    database: 'app',
    path: '/var/lib/turbopanel/managed/m1/backups/bk_abc123.dump',
    ...overrides,
  }
}

test('resolveBackupDatabase defaults to the first configured database', () => {
  const options = buildOptions()
  assertEquals(resolveBackupDatabase(options, undefined), 'postgres')
})

test('resolveBackupDatabase skips MySQL system schemas for the default', () => {
  const options = buildOptions({ databases: ['mysql', 'appdb', 'sys'] })
  assertEquals(resolveBackupDatabase(options, undefined, 'mysql'), 'appdb')
  assertEquals(resolveBackupDatabase(options, undefined, 'mariadb'), 'appdb')
  // Explicit request still allowed when present in the list
  assertEquals(resolveBackupDatabase(options, 'mysql', 'mysql'), 'mysql')
})

test('resolveBackupDatabase accepts a requested database in the configured list', () => {
  const options = buildOptions()
  assertEquals(resolveBackupDatabase(options, 'app'), 'app')
})

test('resolveBackupDatabase rejects a database not in the configured list', () => {
  const options = buildOptions()
  assertEquals(resolveBackupDatabase(options, 'unknown'), null)
})

test('resolveBackupDatabase rejects a non-string requested value', () => {
  const options = buildOptions()
  assertEquals(resolveBackupDatabase(options, 42), null)
})

test('resolveBackupDatabase returns null when no databases are configured', () => {
  const options = buildOptions({ databases: [] })
  assertEquals(resolveBackupDatabase(options, undefined), null)
})

test('isManagedBackupApiError recognizes error objects and rejects others', () => {
  assertEquals(isManagedBackupApiError({ kind: 'backup_not_found' }), true)
  assertEquals(isManagedBackupApiError(null), false)
  assertEquals(isManagedBackupApiError('backup_not_found'), false)
})

test('mapManagedBackupApiError maps unsupported to 400 and missing to 404', async () => {
  const c = {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>

  const unsupported = mapManagedBackupApiError(c, {
    kind: 'managed_backup_unsupported',
  })
  assertEquals(unsupported.status, 400)
  assertEquals(await unsupported.json(), { error: 'managed_backup_unsupported' })

  const missing = mapManagedBackupApiError(c, { kind: 'backup_not_found' })
  assertEquals(missing.status, 404)
  assertEquals(await missing.json(), { error: 'backup_not_found' })
})

test('buildManagedBackupCreatePayload builds a create payload with clamped retention', () => {
  const ctx = buildContext(postgresEngineSpec)
  const options = buildOptions({
    settings: {
      ...buildOptions().settings,
      backups: { retentionKeep: 999 },
    },
  })

  const built = buildManagedBackupCreatePayload(ctx, 'managed-1', options, 'app')
  if (isManagedBackupApiError(built)) {
    throw new Error(`expected success, got error kind=${built.kind}`)
  }
  assertEquals(built.payload.managedId, 'managed-1')
  assertEquals(built.payload.engine, 'postgres')
  assertEquals(built.payload.action, 'create')
  assertEquals(built.payload.artifactExtension, 'dump')
  assertEquals(built.payload.scope, 'database')
  assertEquals(built.payload.database, 'app')
  // Clamped to the engine's maxRetentionKeep (50), not the requested 999.
  assertEquals(built.payload.retentionKeep, 50)
  assertEquals(built.payload.backupId, built.backupId)
  assertEquals(built.backupId.startsWith('bk_'), true)
})

test('buildManagedBackupCreatePayload falls back to the engine default retention', () => {
  const ctx = buildContext(postgresEngineSpec)
  const options = buildOptions()

  const built = buildManagedBackupCreatePayload(ctx, 'managed-1', options, 'postgres')
  if (isManagedBackupApiError(built)) {
    throw new Error(`expected success, got error kind=${built.kind}`)
  }
  assertEquals(built.payload.retentionKeep, postgresEngineSpec.backup?.defaultRetentionKeep)
})

test('buildManagedBackupCreatePayload rejects engines without backup support', () => {
  const unsupportedSpec: ManagedEngineSpec = { ...postgresEngineSpec, backup: undefined }
  const ctx = buildContext(unsupportedSpec)
  const options = buildOptions()

  const built = buildManagedBackupCreatePayload(ctx, 'managed-1', options, 'postgres')
  if (!isManagedBackupApiError(built)) {
    throw new Error('expected managed_backup_unsupported error')
  }
  assertEquals(built.kind, 'managed_backup_unsupported')
})

test('buildManagedBackupDeletePayload builds a delete payload from a stored record', () => {
  const ctx = buildContext(postgresEngineSpec)
  const record = buildRecord()

  const built = buildManagedBackupDeletePayload(ctx, 'managed-1', record)
  if (isManagedBackupApiError(built)) {
    throw new Error(`expected success, got error kind=${built.kind}`)
  }
  assertEquals(built.payload.action, 'delete')
  assertEquals(built.payload.backupId, record.id)
  assertEquals(built.payload.artifactExtension, 'dump')
  assertEquals(built.payload.scope, 'database')
  assertEquals(built.payload.database, 'app')
})

test('buildManagedBackupDeletePayload rejects engines without backup support', () => {
  const unsupportedSpec: ManagedEngineSpec = { ...postgresEngineSpec, backup: undefined }
  const ctx = buildContext(unsupportedSpec)
  const record = buildRecord()

  const built = buildManagedBackupDeletePayload(ctx, 'managed-1', record)
  if (!isManagedBackupApiError(built)) {
    throw new Error('expected managed_backup_unsupported error')
  }
  assertEquals(built.kind, 'managed_backup_unsupported')
})

test('buildManagedBackupDeletePayload uses instance scope when database is absent', () => {
  const ctx = buildContext(postgresEngineSpec)
  const record = buildRecord()
  delete (record as { database?: string }).database

  const built = buildManagedBackupDeletePayload(ctx, 'managed-1', record)
  if (isManagedBackupApiError(built)) {
    throw new Error(`expected success, got error kind=${built.kind}`)
  }
  assertEquals(built.payload.scope, 'instance')
  assertEquals('database' in built.payload, false)
})

test('buildManagedRestorePayload carries the stored checksum and size, never dump bytes', () => {
  const ctx = buildContext(postgresEngineSpec)
  const record = buildRecord()

  const built = buildManagedRestorePayload(ctx, 'managed-1', record)
  if (isManagedBackupApiError(built)) {
    throw new Error(`expected success, got error kind=${built.kind}`)
  }
  assertEquals(built.payload.backupId, record.id)
  assertEquals(built.payload.checksum, record.checksum)
  assertEquals(built.payload.sizeBytes, record.sizeBytes)
  assertEquals(built.payload.database, record.database)
  assertEquals(built.payload.artifactExtension, 'dump')
  assertEquals('summary' in built.payload, false)
})

test('buildManagedRestorePayload rejects engines without backup support', () => {
  const unsupportedSpec: ManagedEngineSpec = { ...postgresEngineSpec, backup: undefined }
  const ctx = buildContext(unsupportedSpec)
  const record = buildRecord()

  const built = buildManagedRestorePayload(ctx, 'managed-1', record)
  if (!isManagedBackupApiError(built)) {
    throw new Error('expected managed_backup_unsupported error')
  }
  assertEquals(built.kind, 'managed_backup_unsupported')
})

test('buildManagedRestorePayload omits database when the record has none', () => {
  const ctx = buildContext(postgresEngineSpec)
  const record = buildRecord()
  delete (record as { database?: string }).database

  const built = buildManagedRestorePayload(ctx, 'managed-1', record)
  if (isManagedBackupApiError(built)) {
    throw new Error(`expected success, got error kind=${built.kind}`)
  }
  assertEquals('database' in built.payload, false)
})

function mockBackupContext(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

test('enqueueManagedBackup and enqueueManagedRestore delegate to enqueueTypedCommand', async () => {
  const c = mockBackupContext()
  const db = {
    insert: () => ({
      values: () => ({
        returning: () =>
          Promise.resolve([{
            id: 'cmd-backup-1',
            serverId: 'server-1',
            actorType: 'user',
            actorId: 'user-1',
            name: 'managed.backup',
            status: 'queued',
            attempts: 0,
            payload: {},
            metadata: { queuedAt: '2024-01-01T00:00:00.000Z' },
            result: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
        returning: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Db
  const queue = {
    enqueue: async () => {},
  }

  const backup = await enqueueManagedBackup(c, db, queue, {
    userId: 'user-1',
    serverId: 'server-1',
    payload: {
      managedId: 'managed-1',
      engine: 'postgres',
      action: 'create',
      backupId: 'bk_test',
      artifactExtension: 'dump',
      scope: 'database',
      database: 'app',
    },
  })
  if (backup instanceof Response) {
    throw new TypeError('expected backup enqueue response')
  }
  assertEquals(backup.commandId, 'cmd-backup-1')

  const restore = await enqueueManagedRestore(c, db, queue, {
    userId: 'user-1',
    serverId: 'server-1',
    managedId: 'managed-1',
    payload: {
      managedId: 'managed-1',
      engine: 'postgres',
      backupId: 'bk_test',
      artifactExtension: 'dump',
      checksum: 'a'.repeat(64),
      sizeBytes: 100,
    },
  })
  if (restore instanceof Response) {
    throw new TypeError('expected restore enqueue response')
  }
  assertEquals(restore.commandId, 'cmd-backup-1')
})
