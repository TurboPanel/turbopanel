import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import type { ManagedContext } from './context.ts'
import type { ManagedRowOptions } from './options.ts'
import {
  isManagedRootPrincipal,
  isPlainObject,
  managedSessionPaths,
  mergeCreateSettings,
  parseManagedUserCreateFields,
  principalMetadata,
  readInitialDatabase,
  resolveManagedServerId,
  serializeContainerRow,
  serializeManagedUser,
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

function mockManagedContext(
  overrides: Partial<ManagedContext> = {},
): ManagedContext {
  return {
    environmentId: 'env-1',
    projectId: 'proj-1',
    envDisplayName: 'Production',
    catalogCode: 'postgres',
    spec: postgresEngineSpec,
    serverId: 'server-1',
    organizationId: 'org-1',
    ...overrides,
  }
}

function defaultRowOptions(): ManagedRowOptions {
  const settings = postgresEngineSpec.parseSettings(postgresEngineSpec.defaultSettings)
  if (!settings) throw new TypeError('expected default postgres settings')
  return { settings, databases: ['postgres'], backups: [] }
}

test('isPlainObject accepts records only', () => {
  assertEquals(isPlainObject({ a: 1 }), true)
  assertEquals(isPlainObject(null), false)
  assertEquals(isPlainObject([]), false)
  assertEquals(isPlainObject('x'), false)
})

test('managedSessionPaths lists every managed session route', () => {
  const paths = managedSessionPaths()
  assertEquals(paths.length, 14)
  assertEquals(paths.includes('/environments/:id/managed/logs'), true)
  assertEquals(paths.includes('/organizations/:id/managed'), true)
})

test('mergeCreateSettings returns defaults when body has no exposure', () => {
  const merged = mergeCreateSettings(postgresEngineSpec, {})
  if (!merged) throw new TypeError('expected merged settings')
  assertEquals(merged.exposure.enabled, false)
  assertEquals(merged.exposure.bind, undefined)
})

test('mergeCreateSettings merges exposure overrides and re-validates', () => {
  const merged = mergeCreateSettings(postgresEngineSpec, {
    exposure: {
      enabled: true,
      publishedPort: 15432,
      bind: 'public',
    },
  })
  if (!merged) throw new TypeError('expected merged settings')
  assertEquals(merged.exposure.enabled, true)
  assertEquals(merged.exposure.publishedPort, 15432)
  assertEquals(merged.exposure.bind, 'public')

  const invalidPort = mergeCreateSettings(postgresEngineSpec, {
    exposure: { enabled: true, publishedPort: 22 },
  })
  assertEquals(invalidPort, null)
})

test('mergeCreateSettings ignores non-object exposure and invalid bind tokens', () => {
  const fromString = mergeCreateSettings(postgresEngineSpec, { exposure: 'nope' })
  if (!fromString) throw new TypeError('expected settings')
  assertEquals(fromString.exposure.enabled, false)

  const badBind = mergeCreateSettings(postgresEngineSpec, {
    exposure: { bind: 'internet' },
  })
  if (!badBind) throw new TypeError('expected settings')
  assertEquals(badBind.exposure.bind, undefined)
})

test('readInitialDatabase defaults to postgres and honors engine initialDatabase', () => {
  assertEquals(readInitialDatabase(postgresEngineSpec), 'postgres')

  const customSpec = {
    ...postgresEngineSpec,
    defaultSettings: {
      ...postgresEngineSpec.defaultSettings,
      initialDatabase: 'appdb',
    },
  }
  assertEquals(readInitialDatabase(customSpec), 'appdb')
})

test('resolveManagedServerId prefers managed.server_id over environment placement', () => {
  assertEquals(
    resolveManagedServerId({ serverId: 'managed-pin' }, 'env-pin'),
    'managed-pin',
  )
  assertEquals(resolveManagedServerId({ serverId: null }, 'env-pin'), 'env-pin')
  assertEquals(resolveManagedServerId({ serverId: null }, null), null)
})

test('principalMetadata and isManagedRootPrincipal', () => {
  assertEquals(principalMetadata(null), {})
  assertEquals(principalMetadata([1]), {})
  assertEquals(
    principalMetadata({ managedRoot: true, databases: ['postgres'] }),
    { managedRoot: true, databases: ['postgres'] },
  )
  assertEquals(isManagedRootPrincipal({ managedRoot: true }), true)
  assertEquals(isManagedRootPrincipal({ managedRoot: false }), false)
  assertEquals(isManagedRootPrincipal(undefined), false)
})

test('serializeManagedUser filters databases and privileges to strings', () => {
  const serialized = serializeManagedUser({
    id: 'prin-1',
    username: 'app_user',
    metadata: {
      databases: ['postgres', 42, 'app'],
      privileges: ['read-only', null],
    },
    createdAt: '2024-01-01T00:00:00.000Z',
  })
  assertEquals(serialized, {
    id: 'prin-1',
    username: 'app_user',
    databases: ['postgres', 'app'],
    privileges: ['read-only'],
    createdAt: '2024-01-01T00:00:00.000Z',
  })
})

test('serializeContainerRow passes through container inventory fields', () => {
  const row = {
    id: 'ctr-1',
    serviceId: 'svc-1',
    serverId: 'server-1',
    containerId: 'docker-abc',
    containerName: 'svc-1-1',
    status: 'running',
    role: 'service',
    composeServiceName: 'postgres',
    metadata: {},
    options: {},
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  }
  assertEquals(serializeContainerRow(row), row)
})

test('parseManagedUserCreateFields accepts valid postgres user input', async () => {
  const c = mockContext()
  const result = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    {
      username: 'app_user',
      databases: ['postgres'],
      privileges: ['read-only'],
    },
    defaultRowOptions(),
  )
  if (result instanceof Response) throw new TypeError('expected parsed fields')
  assertEquals(result, {
    username: 'app_user',
    databases: ['postgres'],
    privileges: ['read-only'],
  })
})

