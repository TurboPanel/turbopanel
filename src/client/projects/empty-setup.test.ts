import { assertEquals, assertRejects } from '@std/assert'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { Db } from '../../db/connection.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
  DEFAULT_PRODUCTION_ENVIRONMENT_NAME,
  configureProjectType,
  ensurePrimaryEnvironment,
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

type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

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

function realDataEncryptionSecrets(): Promise<DerivedSecretsConfig> {
  const config = parseTestSecretsConfig('deno')
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
  onInsertEnvironment?: (values: Record<string, unknown>) => void
  onWatchSync?: () => void
}): DbTx {
  const envRows = opts.envRows ?? []
  const existingVarKeys = opts.existingVarKeys ?? []
  const existingExtraEnvIds = opts.existingExtraEnvIds ?? []
  let selectCalls = 0

  return {
    select: () => ({
      from: () => ({
        where: () => {
          selectCalls += 1
          // loadPrimaryEnvironment: first select of environments
          if (selectCalls === 1) {
            return thenableRows(envRows)
          }
          // Later selects: the compose options of the primary row and the
          // extra-environment lookup (both end in `.limit()`), and the variable
          // keys (awaited directly).
          const keys = Promise.resolve(existingVarKeys.map((key) => ({ key })))
          return {
            limit: () => Promise.resolve(existingExtraEnvIds.map((id) => ({ id }))),
            then: keys.then.bind(keys),
            catch: keys.catch.bind(keys),
            finally: keys.finally.bind(keys),
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
        if ('projectId' in values && 'name' in values) opts.onInsertEnvironment?.(values)
        const insertedId =
          'workspaceId' in values
            ? (opts.insertedProjectId ?? 'proj-new')
            : (opts.insertedEnvId ?? 'env-new')
        const rows = Promise.resolve([{ id: insertedId }])
        // insertEmptyProject awaits values() without .returning() for the
        // environment row; ensurePrimaryEnvironment / project insert use
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
    // The watch sync after an options write (`syncEnvironmentWatch` / `syncProjectWatch`).
    execute: () => {
      opts.onWatchSync?.()
      return Promise.resolve([])
    },
  } as unknown as DbTx
}

function createProjectSelectDb(
  rows: Array<{ id: string; metadata: unknown; options: unknown }>,
  tx?: DbTx,
  transactionError?: Error
): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
    transaction: (fn: (inner: DbTx) => Promise<unknown>) => {
      if (transactionError) throw transactionError
      return fn(
        tx ??
          createTxStub({
            envRows: [
              {
                id: 'env-1',
                name: 'Production',
                description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
                serverId: null,
              },
            ],
          })
      )
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
  assertEquals(projectNeedsSetup({ type: 'template', code: 'custom-template' }), false)
  assertEquals(projectNeedsSetup({ type: 'managed', code: 'postgres' }), false)
  assertEquals(projectNeedsSetup({ type: 'system' }), false)
})

test('isConfiguredProjectType accepts only configure targets', () => {
  assertEquals(isConfiguredProjectType('docker-compose'), true)
  assertEquals(isConfiguredProjectType('template'), true)
  assertEquals(isConfiguredProjectType('managed'), true)
  assertEquals(isConfiguredProjectType('empty'), false)
  assertEquals(isConfiguredProjectType('system'), false)
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
    createOrgSelectDb([{ options: { defaultEnvironmentName: ' staging ' } }]),
    'org-1'
  )
  assertEquals(name, 'staging')
})

test('loadDefaultEnvironmentName uses platform default when options omit name', async () => {
  const name = await loadDefaultEnvironmentName(
    createOrgSelectDb([{ options: { maxServers: 3 } }]),
    'org-1'
  )
  assertEquals(name, DEFAULT_PRODUCTION_ENVIRONMENT_NAME)
})

test('ensurePrimaryEnvironment returns the primary row whatever its name', async () => {
  const tx = createTxStub({
    envRows: [{ id: 'env-main', name: 'live', description: 'custom', serverId: null }],
    insertedEnvId: 'env-should-not-insert',
  })
  assertEquals(await ensurePrimaryEnvironment(tx, 'proj-1', null, 'staging'), 'env-main')
})

test('ensurePrimaryEnvironment creates the primary environment when the project has none', async () => {
  const inserted: Record<string, unknown>[] = []
  const tx = createTxStub({
    envRows: [],
    insertedEnvId: 'env-inserted',
    onInsertEnvironment: (values) => inserted.push(values),
  })
  assertEquals(await ensurePrimaryEnvironment(tx, 'proj-1', 'srv-1', 'staging'), 'env-inserted')
  assertEquals(inserted.length, 1)
  assertEquals(inserted[0]?.name, 'staging')
  assertEquals(inserted[0]?.isPrimary, true)
})

test('ensurePrimaryEnvironment pins the server on the primary row and never renames it', async () => {
  const patches: Record<string, unknown>[] = []
  const tx = createTxStub({
    envRows: [{ id: 'env-prod', name: 'production', serverId: 'srv-old' }],
    onUpdate: (patch) => patches.push(patch),
  })
  assertEquals(await ensurePrimaryEnvironment(tx, 'proj-1', 'srv-new', 'Production'), 'env-prod')
  assertEquals(patches.length, 1)
  assertEquals(patches[0]?.serverId, 'srv-new')
  assertEquals('name' in (patches[0] ?? {}), false)
})

test('ensurePrimaryEnvironment skips the update when the pin already matches', async () => {
  let updated = false
  const tx = createTxStub({
    envRows: [{ id: 'env-prod', name: 'production', serverId: 'srv-1' }],
    onUpdate: () => {
      updated = true
    },
  })
  assertEquals(await ensurePrimaryEnvironment(tx, 'proj-1', 'srv-1'), 'env-prod')
  assertEquals(updated, false)
})

test('platform default environment name is lowercase production', () => {
  assertEquals(DEFAULT_PRODUCTION_ENVIRONMENT_NAME, 'production')
})

test('insertEmptyProject inserts project and environment', async () => {
  const tx = createTxStub({ insertedProjectId: 'proj-created' })
  const id = await insertEmptyProject(tx, {
    name: 'App',
    description: 'desc',
    workspaceId: 'ws-1',
    organizationId: 'org-1',
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
    organizationId: 'org-1',
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
    createProjectSelectDb([
      {
        id: 'p1',
        metadata: { type: 'docker-compose' },
        options: {},
      },
    ]),
    {
      projectId: 'p1',
      projectType: 'docker-compose',
      dataEncryptionSecrets: stubSecrets(),
    }
  )
  assertEquals(result, { ok: true, alreadyConfigured: true })
})

test('configureProjectType rejects changing configured type', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([
      {
        id: 'p1',
        metadata: { type: 'docker-compose' },
        options: {},
      },
    ]),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'custom-template',
      dataEncryptionSecrets: stubSecrets(),
    }
  )
  assertEquals(result, {
    ok: false,
    error: 'Project type already configured',
    status: 409,
  })
})

test('configureProjectType rejects catalog code mismatch when already set', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([
      {
        id: 'p1',
        metadata: { type: 'managed', code: 'postgres' },
        options: {},
      },
    ]),
    {
      projectId: 'p1',
      projectType: 'managed',
      catalogCode: 'mysql',
      dataEncryptionSecrets: stubSecrets(),
    }
  )
  assertEquals(result, {
    ok: false,
    error: 'Project type already configured',
    status: 409,
  })
})

