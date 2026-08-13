import { assertEquals } from 'jsr:@std/assert'
import { principalVolumePath } from '../../lib/naming.ts'
import {
  serializeLocation,
  serializeStorage,
  type LocationSelectRow,
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

function pathLocation(overrides?: Partial<LocationSelectRow>): LocationSelectRow {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    storageId: '00000000-0000-4000-8000-000000000010',
    serverId: '00000000-0000-4000-8000-000000000005',
    credentialId: null,
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

test('serializeStorage omits principalUsername and nests locations/mounts', () => {
  const serialized = serializeStorage(baseRow({ principalUsername: 'app' }), [], [])
  assertEquals('principalUsername' in serialized, false)
  assertEquals(serialized.locations, [])
  assertEquals(serialized.mounts, [])
  assertEquals(serialized.kind, 'volume')
})

test('serializeLocation prefers an explicit non-empty path', () => {
  const loc = pathLocation({ path: '/explicit/path' })
  const serialized = serializeLocation(loc, loc.storageId, 'app')
  assertEquals(serialized.resolvedSourcePath, '/explicit/path')
  assertEquals(serialized.path, '/explicit/path')
})

test('serializeLocation derives principal volume path for path locations', () => {
  const storageId = '00000000-0000-4000-8000-000000000010'
  const loc = pathLocation({ storageId, path: null })
  assertEquals(
    serializeLocation(loc, storageId, 'app').resolvedSourcePath,
    principalVolumePath('app', storageId),
  )
})

test('serializeLocation returns null when path location lacks principal username', () => {
  const loc = pathLocation({ path: '' })
  assertEquals(serializeLocation(loc, loc.storageId, null).resolvedSourcePath, null)
})

test('serializeLocation returns null for docker locations without path', () => {
  const loc = pathLocation({ provider: 'docker', path: null })
  assertEquals(
    serializeLocation(loc, loc.storageId, 'app').resolvedSourcePath,
    null,
  )
})
