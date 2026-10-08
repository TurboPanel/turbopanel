import { assertEquals, assertStringIncludes } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { mysqlEngineSpec } from './mysql.ts'
import { postgresEngineSpec } from './postgres.ts'
import { isManagedVariantSwapSafe } from './releases.ts'
import type { ManagedContext } from '../../client/managed/context.ts'
import type { ManagedRowOptions } from './options.ts'
import {
  assertManagedImageChangeAllowed,
  assertManagedSeriesUnchanged,
  assertManagedVariantSwapSafe,
  buildManagedReleaseView,
  isManagedRootPrincipal,
  isPlainObject,
  MANAGED_SERIES_IMMUTABLE_ERROR,
  MANAGED_USER_PRIVILEGES_INVALID_ERROR,
  MANAGED_VARIANT_SWAP_UNSAFE_ERROR,
  MANAGED_VERSION_UNSUPPORTED_ERROR,
  managedSessionPaths,
  mergeCreateSettings,
  parseManagedPatchName,
  parseManagedUserCreateFields,
  parseManagedVersionSelection,
  principalMetadata,
  readInitialDatabase,
  resolveManagedServerId,
  resolveManagedUserPrivileges,
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

function mockManagedContext(overrides: Partial<ManagedContext> = {}): ManagedContext {
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
  const settings = postgresEngineSpec.parseSettings(postgresEngineSpec.defaultSettings)
  if (!settings) throw new TypeError('expected default postgres settings')
  return { settings, databases: ['postgres'] }
}

test('isPlainObject accepts records only', () => {
  assertEquals(isPlainObject({ a: 1 }), true)
  assertEquals(isPlainObject(null), false)
  assertEquals(isPlainObject([]), false)
  assertEquals(isPlainObject('x'), false)
})

test('managedSessionPaths lists every managed session route', () => {
  const paths = managedSessionPaths()
  assertEquals(paths.length, 24)
  assertEquals(paths.includes('/environments/:id/managed/logs'), true)
  assertEquals(paths.includes('/environments/:id/managed/backup-policies'), true)
  assertEquals(paths.includes('/environments/:id/managed/backup-policies/:policyId'), true)
  assertEquals(paths.includes('/environments/:id/managed/backup-policies/:policyId/runs'), true)
  assertEquals(paths.includes('/environments/:id/managed/members/:memberId/promote'), true)
  assertEquals(paths.includes('/environments/:id/managed/members/:memberId/resync'), true)
  assertEquals(paths.includes('/environments/:id/managed/disaster-recovery/promote'), true)
  assertEquals(paths.includes('/organizations/:id/managed'), true)
  assertEquals(paths.includes('/servers/:id/managed-external-access'), true)
})

test('mergeCreateSettings returns the engine defaults', () => {
  const merged = mergeCreateSettings(postgresEngineSpec)
  if (!merged) throw new TypeError('expected merged settings')
  assertEquals(merged, postgresEngineSpec.parseSettings(postgresEngineSpec.defaultSettings))
})

test('parseManagedVersionSelection resolves a catalog series and variant', () => {
  // Omitted → engine spec default image.
  assertEquals(parseManagedVersionSelection('postgres', {}), { ok: true })

  assertEquals(parseManagedVersionSelection('postgres', { engineSeries: '18' }), {
    ok: true,
    image: 'docker.io/library/postgres:18-alpine',
  })
  assertEquals(
    parseManagedVersionSelection('postgres', {
      engineSeries: '18',
      imageVariant: 'debian',
    }),
    { ok: true, image: 'docker.io/library/postgres:18' }
  )
  // Variant alone applies to the default series.
  assertEquals(parseManagedVersionSelection('postgres', { imageVariant: 'debian' }), {
    ok: true,
    image: 'docker.io/library/postgres:18',
  })
})

test('create accepts only the three verified series', () => {
  // The only creatable series per engine, both of their base-OS variants.
  assertEquals(parseManagedVersionSelection('mysql', { engineSeries: '9.7' }), {
    ok: true,
    image: 'docker.io/library/mysql:9.7',
  })
  assertEquals(
    parseManagedVersionSelection('mysql', {
      engineSeries: '9.7',
      imageVariant: 'oraclelinux9',
    }),
    { ok: true, image: 'docker.io/library/mysql:9.7-oraclelinux9' }
  )
  assertEquals(parseManagedVersionSelection('mariadb', { engineSeries: '12.3' }), {
    ok: true,
    image: 'docker.io/library/mariadb:12.3',
  })

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
      `${engine} ${series} must not be creatable`
    )
  }
})

