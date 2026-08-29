import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import type { ManagedContext } from './context.ts'
import type { ManagedRowOptions } from './options.ts'
import {
  assertManagedSeriesUnchanged,
  buildManagedReleaseView,
  isManagedRootPrincipal,
  isPlainObject,
  MANAGED_SERIES_IMMUTABLE_ERROR,
  MANAGED_VERSION_UNSUPPORTED_ERROR,
  managedSessionPaths,
  mergeCreateSettings,
  parseManagedUserCreateFields,
  parseManagedVersionSelection,
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
  const {
    environmentId = 'env-1',
    projectId = 'proj-1',
    envDisplayName = 'Production',
    catalogCode = 'postgres',
    spec = postgresEngineSpec,
    serverId = 'server-1',
    organizationId = 'org-1',
    orgDefaults = {},
  } = overrides
  return {
    environmentId,
    projectId,
    envDisplayName,
    catalogCode,
    spec,
    serverId,
    organizationId,
    orgDefaults,
  }
}

function defaultRowOptions(): ManagedRowOptions {
  const settings = postgresEngineSpec.parseSettings(
    postgresEngineSpec.defaultSettings,
  )
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
  assertEquals(paths.length, 19)
  assertEquals(paths.includes('/environments/:id/managed/logs'), true)
  assertEquals(
    paths.includes('/environments/:id/managed/members/:memberId/promote'),
    true,
  )
  assertEquals(
    paths.includes('/environments/:id/managed/members/:memberId/resync'),
    true,
  )
  assertEquals(paths.includes('/organizations/:id/managed'), true)
})

test('mergeCreateSettings returns defaults when body has no exposure', () => {
  const merged = mergeCreateSettings(postgresEngineSpec, {})
  if (!merged) throw new TypeError('expected merged settings')
  assertEquals(merged.exposure.enabled, false)
  assertEquals(merged.exposure.scope, undefined)
})

test('mergeCreateSettings merges exposure overrides and re-validates', () => {
  const merged = mergeCreateSettings(postgresEngineSpec, {
    exposure: {
      enabled: true,
      scope: 'public',
    },
  })
  if (!merged) throw new TypeError('expected merged settings')
  assertEquals(merged.exposure.enabled, true)
  assertEquals(merged.exposure.scope, 'public')

  const legacyBind = mergeCreateSettings(postgresEngineSpec, {
    exposure: { enabled: true, bind: 'datacenter' },
  })
  assertEquals(legacyBind, null)

  const invalidScope = mergeCreateSettings(postgresEngineSpec, {
    exposure: { enabled: true, scope: 'internet' },
  })
  assertEquals(invalidScope, null)
})

test('mergeCreateSettings ignores non-object exposure and invalid scope tokens', () => {
  const fromString = mergeCreateSettings(postgresEngineSpec, {
    exposure: 'nope',
  })
  if (!fromString) throw new TypeError('expected settings')
  assertEquals(fromString.exposure.enabled, false)

  const badScope = mergeCreateSettings(postgresEngineSpec, {
    exposure: { scope: 'internet' },
  })
  assertEquals(badScope, null)
})

test('parseManagedVersionSelection resolves a catalog series and variant', () => {
  // Omitted → engine spec default image.
  assertEquals(parseManagedVersionSelection('postgres', {}), { ok: true })

  assertEquals(
    parseManagedVersionSelection('postgres', { engineSeries: '18' }),
    { ok: true, image: 'docker.io/library/postgres:18-alpine' },
  )
  assertEquals(
    parseManagedVersionSelection('postgres', {
      engineSeries: '18',
      imageVariant: 'debian',
    }),
    { ok: true, image: 'docker.io/library/postgres:18' },
  )
  // Variant alone applies to the default series.
  assertEquals(
    parseManagedVersionSelection('postgres', { imageVariant: 'debian' }),
    { ok: true, image: 'docker.io/library/postgres:18' },
  )
})

test('create accepts only the three verified series', () => {
  // The only creatable series per engine, both of their base-OS variants.
  assertEquals(
    parseManagedVersionSelection('mysql', { engineSeries: '9.7' }),
    { ok: true, image: 'docker.io/library/mysql:9.7' },
  )
  assertEquals(
    parseManagedVersionSelection('mysql', {
      engineSeries: '9.7',
      imageVariant: 'oraclelinux9',
    }),
    { ok: true, image: 'docker.io/library/mysql:9.7-oraclelinux9' },
  )
  assertEquals(
    parseManagedVersionSelection('mariadb', { engineSeries: '12.3' }),
    { ok: true, image: 'docker.io/library/mariadb:12.3' },
  )

  // Every other catalogued series is refused — it is known, not tested.
  for (const [engine, series] of [
    ['postgres', '17'],
    ['postgres', '16'],
    ['postgres', '15'],
    ['mysql', '8.4'],
    ['mariadb', '11.8'],
    ['mariadb', '11.4'],
    ['mariadb', '10.11'],
  ] as const) {
    assertEquals(
      parseManagedVersionSelection(engine, { engineSeries: series }),
      { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 },
      `${engine} ${series} must not be creatable`,
    )
  }
})

test('the explicit gate is the only way to create an untested series', () => {
  assertEquals(
    parseManagedVersionSelection(
      'postgres',
      { engineSeries: '17' },
      { includeUntested: true },
    ),
    { ok: true, image: 'docker.io/library/postgres:17-alpine' },
  )
  assertEquals(
    parseManagedVersionSelection(
      'mysql',
      { engineSeries: '8.4', imageVariant: 'oraclelinux9' },
      { includeUntested: true },
    ),
    { ok: true, image: 'docker.io/library/mysql:8.4-oraclelinux9' },
  )
  // The gate widens the catalog, it does not disable validation.
  assertEquals(
    parseManagedVersionSelection(
      'postgres',
      { engineSeries: '14' },
      { includeUntested: true },
    ),
    { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 },
  )
})

