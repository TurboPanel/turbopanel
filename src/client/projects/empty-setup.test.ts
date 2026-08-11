import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from '../authn/secrets.ts'
import type { Db } from '../../db.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
  DEFAULT_PRODUCTION_ENVIRONMENT_NAME,
  configureProjectType,
  ensureProductionEnvironment,
  insertEmptyProject,
  isConfiguredProjectType,
  isProductionEnvironmentName,
  loadDefaultEnvironmentName,
  projectNeedsSetup,
} from './empty-setup.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function thenableValue<T>(value: T) {
  const promise = Promise.resolve(value)
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function stubSecrets(): DerivedSecretsConfig {
  return {
    current: { version: 1, key: {} as CryptoKey },
    fallbacks: [],
  }
}

async function realDataEncryptionSecrets(): Promise<DerivedSecretsConfig> {
  const config = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  return deriveEncryptionSecretsConfig(config, 'data-encryption')
}

type EnvRow = {
  id: string
  name: string | null
  description?: string | null
  serverId: string | null
}

function createTxStub(opts: {
  envRows?: EnvRow[]
  existingVarKeys?: string[]
  existingExtraEnvIds?: string[]
  insertedEnvId?: string
  insertedProjectId?: string
  onUpdate?: (patch: Record<string, unknown>) => void
  onInsertVariable?: (values: Record<string, unknown>) => void
}): Db {
  const envRows = opts.envRows ?? []
  const existingVarKeys = opts.existingVarKeys ?? []
  const existingExtraEnvIds = opts.existingExtraEnvIds ?? []
  let selectCalls = 0

  return {
    select: () => ({
      from: () => ({
        where: () => {
          selectCalls += 1
          // findProductionEnvironment: first select of environments (no limit)
          if (selectCalls === 1 && envRows.length >= 0) {
            return thenableRows(envRows)
          }
          // applyCatalogVariablesToEnvironment: variable keys
          if (existingVarKeys.length >= 0 && selectCalls === 2) {
            return thenableRows(existingVarKeys.map((key) => ({ key })))
          }
          // insertExtraCatalogEnvironments: existing extra env lookup
          return {
            limit: () =>
              Promise.resolve(
                existingExtraEnvIds.map((id) => ({ id })),
              ),
          }
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        if ('key' in values) {
          opts.onInsertVariable?.(values)
          return thenableValue(undefined)
        }
        const insertedId = 'workspaceId' in values
          ? (opts.insertedProjectId ?? 'proj-new')
          : (opts.insertedEnvId ?? 'env-new')
        const rows = Promise.resolve([{ id: insertedId }])
        // insertEmptyProject awaits values() without .returning() for the
        // environment row; ensureProductionEnvironment / project insert use
        // .returning().
        return {
          returning: () => rows,
          then: rows.then.bind(rows),
          catch: rows.catch.bind(rows),
          finally: rows.finally.bind(rows),
        }
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        opts.onUpdate?.(patch)
        return {
          where: () => thenableValue(undefined),
        }
      },
    }),
  } as unknown as Db
}

function createProjectSelectDb(
  rows: Array<{ id: string; metadata: unknown; options: unknown }>,
  tx?: Db,
  transactionError?: Error,
): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
    transaction: async (fn: (inner: Db) => Promise<unknown>) => {
      if (transactionError) throw transactionError
      return fn(tx ?? createTxStub({
        envRows: [{
          id: 'env-1',
          name: 'Production',
          description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
          serverId: null,
        }],
      }))
    },
  } as unknown as Db
}

function createOrgSelectDb(rows: Array<{ options: unknown }>): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db
}

test('projectNeedsSetup is true when type is absent or empty', () => {
  assertEquals(projectNeedsSetup(null), true)
  assertEquals(projectNeedsSetup(undefined), true)
  assertEquals(projectNeedsSetup({}), true)
  assertEquals(projectNeedsSetup({ type: null }), true)
  assertEquals(projectNeedsSetup({ type: '' }), true)
  assertEquals(projectNeedsSetup({ type: 'empty' }), true)
})

test('projectNeedsSetup is false once a real type is set', () => {
  assertEquals(projectNeedsSetup({ type: 'docker-compose' }), false)
  assertEquals(projectNeedsSetup({ type: 'template', code: 'static-site' }), false)
  assertEquals(projectNeedsSetup({ type: 'managed', code: 'postgres' }), false)
})

