import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { storage } from '../../lib/db/schema.ts'
import {
  buildStorageUpdateFields,
  dockerVolumeMetadataWithId,
  isStorageContentTooLarge,
  isStorageKind,
  mapStorageUniqueViolation,
  MAX_STORAGE_CONTENT_BYTES,
  optionalStringField,
  parseCreateStorageFields,
  parseOptionalStorageContent,
  parseStorageParent,
  principalProjectMismatch,
  resolvePatchKind,
  resolvePatchPrincipalId,
  resolveStorageParentContext,
  resolveStorageProjectId,
  scratchCopyNotMountable,
  STORAGE_KINDS,
  storageContentByteLength,
  SCRATCH_COPY_NOT_MOUNTABLE_ERROR,
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
    workspaceId: null,
    projectId: '00000000-0000-4000-8000-000000000002',
    environmentId: null,
    serviceId: null,
    kind: 'volume',
    name: 'data',
    accessMode: 'single_writer',
    retention: 'retain',
    generation: 0,
    principalId: null,
    metadata: {},
    options: null,
    contentEnvelope: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('isStorageKind accepts known kinds only', () => {
  assertEquals(isStorageKind('volume'), true)
  assertEquals(isStorageKind('directory'), true)
  assertEquals(isStorageKind('file'), true)
  assertEquals(isStorageKind('docker_volume'), false)
  assertEquals(isStorageKind('bind_mount'), false)
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
    resolveStorageProjectId({ column: 'projectId', id: 'proj-1', entityKind: 'project' }),
    'proj-1',
  )
  assertEquals(
    resolveStorageProjectId({
      column: 'environmentId',
      id: 'env-1',
      entityKind: 'environment',
    }),
    null,
  )
  assertEquals(
    resolveStorageProjectId({ column: null, id: null, entityKind: 'organization' }),
    null,
  )
})

test('resolveStorageParentContext prefers deepest parent then org', () => {
  assertEquals(resolveStorageParentContext(undefined), null)
  assertEquals(
    resolveStorageParentContext(baseRow({ projectId: 'p1' })),
    { parentId: 'p1', entityKind: 'project' },
  )
  assertEquals(
    resolveStorageParentContext(baseRow({
      projectId: null,
      environmentId: 'e1',
    })),
    { parentId: 'e1', entityKind: 'environment' },
  )
  assertEquals(
    resolveStorageParentContext(baseRow({
      projectId: null,
      serviceId: 's1',
    })),
    { parentId: 's1', entityKind: 'service' },
  )
  assertEquals(
    resolveStorageParentContext(baseRow({
      projectId: null,
      workspaceId: 'w1',
    })),
    { parentId: 'w1', entityKind: 'workspace' },
  )
  assertEquals(
    resolveStorageParentContext(baseRow({
      projectId: null,
      workspaceId: null,
      environmentId: null,
      serviceId: null,
    })),
    {
      parentId: '00000000-0000-4000-8000-000000000001',
      entityKind: 'organization',
    },
  )
})

test('parseStorageParent allows zero parents (org-wide) and at most one', async () => {
  const c = mockContext()
  assertEquals(parseStorageParent(c, {}), {
    column: null,
    id: null,
    entityKind: 'organization',
  })
  await expectErrorResponse(
    parseStorageParent(c, { projectId: 'p1', environmentId: 'e1' }),
    400,
    { error: 'At most one parent resource may be specified' },
  )
  assertEquals(parseStorageParent(c, { serviceId: 'svc-1' }), {
    column: 'serviceId',
    id: 'svc-1',
    entityKind: 'service',
  })
  assertEquals(parseStorageParent(c, { workspaceId: 'ws-1' }), {
    column: 'workspaceId',
    id: 'ws-1',
    entityKind: 'workspace',
  })
})

test('isStorageKind accepts all canonical kinds', () => {
  for (const kind of STORAGE_KINDS) {
    assertEquals(isStorageKind(kind), true)
  }
})