test('parseManagedUserCreateFields rejects root username and invalid identifiers', async () => {
  const c = mockContext()
  const options = defaultRowOptions()

  const root = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    { username: 'postgres', databases: ['postgres'] },
    options,
  )
  if (!(root instanceof Response)) throw new TypeError('expected Response')
  assertEquals(root.status, 400)
  assertEquals(await root.json(), { error: 'Invalid username' })

  const badName = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    { username: 'bad name!', databases: ['postgres'] },
    options,
  )
  if (!(badName instanceof Response)) throw new TypeError('expected Response')
  assertEquals(badName.status, 400)
})

test('parseManagedUserCreateFields rejects unknown databases and privileges', async () => {
  const c = mockContext()
  const options = defaultRowOptions()

  const unknownDb = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    { username: 'app_user', databases: ['missing'] },
    options,
  )
  if (!(unknownDb instanceof Response)) throw new TypeError('expected Response')
  assertEquals(unknownDb.status, 400)
  assertEquals(await unknownDb.json(), { error: 'Invalid request' })

  const badPrivilege = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    { username: 'app_user', databases: ['postgres'], privileges: ['superuser'] },
    options,
  )
  if (!(badPrivilege instanceof Response)) throw new TypeError('expected Response')
  assertEquals(badPrivilege.status, 400)
})

test('parseManagedUserCreateFields rejects empty databases and non-string entries', async () => {
  const c = mockContext()
  const options = defaultRowOptions()

  const empty = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    { username: 'app_user', databases: [] },
    options,
  )
  if (!(empty instanceof Response)) throw new TypeError('expected Response')
  assertEquals(empty.status, 400)

  const mixed = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    { username: 'app_user', databases: ['postgres', 1] },
    options,
  )
  if (!(mixed instanceof Response)) throw new TypeError('expected Response')
  assertEquals(mixed.status, 400)
})
