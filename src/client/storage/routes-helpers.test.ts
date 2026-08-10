import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { storage } from '../../lib/db/schema.ts'
import {
  buildStorageUpdateFields,
  dockerVolumeMetadataWithId,
  isStorageContentTooLarge,
  isStorageKind,
  MAX_STORAGE_CONTENT_BYTES,
  mountKindRequiresDestination,
  optionalStringField,
  parseCreateStorageFields,
  parseOptionalStorageContent,
  parseStorageParent,
  principalProjectMismatch,
  resolvePatchKind,
  resolvePatchPrincipalId,
  resolvePatchStorageRefs,
  resolveStorageParentContext,
  resolveStorageProjectId,
  STORAGE_KINDS,
  storageContentByteLength,
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
  assertEquals(mountKindRequiresDestination('file', null), true)
  assertEquals(mountKindRequiresDestination('directory', '/mnt/data'), false)
})

test('isStorageKind accepts all canonical kinds', () => {
  for (const kind of STORAGE_KINDS) {
    assertEquals(isStorageKind(kind), true)
  }
})

test('resolvePatchKind keeps existing kind when body kind invalid', () => {
  const existing = baseRow({ kind: 'docker_volume' })
  assertEquals(resolvePatchKind({}, existing), 'docker_volume')
  assertEquals(resolvePatchKind({ kind: 'bind_mount' }, existing), 'bind_mount')
})

test('resolvePatchPrincipalId honors null, string, or existing', () => {
  assertEquals(resolvePatchPrincipalId({ principalId: null }, 'keep'), null)
  assertEquals(
    resolvePatchPrincipalId({ principalId: '00000000-0000-4000-8000-000000000099' }, 'keep'),
    '00000000-0000-4000-8000-000000000099',
  )
  assertEquals(resolvePatchPrincipalId({}, 'keep'), 'keep')
})

test('resolvePatchStorageRefs preserves omitted fields from existing row', () => {
  const existing = baseRow({
    serverId: 'srv-keep',
    kind: 'docker_volume',
    destinationPath: '/keep',
    principalId: '00000000-0000-4000-8000-000000000020',
  })
  const next = resolvePatchStorageRefs({}, existing)
  assertEquals(next.serverId, 'srv-keep')
  assertEquals(next.kind, 'docker_volume')
  assertEquals(next.destinationPath, '/keep')
  assertEquals(next.principalId, '00000000-0000-4000-8000-000000000020')
})

test('resolveStorageParentContext returns null when row has no parent ids', () => {
  assertEquals(
    resolveStorageParentContext(baseRow({
      projectId: null,
      environmentId: null,
      serviceId: null,
    })),
    null,
  )
})

test('parseStorageParent rejects invalid parent id values', async () => {
  const c = mockContext()
  await expectErrorResponse(
    parseStorageParent(c, { projectId: '' }),
    400,
    { error: 'Exactly one parent resource must be specified' },
  )
  await expectErrorResponse(
    parseStorageParent(c, { environmentId: 42 }),
    400,
    { error: 'Invalid request' },
  )
})

test('parseCreateStorageFields validates required create body fields', async () => {
  const c = mockContext()
  await expectErrorResponse(
    parseCreateStorageFields(c, { kind: 'volume', name: 'x', serverId: 's' }),
    400,
    { error: 'Invalid request' },
  )
  await expectErrorResponse(
    parseCreateStorageFields(c, { kind: 'bind_mount', serverId: 's' }),
    400,
    { error: 'Invalid request' },
  )
  const ok = parseCreateStorageFields(c, {
    kind: 'bind_mount',
    name: 'data',
    serverId: 'srv-1',
    destinationPath: '/data',
    metadata: { tier: 'fast' },
  })
  if (ok instanceof Response) {
    throw new TypeError('expected parsed create fields')
  }
  assertEquals(ok.kind, 'bind_mount')
  assertEquals(ok.name, 'data')
  assertEquals(ok.serverId, 'srv-1')
  assertEquals(ok.destinationPath, '/data')
  assertEquals(ok.metadata, { tier: 'fast' })
})

test('buildStorageUpdateFields rejects invalid metadata and options', async () => {
  const c = mockContext()
  await expectErrorResponse(
    buildStorageUpdateFields(c, { metadata: [] }),
    400,
    { error: 'Invalid request' },
  )
  const fields = buildStorageUpdateFields(c, {
    name: 'renamed',
    principalId: null,
    options: { readonly: true },
  })
  if (fields instanceof Response) {
    throw new TypeError('expected update fields')
  }
  assertEquals(fields.name, 'renamed')
  assertEquals(fields.principalId, null)
  assertEquals(fields.options, { readonly: true })
  assertEquals(typeof fields.updatedAt, 'string')
})

test('parseOptionalStorageContent accepts undefined or string only', async () => {
  const c = mockContext()
  assertEquals(parseOptionalStorageContent(c, undefined), undefined)
  assertEquals(parseOptionalStorageContent(c, 'payload'), 'payload')
  await expectErrorResponse(
    parseOptionalStorageContent(c, false),
    400,
    { error: 'Invalid request' },
  )
})

test('storage content size helpers enforce the 256 KiB cap', () => {
  const under = 'x'.repeat(MAX_STORAGE_CONTENT_BYTES)
  assertEquals(storageContentByteLength(under), MAX_STORAGE_CONTENT_BYTES)
  assertEquals(isStorageContentTooLarge(under), false)
  assertEquals(isStorageContentTooLarge(`${under}x`), true)
})

test('dockerVolumeMetadataWithId pins the storage UUID', () => {
  assertEquals(dockerVolumeMetadataWithId(null, 'stor-1'), {
    dockerVolumeName: 'stor-1',
  })
  assertEquals(dockerVolumeMetadataWithId({ tier: 'fast' }, 'stor-2'), {
    tier: 'fast',
    dockerVolumeName: 'stor-2',
  })
})

test('principalProjectMismatch only compares when a project is expected', () => {
  assertEquals(principalProjectMismatch('p1', undefined), false)
  assertEquals(principalProjectMismatch('p1', null), false)
  assertEquals(principalProjectMismatch('p1', 'p1'), false)
  assertEquals(principalProjectMismatch('p1', 'p2'), true)
  assertEquals(principalProjectMismatch(null, 'p1'), true)
})
