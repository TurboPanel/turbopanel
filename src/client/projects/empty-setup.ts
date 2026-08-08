/**
 * Empty-project setup helpers.
 *
 * Creation flow: empty project + Production once → configure type later.
 * Setup state is inferred from `metadata.type` (absent = needs setup).
 * No separate draft/runtime status column.
 */
import { and, eq } from 'drizzle-orm'
import { encryptSecret } from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import type { Db } from '../../db.ts'
import { environment, organization, project, variable } from '../../lib/db/schema.ts'
import { emptyComposeDocument } from '../../lib/compose/index.ts'
import {
  DEFAULT_ENVIRONMENT_NAME,
  parseOrganizationOptions,
  resolveDefaultEnvironmentName,
} from '../../lib/organization-options.ts'
import {
  getCatalogEntry,
  isManagedEngineCatalogEntry,
  resolveCatalogVariablePlaintext,
  type CatalogEntry,
  type CatalogVariable,
  type CreateProjectType,
} from './catalog/index.ts'

export const DEFAULT_PRODUCTION_ENVIRONMENT_NAME = DEFAULT_ENVIRONMENT_NAME
export const DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION =
  'Default environment'

type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type ProjectTypeMetadata = {
  type?: string | null
  code?: string
}

/** True when the project has not yet chosen compose / template / managed. */
export function projectNeedsSetup(
  metadata: ProjectTypeMetadata | null | undefined,
): boolean {
  const type = metadata?.type
  return type == null || type === '' || type === 'empty'
}

export function isConfiguredProjectType(
  value: string,
): value is CreateProjectType {
  return (
    value === 'docker-compose' || value === 'template' || value === 'managed'
  )
}

function normalizeEnvName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase()
}

export function isProductionEnvironmentName(
  name: string | null | undefined,
): boolean {
  return normalizeEnvName(name) === 'production'
}

/**
 * Resolve the org-wide default environment display name used when scaffolding
 * new projects. Falls back to the platform constant when the org row is missing.
 */
export async function loadDefaultEnvironmentName(
  db: Db,
  organizationId: string,
): Promise<string> {
  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  if (!orgRow) return DEFAULT_PRODUCTION_ENVIRONMENT_NAME
  return resolveDefaultEnvironmentName(parseOrganizationOptions(orgRow.options))
}

/**
 * Insert an empty project with a single Production environment.
 * Leaves `metadata.type` unset so setup can resume later.
 */
export async function insertEmptyProject(
  tx: DbTx,
  fields: {
    displayName: string | null
    description: string | null
    workspaceId: string
    serverId: string | null
    defaultEnvironmentName?: string
  },
): Promise<string> {
  const envName =
    fields.defaultEnvironmentName ?? DEFAULT_PRODUCTION_ENVIRONMENT_NAME
  const [inserted] = await tx
    .insert(project)
    .values({
      name: fields.displayName,
      description: fields.description,
      workspaceId: fields.workspaceId,
      metadata: null,
      options: null,
    })
    .returning({ id: project.id })

  await tx.insert(environment).values({
    projectId: inserted.id,
    name: envName,
    description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
    ...(fields.serverId ? { serverId: fields.serverId } : {}),
    options: { compose: emptyComposeDocument() },
  })

  return inserted.id
}

async function findProductionEnvironment(
  tx: DbTx,
  projectId: string,
  defaultEnvironmentName: string,
): Promise<
  { id: string; displayName: string | null; serverId: string | null } | null
> {
  const rows = await tx
    .select({
      id: environment.id,
      displayName: environment.name,
      description: environment.description,
      serverId: environment.serverId,
    })
    .from(environment)
    .where(eq(environment.projectId, projectId))

  // Prefer a literal Production row so catalog production config never lands
  // on a non-production environment that merely matches the org default.
  const production = rows.find((row) =>
    isProductionEnvironmentName(row.displayName)
  )
  if (production) return production

  const normalizedDefault = normalizeEnvName(defaultEnvironmentName)
  const exactDefault = rows.find(
    (row) => normalizeEnvName(row.displayName) === normalizedDefault,
  )
  if (exactDefault) return exactDefault

  // Empty projects scaffold one default environment under the then-current
  // org default. If that name later changes, still reuse the scaffold rather
  // than inserting a second default during configure.
  if (rows.length === 1) {
    return rows[0] ?? null
  }

  const scaffolded = rows.find(
    (row) => row.description === DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
  )
  return scaffolded ?? null
}

/**
 * Ensure exactly one Production (or org-default-named) environment exists.
 * Returns its id. Idempotent — prefers a literal "production" name, then
 * the resolved org default, then a sole existing row / scaffold description
 * match (so empty-project setup survives an org-default rename); only
 * rewrites casing for case variants of the effective name. When reusing an
 * existing row, applies a non-null `serverId` pin if the stored value differs.
 */