test('the explicit gate is the only way to create an untested series', () => {
  assertEquals(
    parseManagedVersionSelection('postgres', { engineSeries: '17' }, { includeUntested: true }),
    { ok: true, image: 'docker.io/library/postgres:17-alpine' }
  )
  assertEquals(
    parseManagedVersionSelection(
      'mysql',
      { engineSeries: '8.4', imageVariant: 'oraclelinux9' },
      { includeUntested: true }
    ),
    { ok: true, image: 'docker.io/library/mysql:8.4-oraclelinux9' }
  )
  // The gate widens the catalog, it does not disable validation.
  assertEquals(
    parseManagedVersionSelection('postgres', { engineSeries: '14' }, { includeUntested: true }),
    { ok: false, error: MANAGED_VERSION_UNSUPPORTED_ERROR, status: 422 }
  )
})

test('parseManagedVersionSelection rejects unknown versions and bad types', () => {
  assertEquals(parseManagedVersionSelection('postgres', { engineSeries: '14' }), {
    ok: false,
    error: MANAGED_VERSION_UNSUPPORTED_ERROR,
    status: 422,
  })
  assertEquals(parseManagedVersionSelection('mysql', { engineSeries: '8.0' }), {
    ok: false,
    error: MANAGED_VERSION_UNSUPPORTED_ERROR,
    status: 422,
  })
  assertEquals(parseManagedVersionSelection('postgres', { imageVariant: 'ubi' }), {
    ok: false,
    error: MANAGED_VERSION_UNSUPPORTED_ERROR,
    status: 422,
  })
  // Engine with no catalog cannot resolve a default series.
  assertEquals(parseManagedVersionSelection('redis', { engineSeries: '7' }), {
    ok: false,
    error: MANAGED_VERSION_UNSUPPORTED_ERROR,
    status: 422,
  })
  assertEquals(parseManagedVersionSelection('postgres', { engineSeries: 18 }), {
    ok: false,
    error: 'Invalid engineSeries',
    status: 400,
  })
  assertEquals(parseManagedVersionSelection('postgres', { imageVariant: false }), {
    ok: false,
    error: 'Invalid imageVariant',
    status: 400,
  })
})

test('mergeCreateSettings applies a resolved catalog image', () => {
  const merged = mergeCreateSettings(postgresEngineSpec, 'docker.io/library/postgres:18')
  if (!merged) throw new TypeError('expected merged settings')
  assertEquals(merged.image, 'docker.io/library/postgres:18')

  // An image outside the engine allowlist is rejected by parseSettings.
  assertEquals(mergeCreateSettings(postgresEngineSpec, 'docker.io/library/mysql:9.7'), null)
  // An untested series never reaches settings — the gate is in the parser too.
  assertEquals(
    mergeCreateSettings(postgresEngineSpec, 'docker.io/library/postgres:17-alpine'),
    null
  )
})

test('assertManagedSeriesUnchanged judges the series only', () => {
  const base = postgresEngineSpec.parseSettings({})
  if (!base) throw new TypeError('expected default settings')

  // Same series, different base OS: not this guard's concern.
  assertEquals(
    assertManagedSeriesUnchanged(postgresEngineSpec, base, {
      ...base,
      image: 'docker.io/library/postgres:18',
    }),
    null
  )
  // Unset image compares against the spec default, so this is still series 18.
  assertEquals(assertManagedSeriesUnchanged(postgresEngineSpec, base, base), null)
  // Different series -> 409, even from the implicit default.
  const refused = assertManagedSeriesUnchanged(postgresEngineSpec, base, {
    ...base,
    image: 'docker.io/library/postgres:17-alpine',
  })
  assertEquals(refused?.error, MANAGED_SERIES_IMMUTABLE_ERROR)
  assertEquals(refused?.status, 409)
  assertEquals(typeof refused?.message, 'string')
})