test('configureProjectType is idempotent for matching template code', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([
      {
        id: 'p1',
        metadata: { type: 'template', code: 'custom-template' },
        options: {},
      },
    ]),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'custom-template',
      dataEncryptionSecrets: stubSecrets(),
    }
  )
  assertEquals(result, { ok: true, alreadyConfigured: true })
})

test('configureProjectType is idempotent for matching managed code', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([
      {
        id: 'p1',
        metadata: { type: 'managed', code: 'postgres' },
        options: {},
      },
    ]),
    {
      projectId: 'p1',
      projectType: 'managed',
      catalogCode: 'postgres',
      dataEncryptionSecrets: stubSecrets(),
    }
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
    }
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
    }
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
    }
  )
  assertEquals(result, { ok: false, error: 'Unknown catalog code', status: 400 })
})

test('configureProjectType rejects catalog kind mismatch', async () => {
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: null, options: null }]),
    {
      projectId: 'p1',
      projectType: 'template',
      catalogCode: 'postgres',
      dataEncryptionSecrets: stubSecrets(),
    }
  )
  assertEquals(result, { ok: false, error: 'Unknown catalog code', status: 400 })
})

test('configureProjectType configures docker-compose via transaction', async () => {
  let watchSyncs = 0
  const result = await configureProjectType(
    createProjectSelectDb(
      [{ id: 'p1', metadata: null, options: null }],
      createTxStub({
        envRows: [
          {
            id: 'env-1',
            name: 'production',
            description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
            serverId: null,
          },
        ],
        onWatchSync: () => {
          watchSyncs += 1
        },
      })
    ),
    {
      projectId: 'p1',
      projectType: 'docker-compose',
      dataEncryptionSecrets: stubSecrets(),
      serverId: 'srv-1',
    }
  )
  assertEquals(result, { ok: true, alreadyConfigured: false })
  // The project options were rewritten, so its watch rows are brought in step
  // (one sync is a delete and an insert), after the project row lock statement.
  assertEquals(watchSyncs, 3)
})