test('isConfiguredProjectType accepts only configure targets', () => {
  assertEquals(isConfiguredProjectType('docker-compose'), true)
  assertEquals(isConfiguredProjectType('template'), true)
  assertEquals(isConfiguredProjectType('managed'), true)
  assertEquals(isConfiguredProjectType('empty'), false)
  assertEquals(isConfiguredProjectType('other'), false)
})

test('isProductionEnvironmentName is case-insensitive', () => {
  assertEquals(isProductionEnvironmentName('Production'), true)
  assertEquals(isProductionEnvironmentName('production'), true)
  assertEquals(isProductionEnvironmentName(' PRODUCTION '), true)
  assertEquals(isProductionEnvironmentName('Staging'), false)
  assertEquals(isProductionEnvironmentName(null), false)
  assertEquals(isProductionEnvironmentName(undefined), false)
  assertEquals(isProductionEnvironmentName(''), false)
})

test('loadDefaultEnvironmentName falls back when org is missing', async () => {
  const name = await loadDefaultEnvironmentName(createOrgSelectDb([]), 'org-missing')
  assertEquals(name, DEFAULT_PRODUCTION_ENVIRONMENT_NAME)
})

test('loadDefaultEnvironmentName resolves org options', async () => {
  const name = await loadDefaultEnvironmentName(
    createOrgSelectDb([{ options: { defaultEnvironmentName: ' Staging ' } }]),
    'org-1',
  )
  assertEquals(name, 'Staging')
})

test('loadDefaultEnvironmentName uses platform default when options omit name', async () => {
  const name = await loadDefaultEnvironmentName(
    createOrgSelectDb([{ options: { maxServers: 3 } }]),
    'org-1',
  )
  assertEquals(name, DEFAULT_PRODUCTION_ENVIRONMENT_NAME)
})

test('ensureProductionEnvironment returns existing Production row', async () => {
  const tx = createTxStub({
    envRows: [{
      id: 'env-prod',
      name: 'Production',
      description: 'custom',
      serverId: null,
    }],
  })
  const id = await ensureProductionEnvironment(tx, 'proj-1')
  assertEquals(id, 'env-prod')
})

test('ensureProductionEnvironment prefers literal Production over org default', async () => {
  const tx = createTxStub({
    envRows: [
      {
        id: 'env-staging',
        name: 'Staging',
        description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
        serverId: null,
      },
      {
        id: 'env-prod',
        name: 'production',
        description: null,
        serverId: null,
      },
    ],
  })
  const id = await ensureProductionEnvironment(
    tx,
    'proj-1',
    null,
    'Staging',
  )
  assertEquals(id, 'env-prod')
})

test('ensureProductionEnvironment matches org default name', async () => {
  const tx = createTxStub({
    envRows: [{
      id: 'env-staging',
      name: 'Staging',
      description: 'other',
      serverId: null,
    }],
  })
  const id = await ensureProductionEnvironment(
    tx,
    'proj-1',
    null,
    'Staging',
  )
  assertEquals(id, 'env-staging')
})

test('ensureProductionEnvironment reuses sole scaffold row', async () => {
  const tx = createTxStub({
    envRows: [{
      id: 'env-only',
      name: 'Old Default',
      description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
      serverId: null,
    }],
  })
  const id = await ensureProductionEnvironment(
    tx,
    'proj-1',
    null,
    'New Default',
  )
  assertEquals(id, 'env-only')
})

test('ensureProductionEnvironment matches scaffold description among many', async () => {
  const tx = createTxStub({
    envRows: [
      {
        id: 'env-a',
        name: 'Alpha',
        description: 'custom',
        serverId: null,
      },
      {
        id: 'env-scaffold',
        name: 'Beta',
        description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
        serverId: null,
      },
    ],
  })
  const id = await ensureProductionEnvironment(
    tx,
    'proj-1',
    null,
    'Gamma',
  )
  assertEquals(id, 'env-scaffold')
})