test('isManagedVariantSwapSafe refuses only PostgreSQL moves between libc families', () => {
  const alpine = 'docker.io/library/postgres:18-alpine'
  const debian = 'docker.io/library/postgres:18'
  // The proven-unsafe swap, both directions, and across series too.
  assertEquals(isManagedVariantSwapSafe(alpine, debian), false)
  assertEquals(isManagedVariantSwapSafe(debian, alpine), false)
  assertEquals(isManagedVariantSwapSafe(alpine, 'docker.io/library/postgres:17'), false)
  // A no-op or an unset side is never refused.
  assertEquals(isManagedVariantSwapSafe(alpine, alpine), true)
  assertEquals(isManagedVariantSwapSafe(debian, debian), true)
  assertEquals(isManagedVariantSwapSafe(undefined, debian), true)
  assertEquals(isManagedVariantSwapSafe(alpine, undefined), true)
  // Engines with their own collations may change variant.
  assertEquals(
    isManagedVariantSwapSafe(
      'docker.io/library/mysql:9.7',
      'docker.io/library/mysql:9.7-oraclelinux9'
    ),
    true
  )
  assertEquals(
    isManagedVariantSwapSafe(
      'docker.io/library/mariadb:12.3-ubi',
      'docker.io/library/mariadb:12.3'
    ),
    true
  )
  // Images outside the catalog are the series guard's business, not this one's.
  assertEquals(isManagedVariantSwapSafe(alpine, 'example.com/other:1'), true)
  assertEquals(isManagedVariantSwapSafe('example.com/other:1', debian), true)
})

test('assertManagedVariantSwapSafe returns a 409 with the unsafe-swap code', () => {
  const base = postgresEngineSpec.parseSettings({})
  if (!base) throw new TypeError('expected default settings')

  // Default image is the alpine variant of series 18.
  const refused = assertManagedVariantSwapSafe(postgresEngineSpec, base, {
    ...base,
    image: 'docker.io/library/postgres:18',
  })
  assertEquals(refused?.ok, false)
  assertEquals(refused?.error, MANAGED_VARIANT_SWAP_UNSAFE_ERROR)
  assertEquals(refused?.status, 409)
  assertEquals(refused?.message.includes('restore a backup'), true)
  // Unchanged settings, and an unset image, pass.
  assertEquals(assertManagedVariantSwapSafe(postgresEngineSpec, base, base), null)
  assertEquals(
    assertManagedVariantSwapSafe(postgresEngineSpec, base, {
      ...base,
      image: 'docker.io/library/postgres:18-alpine',
    }),
    null
  )
})

test('assertManagedImageChangeAllowed reports the series refusal before the variant one', () => {
  const base = postgresEngineSpec.parseSettings({})
  if (!base) throw new TypeError('expected default settings')

  // Series 17 debian is both another series and another variant: series wins.
  assertEquals(
    assertManagedImageChangeAllowed(postgresEngineSpec, base, {
      ...base,
      image: 'docker.io/library/postgres:17',
    })?.error,
    MANAGED_SERIES_IMMUTABLE_ERROR
  )
  assertEquals(
    assertManagedImageChangeAllowed(postgresEngineSpec, base, {
      ...base,
      image: 'docker.io/library/postgres:18',
    })?.error,
    MANAGED_VARIANT_SWAP_UNSAFE_ERROR
  )
  assertEquals(assertManagedImageChangeAllowed(postgresEngineSpec, base, base), null)
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
    }
  )
  // Outside the catalog (e.g. a series retired after the row was written).
  assertEquals(
    buildManagedReleaseView(postgresEngineSpec, {
      ...base,
      image: 'docker.io/library/postgres:14',
    }),
    null
  )
})

test('readInitialDatabase defaults to defaultdb and honors engine initialDatabase', () => {
  assertEquals(readInitialDatabase(postgresEngineSpec), 'defaultdb')

  const customSpec = {
    ...postgresEngineSpec,
    defaultSettings: {
      ...postgresEngineSpec.defaultSettings,
      initialDatabase: 'appdb',
    },
  }
  assertEquals(readInitialDatabase(customSpec), 'appdb')
})

