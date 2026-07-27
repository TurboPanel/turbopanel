import { assertEquals } from 'jsr:@std/assert'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import type { ManagedEngineSpec } from '../../lib/managed/types.ts'
import type { ManagedContext } from './context.ts'
import type { ManagedBackupRecord, ManagedRowOptions } from './options.ts'
import {
  buildManagedBackupCreatePayload,
  buildManagedBackupDeletePayload,
  buildManagedRestorePayload,
  isManagedBackupApiError,
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
