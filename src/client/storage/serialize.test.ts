import { assertEquals } from 'jsr:@std/assert'
import { principalVolumePath } from '../../lib/naming.ts'
import { serializeStorage, type StorageSelectRow } from './serialize.ts'

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
    projectId: '00000000-0000-4000-8000-000000000002',
    environmentId: '00000000-0000-4000-8000-000000000003',
    serviceId: '00000000-0000-4000-8000-000000000004',
    serverId: '00000000-0000-4000-8000-000000000005',
    kind: 'volume',
    name: 'data',
    sourcePath: null,
    destinationPath: '/data',
    principalId: null,
    metadata: {},
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    principalUsername: null,
    ...overrides,
  }
}

test('serializeStorage prefers an explicit non-empty sourcePath', () => {
  const row = baseRow({
    sourcePath: '/explicit/path',
    kind: 'bind_mount',
    principalId: '00000000-0000-4000-8000-000000000020',
    principalUsername: 'app',
  })
  const serialized = serializeStorage(row)
  assertEquals(serialized.resolvedSourcePath, '/explicit/path')
  assertEquals(serialized.sourcePath, '/explicit/path')
  assertEquals('principalUsername' in serialized, false)
})

test('serializeStorage derives principal volume path for bind mounts', () => {
  const storageId = '00000000-0000-4000-8000-000000000010'
  const row = baseRow({
    id: storageId,
    kind: 'bind_mount',
    sourcePath: null,
    principalId: '00000000-0000-4000-8000-000000000020',
    principalUsername: 'app',
  })
  assertEquals(
    serializeStorage(row).resolvedSourcePath,
    principalVolumePath('app', storageId),
  )
})

test('serializeStorage returns null when bind mount lacks principal username', () => {
  const row = baseRow({
    kind: 'bind_mount',
    sourcePath: '',
    principalId: '00000000-0000-4000-8000-000000000020',
    principalUsername: null,
  })
  assertEquals(serializeStorage(row).resolvedSourcePath, null)
})

test('serializeStorage returns null for non-bind kinds without sourcePath', () => {
  const row = baseRow({
    kind: 'volume',
    sourcePath: null,
    principalId: '00000000-0000-4000-8000-000000000020',
    principalUsername: 'app',
  })
  assertEquals(serializeStorage(row).resolvedSourcePath, null)
})