test('ensureProductionEnvironment inserts when nothing matches', async () => {
  const tx = createTxStub({
    envRows: [
      {
        id: 'env-a',
        name: 'Alpha',
        description: 'custom',
        serverId: null,
      },
      {
        id: 'env-b',
        name: 'Beta',
        description: 'other',
        serverId: null,
      },
    ],
    insertedEnvId: 'env-inserted',
  })
  const id = await ensureProductionEnvironment(
    tx,
    'proj-1',
    'srv-1',
    'Production',
  )
  assertEquals(id, 'env-inserted')
})

test('ensureProductionEnvironment normalizes casing and pins server', async () => {
  const patches: Record<string, unknown>[] = []
  const tx = createTxStub({
    envRows: [{
      id: 'env-prod',
      name: 'production',
      description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
      serverId: 'srv-old',
    }],
    onUpdate: (patch) => {
      patches.push(patch)
    },
  })
  const id = await ensureProductionEnvironment(
    tx,
    'proj-1',
    'srv-new',
    'Production',
  )
  assertEquals(id, 'env-prod')
  assertEquals(patches.length, 1)
  assertEquals(patches[0]?.name, 'Production')
  assertEquals(patches[0]?.serverId, 'srv-new')
})

test('ensureProductionEnvironment skips update when already matching', async () => {
  let updated = false
  const tx = createTxStub({
    envRows: [{
      id: 'env-prod',
      name: 'Production',
      description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
      serverId: 'srv-1',
    }],
    onUpdate: () => {
      updated = true
    },
  })
  const id = await ensureProductionEnvironment(
    tx,
    'proj-1',
    'srv-1',
    'Production',
  )
  assertEquals(id, 'env-prod')
  assertEquals(updated, false)
})

test('insertEmptyProject inserts project and environment', async () => {
  const tx = createTxStub({ insertedProjectId: 'proj-created' })
  const id = await insertEmptyProject(tx, {
    name: 'App',
    description: 'desc',
    workspaceId: 'ws-1',
    serverId: 'srv-1',
  })
  assertEquals(id, 'proj-created')
})

test('insertEmptyProject uses custom default environment name', async () => {
  const tx = createTxStub({ insertedProjectId: 'proj-custom' })
  const id = await insertEmptyProject(tx, {
    name: null,
    description: null,
    workspaceId: 'ws-1',
    serverId: null,
    defaultEnvironmentName: 'Staging',
  })
  assertEquals(id, 'proj-custom')
})

test('configureProjectType returns not found when project missing', async () => {
  const result = await configureProjectType(createProjectSelectDb([]), {
    projectId: 'missing',
    projectType: 'docker-compose',
    dataEncryptionSecrets: stubSecrets(),
  })
  assertEquals(result, { ok: false, error: 'Not found', status: 400 })
})

test('configureProjectType is idempotent for matching docker-compose', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{
      id: 'p1',
      metadata: { type: 'docker-compose' },
      options: {},
    }]),
    {
      projectId: 'p1',
      projectType: 'docker-compose',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, { ok: true, alreadyConfigured: true })
})

test('configureProjectType rejects changing configured type', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{
      id: 'p1',
      metadata: { type: 'docker-compose' },
      options: {},
    }]),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'static-site',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, {
    ok: false,
    error: 'Project type already configured',
    status: 409,
  })
})

test('configureProjectType rejects catalog code mismatch when already set', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{
      id: 'p1',
      metadata: { type: 'template', code: 'static-site' },
      options: {},
    }]),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'wordpress-mysql',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, {
    ok: false,
    error: 'Project type already configured',
    status: 409,
  })
})

test('configureProjectType is idempotent for matching template code', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{
      id: 'p1',
      metadata: { type: 'template', code: 'static-site' },
      options: {},
    }]),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'static-site',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, { ok: true, alreadyConfigured: true })
})

test('configureProjectType is idempotent for matching managed code', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{
      id: 'p1',
      metadata: { type: 'managed', code: 'postgres' },
      options: {},
    }]),
    {
      projectId: 'p1',
      projectType: 'managed',
      catalogCode: 'postgres',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, { ok: true, alreadyConfigured: true })
})

test('configureProjectType requires catalogCode for template/managed', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: null, options: null }]),
    {
      projectId: 'p1',
      projectType: 'template',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, { ok: false, error: 'Invalid request', status: 400 })
})