test('readInitialDatabase for MySQL/MariaDB defaults to defaultdb, not system schemas', async () => {
  const { mysqlEngineSpec } = await import('./mysql.ts')
  const { mariadbEngineSpec } = await import('./mariadb.ts')
  assertEquals(readInitialDatabase(mysqlEngineSpec), 'defaultdb')
  assertEquals(readInitialDatabase(mariadbEngineSpec), 'defaultdb')
})

test('resolveManagedServerId prefers managed.server_id over environment placement', () => {
  assertEquals(resolveManagedServerId({ serverId: 'managed-pin' }, 'env-pin'), 'managed-pin')
  assertEquals(resolveManagedServerId({ serverId: null }, 'env-pin'), 'env-pin')
  assertEquals(resolveManagedServerId({ serverId: null }, null), null)
})

test('principalMetadata and isManagedRootPrincipal', () => {
  assertEquals(principalMetadata(null), {})
  assertEquals(principalMetadata([1]), {})
  assertEquals(principalMetadata({ managedRoot: true, databases: ['postgres'] }), {
    managedRoot: true,
    databases: ['postgres'],
  })
  assertEquals(isManagedRootPrincipal({ managedRoot: true }), true)
  assertEquals(isManagedRootPrincipal({ managedRoot: false }), false)
  assertEquals(isManagedRootPrincipal(undefined), false)
})

test('serializeManagedUser filters databases and privileges to strings', () => {
  const serialized = serializeManagedUser({
    id: 'prin-1',
    username: 'app_user',
    appliedUsername: 'app_user_ab12cd34ef5',
    metadata: {
      databases: ['postgres', 42, 'app'],
      privileges: ['read-only', null],
    },
    createdAt: '2024-01-01T00:00:00.000Z',
  })
  assertEquals(serialized, {
    id: 'prin-1',
    username: 'app_user',
    appliedUsername: 'app_user_ab12cd34ef5',
    // Legacy row (no stored scheme): a suffixed name reads as partial.
    nameScheme: 'partial',
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
    defaultRowOptions()
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
    options
  )
  if (!(root instanceof Response)) throw new TypeError('expected Response')
  assertEquals(root.status, 400)
  assertEquals(await root.json(), { error: 'Invalid username' })

  const badName = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    { username: 'bad name!', databases: ['postgres'] },
    options
  )
  if (!(badName instanceof Response)) throw new TypeError('expected Response')
  assertEquals(badName.status, 400)

  // Reserved platform-internal names stay rejected even when the exposed
  // root login is a suffixed name that no longer equals them.
  for (const reserved of ['postgres', 'root', 'mysql', 'superadmin', 'Root']) {
    const res = parseManagedUserCreateFields(
      c,
      mockManagedContext(),
      { username: reserved, databases: ['postgres'] },
      options,
      'postgres_a1b2c3d4'
    )
    if (!(res instanceof Response)) throw new TypeError('expected Response')
    assertEquals(res.status, 400)
    assertEquals(await res.json(), { error: 'Invalid username' })
  }
})

test('parseManagedUserCreateFields refuses a system schema listed by an older cluster', async () => {
  const c = mockContext()
  const settings = mysqlEngineSpec.parseSettings(mysqlEngineSpec.defaultSettings)
  if (!settings) throw new TypeError('expected default mysql settings')
  const options: ManagedRowOptions = { settings, databases: ['defaultdb', 'mysql'] }
  const ctx = mockManagedContext({ spec: mysqlEngineSpec, catalogCode: 'mysql' })

  const res = parseManagedUserCreateFields(
    c,
    ctx,
    { username: 'app_user', databases: ['mysql'], privileges: ['read-write'] },
    options
  )
  if (!(res instanceof Response)) throw new TypeError('expected Response')
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'reserved_database_name' })

  const ok = parseManagedUserCreateFields(
    c,
    ctx,
    { username: 'app_user', databases: ['defaultdb'], privileges: ['read-write'] },
    options
  )
  if (ok instanceof Response) throw new TypeError('expected parsed fields')
})