const TUNING = { drainSeconds: 45, healthTimeoutSeconds: 200, rollbackWindowMinutes: 10 }

function projectPatchOf(patches: Record<string, unknown>[]): Record<string, unknown> {
  const patch = patches.find((p) => 'metadata' in p)
  if (!patch) throw new Error('no project update')
  return patch
}

test('configureProjectType catalog configure keeps stored deploy tuning on the project', async () => {
  const patches: Record<string, unknown>[] = []
  const tx = createTxStub({
    envRows: [{ id: 'env-1', name: 'Production', serverId: null }],
    onUpdate: (patch) => patches.push(patch),
  })
  const result = await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: {}, options: { ...TUNING, stale: 1 } }], tx),
    {
      projectId: 'p1',
      projectType: 'managed',
      catalogCode: 'postgres',
      dataEncryptionSecrets: await realDataEncryptionSecrets(),
    }
  )
  assertEquals(result, { ok: true, alreadyConfigured: false })
  const options = projectPatchOf(patches).options as Record<string, unknown>
  assertEquals(options.drainSeconds, 45)
  assertEquals(options.healthTimeoutSeconds, 200)
  assertEquals(options.rollbackWindowMinutes, 10)
  assertEquals('compose' in options, true)
  assertEquals('stale' in options, false)
})

test('configureProjectType docker-compose configure keeps stored deploy tuning', async () => {
  const patches: Record<string, unknown>[] = []
  const tx = createTxStub({
    envRows: [{ id: 'env-1', name: 'Production', serverId: null }],
    onUpdate: (patch) => patches.push(patch),
  })
  await configureProjectType(
    createProjectSelectDb([{ id: 'p1', metadata: null, options: TUNING }], tx),
    { projectId: 'p1', projectType: 'docker-compose', dataEncryptionSecrets: stubSecrets() }
  )
  const options = projectPatchOf(patches).options as Record<string, unknown>
  assertEquals(options.drainSeconds, 45)
  assertEquals(options.rollbackWindowMinutes, 10)
  assertEquals('compose' in options, true)
})

test('configureProjectType configures managed postgres with secret vars', async () => {
  const secrets = await realDataEncryptionSecrets()
  const insertedVars: Record<string, unknown>[] = []
  const tx = createTxStub({
    envRows: [
      {
        id: 'env-1',
        name: 'Production',
        description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
        serverId: null,
      },
    ],
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
    }
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
    envRows: [
      {
        id: 'env-1',
        name: 'Production',
        description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
        serverId: null,
      },
    ],
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
    }
  )
  assertEquals(result, { ok: true, alreadyConfigured: false })
  assertEquals(insertedVars.length, 0)
})

test('configureProjectType maps encryption unavailable from transaction', async () => {
  const result = await configureProjectType(
    createProjectSelectDb(
      [{ id: 'p1', metadata: null, options: null }],
      undefined,
      new Error('encryption unavailable')
    ),
    {
      projectId: 'p1',
      projectType: 'managed',
      catalogCode: 'postgres',
      dataEncryptionSecrets: stubSecrets(),
    }
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
          new Error('disk full')
        ),
        {
          projectId: 'p1',
          projectType: 'managed',
          catalogCode: 'postgres',
          dataEncryptionSecrets: stubSecrets(),
        }
      ),
    Error,
    'disk full'
  )
})