export async function ensureProductionEnvironment(
  tx: DbTx,
  projectId: string,
  serverId?: string | null,
  defaultEnvironmentName?: string,
): Promise<string> {
  const effectiveName =
    defaultEnvironmentName ?? DEFAULT_PRODUCTION_ENVIRONMENT_NAME
  const existing = await findProductionEnvironment(
    tx,
    projectId,
    effectiveName,
  )
  if (existing) {
    // Normalize casing only when the existing name is a case variant of the
    // effective name — never clobber a custom default or a pre-existing
    // Production under a renamed org default.
    const shouldNormalizeName =
      existing.displayName !== effectiveName &&
      normalizeEnvName(existing.displayName) === normalizeEnvName(effectiveName)
    const shouldPinServer =
      serverId != null && existing.serverId !== serverId
    if (shouldNormalizeName || shouldPinServer) {
      await tx
        .update(environment)
        .set({
          ...(shouldNormalizeName ? { name: effectiveName } : {}),
          ...(shouldPinServer ? { serverId } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, existing.id))
    }
    return existing.id
  }

  const [inserted] = await tx
    .insert(environment)
    .values({
      projectId,
      name: effectiveName,
      description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
      ...(serverId ? { serverId } : {}),
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: environment.id })
  return inserted.id
}

function resolveCatalogProductionEnv(entry: CatalogEntry) {
  return (
    entry.environments.find((env) =>
      isProductionEnvironmentName(env.displayName)
    ) ?? entry.environments[0]
  )
}

async function applyCatalogVariablesToEnvironment(
  tx: DbTx,
  environmentId: string,
  entry: CatalogEntry,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<void> {
  const catalogEnv = resolveCatalogProductionEnv(entry)
  if (!catalogEnv?.variables?.length) return

  const existing = await tx
    .select({ key: variable.key })
    .from(variable)
    .where(eq(variable.environmentId, environmentId))
  const existingKeys = new Set(existing.map((row) => row.key))

  const sharedCredentials = new Map<string, string>()
  for (const v of catalogEnv.variables) {
    if (existingKeys.has(v.key)) continue
    const plaintext = resolveCatalogVariablePlaintext(v, sharedCredentials)
    const storedValue = v.isSecret
      ? await encryptSecret(dataEncryptionSecrets, plaintext)
      : plaintext
    await tx.insert(variable).values({
      environmentId,
      key: v.key,
      value: storedValue,
      isSecret: v.isSecret,
    })
  }
}

function catalogConfigureOptions(
  entry: CatalogEntry,
): Record<string, unknown> {
  if (entry.options) {
    return { compose: entry.compose, ...entry.options }
  }
  return { compose: entry.compose }
}

export type ConfigureProjectResult =
  | { ok: true; alreadyConfigured: boolean }
  | { ok: false; error: string; status: 400 | 409 | 503 }

function alreadyConfiguredResult(
  metadata: ProjectTypeMetadata,
  projectType: CreateProjectType,
  catalogCode?: string,
): ConfigureProjectResult {
  if (metadata.type !== projectType) {
    return {
      ok: false,
      error: 'Project type already configured',
      status: 409,
    }
  }
  if (
    (projectType === 'template' || projectType === 'managed') &&
    metadata.code !== catalogCode
  ) {
    return {
      ok: false,
      error: 'Project type already configured',
      status: 409,
    }
  }
  return { ok: true, alreadyConfigured: true }
}

async function applyCatalogEnvCompose(
  tx: DbTx,
  productionId: string,
  entry: CatalogEntry,
): Promise<void> {
  const catalogEnv = resolveCatalogProductionEnv(entry)
  if (!catalogEnv?.compose) return
  await tx
    .update(environment)
    .set({
      options: { compose: catalogEnv.compose },
      description:
        catalogEnv.description ??
        DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(environment.id, productionId))
}

async function insertCatalogEnvVariables(
  tx: DbTx,
  environmentId: string,
  vars: CatalogVariable[],
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<void> {
  const sharedCredentials = new Map<string, string>()
  for (const v of vars) {
    const plaintext = resolveCatalogVariablePlaintext(v, sharedCredentials)
    const storedValue = v.isSecret
      ? await encryptSecret(dataEncryptionSecrets, plaintext)
      : plaintext
    await tx.insert(variable).values({
      environmentId,
      key: v.key,
      value: storedValue,
      isSecret: v.isSecret,
    })
  }
}

async function insertExtraCatalogEnvironments(
  tx: DbTx,
  input: {
    projectId: string
    serverId?: string | null
    entry: CatalogEntry
    dataEncryptionSecrets: DerivedSecretsConfig
  },
): Promise<void> {
  for (const env of input.entry.environments) {
    if (isProductionEnvironmentName(env.displayName)) continue
    const existingExtra = await tx
      .select({ id: environment.id })
      .from(environment)
      .where(
        and(
          eq(environment.projectId, input.projectId),
          eq(environment.name, env.displayName),
        ),
      )
      .limit(1)
    if (existingExtra[0]) continue
    const [insertedEnv] = await tx
      .insert(environment)
      .values({
        projectId: input.projectId,
        name: env.displayName,
        description: env.description ?? null,
        ...(input.serverId ? { serverId: input.serverId } : {}),
        options: env.compose ? { compose: env.compose } : null,
      })
      .returning({ id: environment.id })
    if (!env.variables?.length) continue
    await insertCatalogEnvVariables(
      tx,
      insertedEnv.id,
      env.variables,
      input.dataEncryptionSecrets,
    )
  }
}

function buildCatalogProjectMetadata(
  projectType: CreateProjectType,
  entry: CatalogEntry,
  isEngine: boolean,
): ProjectTypeMetadata {
  if (isEngine || projectType === 'template') {
    return { type: projectType, code: entry.code }
  }
  return { type: projectType }
}

async function configureCatalogProject(
  db: Db,
  input: {
    projectId: string
    projectType: CreateProjectType
    catalogCode: string
    dataEncryptionSecrets: DerivedSecretsConfig
    serverId?: string | null
    defaultEnvironmentName?: string
  },
): Promise<ConfigureProjectResult> {
  const entry = getCatalogEntry(input.catalogCode)
  if (entry?.kind !== input.projectType) {
    return { ok: false, error: 'Unknown catalog code', status: 400 }
  }

  const isEngine =
    input.projectType === 'managed' && isManagedEngineCatalogEntry(entry)
  const nextMetadata = buildCatalogProjectMetadata(
    input.projectType,
    entry,
    isEngine,
  )

  try {
    await db.transaction(async (tx) => {
      const productionId = await ensureProductionEnvironment(
        tx,
        input.projectId,
        input.serverId,
        input.defaultEnvironmentName,
      )
      await applyCatalogEnvCompose(tx, productionId, entry)
      await applyCatalogVariablesToEnvironment(
        tx,
        productionId,
        entry,
        input.dataEncryptionSecrets,
      )
      await insertExtraCatalogEnvironments(tx, {
        projectId: input.projectId,
        serverId: input.serverId,
        entry,
        dataEncryptionSecrets: input.dataEncryptionSecrets,
      })
      await tx
        .update(project)
        .set({
          metadata: nextMetadata,
          options: catalogConfigureOptions(entry),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, input.projectId))
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'encryption unavailable') {
      return { ok: false, error: 'Encryption unavailable', status: 503 }
    }
    throw err
  }

  return { ok: true, alreadyConfigured: false }
}

async function configureDockerComposeProject(
  db: Db,
  projectId: string,
  serverId?: string | null,
  defaultEnvironmentName?: string,
): Promise<ConfigureProjectResult> {
  await db.transaction(async (tx) => {
    await ensureProductionEnvironment(
      tx,
      projectId,
      serverId,
      defaultEnvironmentName,
    )
    await tx
      .update(project)
      .set({
        metadata: { type: 'docker-compose' },
        options: { compose: emptyComposeDocument() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(project.id, projectId))
  })
  return { ok: true, alreadyConfigured: false }
}

/**
 * Apply type/catalog selection to an empty (or already-matching) project.
 * Idempotent when the same type (+ code) is already configured.
 * Rejects changing type after a different configuration is set.
 */
export async function configureProjectType(
  db: Db,
  input: {
    projectId: string
    projectType: CreateProjectType
    catalogCode?: string
    dataEncryptionSecrets: DerivedSecretsConfig | undefined
    serverId?: string | null
    defaultEnvironmentName?: string
  },
): Promise<ConfigureProjectResult> {
  const [row] = await db
    .select({
      id: project.id,
      metadata: project.metadata,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, input.projectId))
    .limit(1)

  if (!row) {
    return { ok: false, error: 'Not found', status: 400 }
  }

  const metadata = (row.metadata ?? {}) as ProjectTypeMetadata
  if (!projectNeedsSetup(metadata)) {
    return alreadyConfiguredResult(
      metadata,
      input.projectType,
      input.catalogCode,
    )
  }

  if (input.projectType === 'docker-compose') {
    return configureDockerComposeProject(
      db,
      input.projectId,
      input.serverId,
      input.defaultEnvironmentName,
    )
  }

  if (!input.catalogCode) {
    return { ok: false, error: 'Invalid request', status: 400 }
  }
  if (!input.dataEncryptionSecrets) {
    return { ok: false, error: 'Encryption unavailable', status: 503 }
  }

  return configureCatalogProject(db, {
    projectId: input.projectId,
    projectType: input.projectType,
    catalogCode: input.catalogCode,
    dataEncryptionSecrets: input.dataEncryptionSecrets,
    serverId: input.serverId,
    defaultEnvironmentName: input.defaultEnvironmentName,
  })
}
