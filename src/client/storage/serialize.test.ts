import { assertEquals } from '@std/assert'
import { principalVolumePath } from '../../lib/naming.ts'
import {
  serializeCopy,
  serializeStorage,
  type CopySelectRow,
  type StorageSelectRow,
} from './serialize.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function baseRow(overrides?: Partial<StorageSelectRow>): StorageSelectRow {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    organizationId: '00000000-0000-4000-8000-000000000001',
    workspaceId: null,
    projectId: '00000000-0000-4000-8000-000000000002',
    environmentId: '00000000-0000-4000-8000-000000000003',
    serviceId: '00000000-0000-4000-8000-000000000004',
    kind: 'volume',
    name: 'data',
    accessMode: 'single_writer',
    retention: 'retain',
    generation: 0,
    principalId: null,
    metadata: {},
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    principalUsername: null,
    ...overrides,
  }
}

function pathLocation(overrides?: Partial<CopySelectRow>): CopySelectRow {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    storageId: '00000000-0000-4000-8000-000000000010',
    serverId: '00000000-0000-4000-8000-000000000005',
    secretId: null,
    provider: 'path',
    role: 'primary',
    state: 'pending',
    path: null,
    endpoint: null,
    generation: 0,
    metadata: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('serializeStorage omits principalUsername and nests copies/mounts', () => {
  const serialized = serializeStorage(baseRow({ principalUsername: 'app' }), [], [])
  assertEquals('principalUsername' in serialized, false)
  assertEquals(serialized.copies, [])
  assertEquals(serialized.mounts, [])
  assertEquals(serialized.kind, 'volume')
})

test('serializeCopy prefers an explicit non-empty path', () => {
  const loc = pathLocation({ path: '/explicit/path' })
  const serialized = serializeCopy(loc, loc.storageId, 'app')
  assertEquals(serialized.resolvedSourcePath, '/explicit/path')
  assertEquals(serialized.path, '/explicit/path')
})

test('serializeCopy derives principal volume path for path copies', () => {
  const storageId = '00000000-0000-4000-8000-000000000010'
  const loc = pathLocation({ storageId, path: null })
  assertEquals(
    serializeCopy(loc, storageId, 'app').resolvedSourcePath,
    principalVolumePath('app', storageId),
  )
})

test('serializeCopy returns null when path location lacks principal username', () => {
  const loc = pathLocation({ path: '' })
  assertEquals(serializeCopy(loc, loc.storageId, null).resolvedSourcePath, null)
})

test('serializeCopy returns null for docker copies without path', () => {
  const loc = pathLocation({ provider: 'docker', path: null })
  assertEquals(
    serializeCopy(loc, loc.storageId, 'app').resolvedSourcePath,
    null,
  )
})
