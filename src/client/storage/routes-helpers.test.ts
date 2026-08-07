import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { storage } from '../../lib/db/schema.ts'
import {
  isStorageKind,
  mountKindRequiresDestination,
  optionalStringField,
  parseStorageParent,
  resolvePatchStorageRefs,
  resolveStorageParentContext,
  resolveStorageProjectId,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

async function expectErrorResponse(
  response: unknown,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  if (!(response instanceof Response)) {
    throw new TypeError('expected error response')
  }
  assertEquals(response.status, status)
  assertEquals(await response.json(), body)
}

type StorageRow = typeof storage.$inferSelect

function baseRow(overrides?: Partial<StorageRow>): StorageRow {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    organizationId: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    environmentId: null,
    serviceId: null,
    serverId: '00000000-0000-4000-8000-000000000005',
    kind: 'volume',
    name: 'data',
    sourcePath: null,
    destinationPath: '/data',
    principalId: null,
    metadata: {},
    options: null,
    contentEnvelope: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  } as StorageRow
}

test('isStorageKind accepts known kinds only', () => {
  assertEquals(isStorageKind('bind_mount'), true)
  assertEquals(isStorageKind('docker_volume'), true)
  assertEquals(isStorageKind('volume'), false)
  assertEquals(isStorageKind(null), false)
})

test('optionalStringField returns strings or null', () => {
  assertEquals(optionalStringField('/path'), '/path')
  assertEquals(optionalStringField(''), '')
  assertEquals(optionalStringField(null), null)
  assertEquals(optionalStringField(42), null)
})

test('resolveStorageProjectId returns id only for project parent', () => {
  assertEquals(
    resolveStorageProjectId({ column: 'projectId', id: 'proj-1' }),
    'proj-1',
  )
  assertEquals(
    resolveStorageProjectId({ column: 'environmentId', id: 'env-1' }),
    null,
  )
})

test('resolvePatchStorageRefs merges body over existing row', () => {
  const existing = baseRow({
    serverId: 'srv-old',
    kind: 'docker_volume',
    destinationPath: '/old',
    principalId: '00000000-0000-4000-8000-000000000020',
  })
  const next = resolvePatchStorageRefs(
    {
      serverId: 'srv-new',
      kind: 'bind_mount',
      destinationPath: '/new',
      principalId: null,
    },
    existing,
  )
  assertEquals(next.serverId, 'srv-new')
  assertEquals(next.kind, 'bind_mount')
  assertEquals(next.destinationPath, '/new')
  assertEquals(next.principalId, null)
})

test('resolveStorageParentContext prefers deepest parent', () => {
  assertEquals(resolveStorageParentContext(undefined), null)
  assertEquals(
    resolveStorageParentContext(baseRow({ projectId: 'p1' })),
    { parentId: 'p1', entityKind: 'project' },
  )
  assertEquals(
    resolveStorageParentContext(baseRow({
      projectId: 'p1',
      environmentId: 'e1',
    })),
    { parentId: 'e1', entityKind: 'environment' },
  )
  assertEquals(
    resolveStorageParentContext(baseRow({
      projectId: 'p1',
      environmentId: 'e1',
      serviceId: 's1',
    })),
    { parentId: 's1', entityKind: 'service' },
  )
})

test('parseStorageParent requires exactly one parent id', async () => {
  const c = mockContext()
  await expectErrorResponse(
    parseStorageParent(c, {}),
    400,
    { error: 'Exactly one parent resource must be specified' },
  )
  await expectErrorResponse(
    parseStorageParent(c, { projectId: 'p1', environmentId: 'e1' }),
    400,
    { error: 'Exactly one parent resource must be specified' },
  )
  assertEquals(parseStorageParent(c, { serviceId: 'svc-1' }), {
    column: 'serviceId',
    id: 'svc-1',
    entityKind: 'service',
  })
})

test('mountKindRequiresDestination is true when mount kind lacks path', () => {
  assertEquals(mountKindRequiresDestination('bind_mount', '  '), true)
  assertEquals(mountKindRequiresDestination('bind_mount', '/host'), false)
  assertEquals(mountKindRequiresDestination('docker_volume', null), false)
})