test('resolvePatchKind keeps existing kind when body kind invalid', () => {
  const existing = baseRow({ kind: 'volume' })
  assertEquals(resolvePatchKind({}, existing), 'volume')
  assertEquals(resolvePatchKind({ kind: 'directory' }, existing), 'directory')
})

test('resolvePatchPrincipalId honors null, string, or existing', () => {
  assertEquals(resolvePatchPrincipalId({ principalId: null }, 'keep'), null)
  assertEquals(
    resolvePatchPrincipalId({ principalId: '00000000-0000-4000-8000-000000000099' }, 'keep'),
    '00000000-0000-4000-8000-000000000099',
  )
  assertEquals(resolvePatchPrincipalId({}, 'keep'), 'keep')
})

test('parseStorageParent rejects invalid parent id values', async () => {
  const c = mockContext()
  assertEquals(parseStorageParent(c, { projectId: '' }), {
    column: null,
    id: null,
    entityKind: 'organization',
  })
  await expectErrorResponse(
    parseStorageParent(c, { environmentId: 42 }),
    400,
    { error: 'Invalid request' },
  )
})

test('parseCreateStorageFields validates required create body fields', async () => {
  const c = mockContext()
  await expectErrorResponse(
    parseCreateStorageFields(c, { kind: 'docker_volume', name: 'x' }),
    400,
    { error: 'Invalid request' },
  )
  await expectErrorResponse(
    parseCreateStorageFields(c, { kind: 'volume' }),
    400,
    { error: 'Invalid request' },
  )
  const ok = parseCreateStorageFields(c, {
    kind: 'directory',
    name: 'data',
    storageCopy: { provider: 'path', serverId: 'srv-1', path: '/srv/data' },
    mount: { serviceId: 'svc-1', destinationPath: '/data' },
  })
  if (ok instanceof Response) {
    throw new TypeError('expected parsed create fields')
  }
  assertEquals(ok.kind, 'directory')
  assertEquals(ok.name, 'data')
  assertEquals(ok.accessMode, 'single_writer')
  assertEquals(ok.retention, 'retain')
  assertEquals(ok.copy?.provider, 'path')
  assertEquals(ok.copy?.serverId, 'srv-1')
  assertEquals(ok.mount?.destinationPath, '/data')
})

test('parseCreateStorageFields rejects mounting a scratch copy', async () => {
  const c = mockContext()
  await expectErrorResponse(
    parseCreateStorageFields(c, {
      kind: 'volume',
      name: 'tmp',
      storageCopy: { provider: 'docker', serverId: 'srv-1', role: 'scratch' },
      mount: { serviceId: 'svc-1', destinationPath: '/tmp' },
    }),
    400,
    { error: SCRATCH_COPY_NOT_MOUNTABLE_ERROR },
  )
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

test('scratchCopyNotMountable is true only for scratch', () => {
  assertEquals(scratchCopyNotMountable('scratch'), true)
  assertEquals(scratchCopyNotMountable('primary'), false)
  assertEquals(scratchCopyNotMountable(null), false)
})

test('mapStorageUniqueViolation classifies known indexes', () => {
  assertEquals(mapStorageUniqueViolation({ message: 'x' }), null)
  assertEquals(
    mapStorageUniqueViolation({
      code: '23505',
      message: 'uniq_copy_storage_primary',
    }),
    { error: 'copy_primary_exists', status: 409 },
  )
  assertEquals(
    mapStorageUniqueViolation(
      Object.assign(new Error('uniq_copy_storage_server_provider'), { code: '23505' }),
    ),
    { error: 'copy_server_provider_exists', status: 409 },
  )
  assertEquals(
    mapStorageUniqueViolation(
      Object.assign(new Error('uniq_mount_service_destination'), { code: '23505' }),
    ),
    { error: 'mount_destination_in_use', status: 409 },
  )
  assertEquals(
    mapStorageUniqueViolation(Object.assign(new Error('other'), { code: '23505' })),
    { error: 'conflict', status: 409 },
  )
})
