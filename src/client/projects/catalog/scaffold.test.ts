import { assertEquals, assertNotEquals, assertThrows } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import {
  decryptSecret,
  parseSecretEnvelope,
} from '../../authn/data-encryption.ts'
import {
  deriveEncryptionSecretsConfig,
  parseSecretsEnv,
} from '../../authn/secrets.ts'
import { getDatabaseUrl } from '../../../db-url.ts'
import { createDenoDb } from '../../../db.ts'
import {
  environment,
  organization,
  project,
  variable,
  workspace,
} from '../../../lib/db/schema.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../../test-fixtures/secrets.ts'
import { scaffoldCatalogEnvironments } from '../routes.ts'
import {
  getCatalogEntry,
  listManagedCatalogEntries,
  resolveCatalogVariablePlaintext,
  type CatalogEntry,
  type CatalogVariable,
} from './index.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PLACEHOLDER_SECRETS = ['changeme', 'password', 'secret', 'admin'] as const

test('managed catalog secret variables omit static plaintext defaults', () => {
  for (const entry of listManagedCatalogEntries()) {
    for (const env of entry.environments) {
      for (const v of env.variables ?? []) {
        if (!v.isSecret) continue
        assertEquals(
          v.value,
          undefined,
          `${entry.code}.${v.key} must not embed a secret default`,
        )
        for (const placeholder of PLACEHOLDER_SECRETS) {
          assertNotEquals(v.value, placeholder)
        }
      }
    }
  }
})

test('resolveCatalogVariablePlaintext reuses sharedCredentialId within a pass', () => {
  const shared = new Map<string, string>()
  const a: CatalogVariable = {
    key: 'DB_PASSWORD',
    isSecret: true,
    sharedCredentialId: 'app-db',
  }
  const b: CatalogVariable = {
    key: 'APP_DB_PASSWORD',
    isSecret: true,
    sharedCredentialId: 'app-db',
  }
  const c: CatalogVariable = { key: 'ROOT_PASSWORD', isSecret: true }

  const first = resolveCatalogVariablePlaintext(a, shared)
  const second = resolveCatalogVariablePlaintext(b, shared)
  const independent = resolveCatalogVariablePlaintext(c, shared)

  assertEquals(first, second)
  assertNotEquals(first, independent)
  assertEquals(first.length >= 24, true)
})

test('resolveCatalogVariablePlaintext rejects non-secret variables without value', () => {
  assertThrows(
    () => {
      resolveCatalogVariablePlaintext(
        { key: 'PLAIN', isSecret: false },
        new Map(),
      )
    },
    TypeError,
    'missing value',
  )
})

test('scaffoldCatalogEnvironments seals managed secrets as tpsecret without placeholders', async () => {
  if (!dbUrl) {
    console.warn('Skipping catalog scaffold tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const entry = getCatalogEntry('wordpress-mysql')
  if (!entry || entry.kind !== 'template') {
    throw new TypeError('expected wordpress-mysql template catalog entry')
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )

  const [org] = await db
    .insert(organization)
    .values({ displayName: 'Catalog Scaffold Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id

  const [ws] = await db
    .insert(workspace)
    .values({
      organizationId,
      displayName: 'Catalog Scaffold Workspace',
    })
    .returning({ id: workspace.id })

  const [proj] = await db
    .insert(project)
    .values({
      workspaceId: ws!.id,
      displayName: 'Catalog Scaffold Project',
      metadata: { type: 'template' },
      options: { compose: entry.compose },
    })
    .returning({ id: project.id })

  let envId: string | undefined
  try {
    await scaffoldCatalogEnvironments(
      db,
      proj!.id,
      entry,
      dataEncryptionSecrets,
    )

    const envs = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, proj!.id))
    assertEquals(envs.length, 1)
    envId = envs[0]!.id

    const rows = await db
      .select({
        key: variable.key,
        value: variable.value,
        isSecret: variable.isSecret,
      })
      .from(variable)
      .where(eq(variable.environmentId, envId))

    const secretRows = rows.filter((row) => row.isSecret)
    assertEquals(secretRows.length >= 2, true)

    const plaintexts: string[] = []
    for (const row of secretRows) {
      assertEquals(parseSecretEnvelope(row.value)?.keyVersion !== undefined, true)
      assertEquals(row.value.startsWith('tpsecret.'), true)

      const plaintext = await decryptSecret(dataEncryptionSecrets, row.value)
      plaintexts.push(plaintext)

      for (const placeholder of PLACEHOLDER_SECRETS) {
        assertNotEquals(
          plaintext,
          placeholder,
          `${row.key} must not decrypt to static placeholder ${placeholder}`,
        )
      }
      assertEquals(plaintext.length >= 24, true)
    }

    // Independent secret keys get independent credentials by default.
    if (plaintexts.length >= 2) {
      assertNotEquals(plaintexts[0], plaintexts[1])
    }
  } finally {
    if (envId) {
      await db.delete(variable).where(eq(variable.environmentId, envId))
    }
    await db.delete(environment).where(eq(environment.projectId, proj!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('scaffoldCatalogEnvironments reuses sharedCredentialId when sealing', async () => {
  if (!dbUrl) {
    console.warn('Skipping catalog scaffold tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const sharedEntry: CatalogEntry = {
    code: 'shared-secret-fixture',
    kind: 'managed',
    displayName: 'Shared Secret Fixture',
    description: 'Test-only entry for sharedCredentialId',
    compose: {
      version: 1,
      data: { services: {} },
      presentation: { keyOrder: ['services'], comments: {} },
    },
    environments: [
      {
        displayName: 'production',
        variables: [
          {
            key: 'DB_PASSWORD',
            isSecret: true,
            sharedCredentialId: 'app-db',
          },
          {
            key: 'APP_DB_PASSWORD',
            isSecret: true,
            sharedCredentialId: 'app-db',
          },
        ],
      },
    ],
  }

  const db = createDenoDb()
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )

  const [org] = await db
    .insert(organization)
    .values({ displayName: 'Shared Credential Org' })
    .returning({ id: organization.id })
  const [ws] = await db
    .insert(workspace)
    .values({
      organizationId: org!.id,
      displayName: 'Shared Credential Workspace',
    })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      workspaceId: ws!.id,
      displayName: 'Shared Credential Project',
      metadata: { type: 'managed' },
    })
    .returning({ id: project.id })

  let envId: string | undefined
  try {
    await scaffoldCatalogEnvironments(
      db,
      proj!.id,
      sharedEntry,
      dataEncryptionSecrets,
    )

    const [env] = await db
      .select({ id: environment.id })
      .from(environment)
      .where(eq(environment.projectId, proj!.id))
    envId = env!.id

    const rows = await db
      .select({ key: variable.key, value: variable.value })
      .from(variable)
      .where(eq(variable.environmentId, envId))

    const byKey = new Map(rows.map((row) => [row.key, row.value]))
    const dbPassword = byKey.get('DB_PASSWORD')
    const appPassword = byKey.get('APP_DB_PASSWORD')
    if (!dbPassword || !appPassword) {
      throw new TypeError('expected shared secret variable rows')
    }

    assertEquals(dbPassword.startsWith('tpsecret.'), true)
    assertEquals(appPassword.startsWith('tpsecret.'), true)
    assertEquals(
      await decryptSecret(dataEncryptionSecrets, dbPassword),
      await decryptSecret(dataEncryptionSecrets, appPassword),
    )
  } finally {
    if (envId) {
      await db.delete(variable).where(eq(variable.environmentId, envId))
    }
    await db.delete(environment).where(eq(environment.projectId, proj!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
  }
})