test('parseManagedVersionSelection rejects unknown versions and bad types', () => {
  assertEquals(
    parseManagedVersionSelection('postgres', { engineSeries: '14' }),
    { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 },
  )
  assertEquals(
    parseManagedVersionSelection('mysql', { engineSeries: '8.0' }),
    { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 },
  )
  assertEquals(
    parseManagedVersionSelection('postgres', { imageVariant: 'ubi' }),
    { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 },
  )
  // Engine with no catalog cannot resolve a default series.
  assertEquals(
    parseManagedVersionSelection('redis', { engineSeries: '7' }),
    { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 },
  )
  assertEquals(
    parseManagedVersionSelection('postgres', { engineSeries: 18 }),
    { ok: false, error: 'Invalid engineSeries', status: 400 },
  )
  assertEquals(
    parseManagedVersionSelection('postgres', { imageVariant: false }),
    { ok: false, error: 'Invalid imageVariant', status: 400 },
  )
})

test('mergeCreateSettings applies a resolved catalog image', () => {
  const merged = mergeCreateSettings(
    postgresEngineSpec,
    { exposure: { enabled: true, scope: 'datacenter' } },
    'docker.io/library/postgres:18',
  )
  if (!merged) throw new TypeError('expected merged settings')
  assertEquals(merged.image, 'docker.io/library/postgres:18')
  assertEquals(merged.exposure.scope, 'datacenter')

  // An image outside the engine allowlist is rejected by parseSettings.
  assertEquals(
    mergeCreateSettings(postgresEngineSpec, {}, 'docker.io/library/mysql:9.7'),
    null,
  )
  // An untested series never reaches settings — the gate is in the parser too.
  assertEquals(
    mergeCreateSettings(
      postgresEngineSpec,
      {},
      'docker.io/library/postgres:17-alpine',
    ),
    null,
  )
})

test('assertManagedSeriesUnchanged allows variant swaps only', () => {
  const base = postgresEngineSpec.parseSettings({})
  if (!base) throw new TypeError('expected default settings')

  // Same series, different base OS → allowed.
  assertEquals(
    assertManagedSeriesUnchanged(postgresEngineSpec, base, {
      ...base,
      image: 'docker.io/library/postgres:18',
    }),
    null,
  )
  // Unset image compares against the spec default, so this is still series 18.
  assertEquals(
    assertManagedSeriesUnchanged(postgresEngineSpec, base, base),
    null,
  )
  // Different series → 409, even from the implicit default.
  assertEquals(
    assertManagedSeriesUnchanged(postgresEngineSpec, base, {
      ...base,
      image: 'docker.io/library/postgres:17-alpine',
    }),
    { ok: false, error: MANAGED_SERIES_IMMUTABLE_ERROR, status: 409 },
  )
})

test('buildManagedReleaseView derives catalog identity from the image', () => {
  const base = postgresEngineSpec.parseSettings({})
  if (!base) throw new TypeError('expected default settings')

  assertEquals(buildManagedReleaseView(postgresEngineSpec, base), {
    series: '18',
    variantId: 'alpine',
    lifecycle: 'supported',
    tested: true,
    image: 'docker.io/library/postgres:18-alpine',
  })
  // A row written while 16 was still offered still renders — flagged untested.
  assertEquals(
    buildManagedReleaseView(postgresEngineSpec, {
      ...base,
      image: 'docker.io/library/postgres:16',
    }),
    {
      series: '16',
      variantId: 'debian',
      lifecycle: 'supported',
      tested: false,
      image: 'docker.io/library/postgres:16',
    },
  )
  // Outside the catalog (e.g. a series retired after the row was written).
  assertEquals(
    buildManagedReleaseView(postgresEngineSpec, {
      ...base,
      image: 'docker.io/library/postgres:14',
    }),
    null,
  )
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

test('readInitialDatabase for MySQL/MariaDB defaults to appdb, not system schemas', async () => {
  const { mysqlEngineSpec } = await import('../../lib/managed/mysql.ts')
  const { mariadbEngineSpec } = await import('../../lib/managed/mariadb.ts')
  assertEquals(readInitialDatabase(mysqlEngineSpec), 'appdb')
  assertEquals(readInitialDatabase(mariadbEngineSpec), 'appdb')
})

test('resolveManagedServerId prefers managed.server_id over environment placement', () => {
  assertEquals(
    resolveManagedServerId({ serverId: 'managed-pin' }, 'env-pin'),
    'managed-pin',
  )
  assertEquals(
    resolveManagedServerId({ serverId: null }, 'env-pin'),
    'env-pin',
  )
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
    // Absent metadata role → the writer hostgroup, never an implicit reader.
    connectionRole: 'read-write',
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

test('parseManagedUserCreateFields accepts valid postgres user input', () => {
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
    connectionRole: 'read-write',
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
  if (!(unknownDb instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(unknownDb.status, 400)
  assertEquals(await unknownDb.json(), { error: 'Invalid request' })

  const badPrivilege = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    {
      username: 'app_user',
      databases: ['postgres'],
      privileges: ['superuser'],
    },
    options,
  )
  if (!(badPrivilege instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(badPrivilege.status, 400)
})

test('parseManagedUserCreateFields rejects empty databases and non-string entries', () => {
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