test('configureProjectType requires encryption secrets for catalog types', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: { type: 'empty' }, options: null }]),
    {
      projectId: 'p1',
      projectType: 'managed',
      catalogCode: 'postgres',
      dataEncryptionSecrets: undefined,
    },
  )
  assertEquals(result, {
    ok: false,
    error: 'Encryption unavailable',
    status: 503,
  })
})

test('configureProjectType rejects unknown catalog code', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: {}, options: null }]),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'does-not-exist',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, { ok: false, error: 'Unknown catalog code', status: 400 })
})

test('configureProjectType rejects catalog kind mismatch', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: null, options: null }]),
    {
      projectId: 'p1',
      projectType: 'managed',
      catalogCode: 'static-site',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, { ok: false, error: 'Unknown catalog code', status: 400 })
})

test('configureProjectType configures docker-compose via transaction', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: null, options: null }]),
    {
      projectId: 'p1',
      projectType: 'docker-compose',
      dataEncryptionSecrets: stubSecrets(),
      serverId: 'srv-1',
    },
  )
  assertEquals(result, { ok: true, alreadyConfigured: false })
})

test('configureProjectType configures static-site template', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: {}, options: null }]),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'static-site',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, { ok: true, alreadyConfigured: false })
})

test('configureProjectType configures managed postgres with secret vars', async () => {
  const secrets = await realDataEncryptionSecrets()
  const insertedVars: Record<string, unknown>[] = []
  const tx = createTxStub({
    envRows: [{
      id: 'env-1',
      name: 'Production',
      description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
      serverId: null,
    }],
    existingVarKeys: [],
    onInsertVariable: (values) => {
      insertedVars.push(values)
    },
  })
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: null, options: null }], tx),
    {
      projectId: 'p1',
      projectType: 'managed',
      catalogCode: 'postgres',
      dataEncryptionSecrets: secrets,
      serverId: 'srv-1',
    },
  )
  assertEquals(result, { ok: true, alreadyConfigured: false })
  assertEquals(insertedVars.length, 1)
  assertEquals(insertedVars[0]?.key, 'POSTGRES_PASSWORD')
  assertEquals(insertedVars[0]?.isSecret, true)
  if (typeof insertedVars[0]?.value !== 'string') {
    throw new TypeError('expected sealed secret string')
  }
  assertEquals(insertedVars[0].value.startsWith('tpsecret.'), true)
})

test('configureProjectType skips existing catalog variable keys', async () => {
  const secrets = await realDataEncryptionSecrets()
  const insertedVars: Record<string, unknown>[] = []
  const tx = createTxStub({
    envRows: [{
      id: 'env-1',
      name: 'Production',
      description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
      serverId: null,
    }],
    existingVarKeys: ['POSTGRES_PASSWORD'],
    onInsertVariable: (values) => {
      insertedVars.push(values)
    },
  })
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: { type: '' }, options: null }], tx),
    {
      projectId: 'p1',
      projectType: 'managed',
      catalogCode: 'postgres',
      dataEncryptionSecrets: secrets,
    },
  )
  assertEquals(result, { ok: true, alreadyConfigured: false })
  assertEquals(insertedVars.length, 0)
})

test('configureProjectType maps encryption unavailable from transaction', async () => {
  const result = await configureProjectType(
    createProjectSelectDb(
      [{ id: 'p1', metadata: null, options: null }],
      undefined,
      new Error('encryption unavailable'),
    ),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'static-site',
      dataEncryptionSecrets: stubSecrets(),
    },
  )
  assertEquals(result, {
    ok: false,
    error: 'Encryption unavailable',
    status: 503,
  })
})

test('configureProjectType rethrows unrelated transaction errors', async () => {
  await assertRejects(
    () =>
      configureProjectType(
        createProjectSelectDb(
          [{ id: 'p1', metadata: null, options: null }],
          undefined,
          new Error('disk full'),
        ),
        {
          projectId: 'p1',
          projectType: 'template',
          catalogCode: 'static-site',
          dataEncryptionSecrets: stubSecrets(),
        },
      ),
    Error,
    'disk full',
  )
})

test('configureProjectType configures wordpress template with entry options', async () => {
  const secrets = await realDataEncryptionSecrets()
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: null, options: null }]),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'wordpress-mysql',
      dataEncryptionSecrets: secrets,
      defaultEnvironmentName: 'Production',
    },
  )
  assertEquals(result, { ok: true, alreadyConfigured: false })
})