test('parseManagedUserCreateFields reserves suffix room when the scheme is partial', async () => {
  const c = mockContext()
  const options = defaultRowOptions()
  const ctx = mockManagedContext()
  const maxLength = ctx.spec.userOperations.identifier.maxLength
  // Longest short name that still fits `_<11>` inside the engine limit.
  const longest = `u${'a'.repeat(maxLength - 13)}`

  const ok = parseManagedUserCreateFields(
    c,
    ctx,
    { username: longest, databases: ['postgres'] },
    options,
    undefined,
    'partial'
  )
  if (ok instanceof Response) throw new TypeError('expected fields')
  assertEquals(ok.username, longest)

  const tooLong = `u${'a'.repeat(maxLength - 12)}`
  const rejected = parseManagedUserCreateFields(
    c,
    ctx,
    { username: tooLong, databases: ['postgres'] },
    options,
    undefined,
    'partial'
  )
  if (!(rejected instanceof Response)) throw new TypeError('expected Response')
  assertEquals(rejected.status, 400)

  // Without the suffix (plain/random) the full engine limit applies.
  const bare = parseManagedUserCreateFields(
    c,
    ctx,
    { username: tooLong, databases: ['postgres'] },
    options,
    undefined,
    'random'
  )
  if (bare instanceof Response) throw new TypeError('expected fields')
  assertEquals(bare.username, tooLong)
})

test('parseManagedUserCreateFields rejects unknown databases and privileges', async () => {
  const c = mockContext()
  const options = defaultRowOptions()

  const unknownDb = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    { username: 'app_user', databases: ['missing'] },
    options
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
    options
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
    options
  )
  if (!(empty instanceof Response)) throw new TypeError('expected Response')
  assertEquals(empty.status, 400)

  const mixed = parseManagedUserCreateFields(
    c,
    mockManagedContext(),
    { username: 'app_user', databases: ['postgres', 1] },
    options
  )
  if (!(mixed instanceof Response)) throw new TypeError('expected Response')
  assertEquals(mixed.status, 400)
})

test('a new login with no privileges named gets the grant that matches its connection role', () => {
  const c = mockContext()
  const options = defaultRowOptions()
  const ctx = mockManagedContext()
  for (const [connectionRole, expected] of [
    [undefined, ['read-write']],
    ['read-write', ['read-write']],
    ['read-only', ['read-only']],
  ] as const) {
    const fields = parseManagedUserCreateFields(
      c,
      ctx,
      { username: 'app_user', databases: ['postgres'], connectionRole },
      options
    )
    if (fields instanceof Response) throw new TypeError('expected parsed fields')
    assertEquals(fields.privileges, [...expected])
  }
})

test('named privileges are kept, de-duplicated, and an empty or unknown list is refused in plain words', async () => {
  const c = mockContext()
  const options = defaultRowOptions()
  const ctx = mockManagedContext()
  const ok = parseManagedUserCreateFields(
    c,
    ctx,
    { username: 'app_user', databases: ['postgres'], privileges: ['owner', 'owner'] },
    options
  )
  if (ok instanceof Response) throw new TypeError('expected parsed fields')
  assertEquals(ok.privileges, ['owner'])

  for (const privileges of [[], ['superuser'], 'owner', [1]]) {
    const res = parseManagedUserCreateFields(
      c,
      ctx,
      { username: 'app_user', databases: ['postgres'], privileges },
      options
    )
    if (!(res instanceof Response)) throw new TypeError('expected Response')
    assertEquals(res.status, 400)
    const body = (await res.json()) as { error: string; message: string }
    assertEquals(body.error, MANAGED_USER_PRIVILEGES_INVALID_ERROR)
    assertStringIncludes(body.message, 'owner, read-write, read-only')
  }
})

test('MySQL and MariaDB logins get the same privilege default as PostgreSQL', () => {
  const allowed = mysqlEngineSpec.userOperations.privileges
  assertEquals(resolveManagedUserPrivileges(undefined, allowed, 'read-write'), ['read-write'])
  assertEquals(resolveManagedUserPrivileges(null, allowed, 'read-only'), ['read-only'])
  assertEquals(resolveManagedUserPrivileges([], allowed, 'read-write'), null)
})

test('PATCH name: absent leaves it, null clears it, a string is validated', () => {
  assertEquals(parseManagedPatchName({}), { ok: true, name: undefined })
  assertEquals(parseManagedPatchName({ name: null }), { ok: true, name: null })
  assertEquals(parseManagedPatchName({ name: '  Orders DB ' }), { ok: true, name: 'Orders DB' })
  const bad = parseManagedPatchName({ name: 42 })
  assertEquals(bad.ok, false)
})
