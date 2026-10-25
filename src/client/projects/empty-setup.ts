/**
 * Empty-project setup helpers.
 *
 * Creation flow: empty project + Production once → configure type later.
 * Setup state is inferred from `project.kind` (NULL = needs setup).
 * No separate draft/runtime status column.
 */
import { and, eq } from 'drizzle-orm'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { Db } from '../../db/connection.ts'
import { environment, organization, project, variable } from '../../db/schema.ts'
import { emptyComposeDocument } from '../../features/compose/index.ts'
import {
  loadPrimaryEnvironment,
  lockProjectForEnvironmentChange,
} from '../../features/projects/primary-environment.ts'
import { uniqueViolationMessage } from '../../db/unique-violation.ts'
import { catalogEnvironmentCompose } from './catalog-compose.ts'
import { syncEnvironmentWatch, syncProjectWatch } from '../../features/git/watch-records.ts'
import {
  DEFAULT_ENVIRONMENT_NAME,
  parseOrganizationOptions,
  resolveDefaultEnvironmentName,
} from '../../features/organizations/organization-options.ts'
import {
  getCatalogEntry,
  isManagedEngineCatalogEntry,
  resolveCatalogVariablePlaintext,
  type CatalogEntry,
  type CatalogVariable,
  type CreateProjectType,
} from './catalog/index.ts'
import {
  settleDeployOptions,
  stampNewEnvironmentDeployOptions,
} from '../../features/deploy/deploy-options.ts'
import { allocateProjectSlug } from '../../features/folders/records.ts'
import { projectKindForType } from '../../features/projects/vocabulary.ts'
import { forEachSequential } from '../../lib/sequential.ts'

export const DEFAULT_PRODUCTION_ENVIRONMENT_NAME = DEFAULT_ENVIRONMENT_NAME
export const DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION = 'Default environment'

type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type ProjectTypeMetadata = {
  code?: string
}

/** True when the project has not yet chosen compose / template / managed. */
export function projectNeedsSetup(kind: string | null | undefined): boolean {
  return kind == null
}

export function isConfiguredProjectType(value: string): value is CreateProjectType {
  return value === 'docker-compose' || value === 'template' || value === 'managed'
}

function normalizeEnvName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase()
}

export function isProductionEnvironmentName(name: string | null | undefined): boolean {
  return normalizeEnvName(name) === 'production'
}

/**
 * Resolve the org-wide default environment display name used when scaffolding
 * new projects. Falls back to the platform constant when the org row is missing.
 */
export async function loadDefaultEnvironmentName(db: Db, organizationId: string): Promise<string> {
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
 * Leaves `kind` unset so setup can resume later.
 */
export async function insertEmptyProject(
  tx: DbTx,
  fields: {
    name: string | null
    description: string | null
    workspaceId: string
    organizationId: string
    serverId: string | null
    defaultEnvironmentName?: string
    icon?: string | null
  }
): Promise<string> {
  const envName = fields.defaultEnvironmentName ?? DEFAULT_PRODUCTION_ENVIRONMENT_NAME
  const [inserted] = await tx
    .insert(project)
    .values({
      slug: await allocateProjectSlug(tx, fields.organizationId, fields.name),
      name: fields.name,
      description: fields.description,
      workspaceId: fields.workspaceId,
      organizationId: fields.organizationId,
      metadata: null,
      icon: fields.icon ?? null,
      options: null,
    })
    .returning({ id: project.id })

  await tx.insert(environment).values({
    projectId: inserted.id,
    name: envName,
    description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
    isPrimary: true,
    ...(fields.serverId ? { serverId: fields.serverId } : {}),
    options: stampNewEnvironmentDeployOptions({ compose: emptyComposeDocument() }),
  })

  return inserted.id
}

/**
 * The project's primary environment, created as the primary one when the
 * project has none yet. Idempotent. Looks the environment up by its marker,
 * never by name. When reusing the row, applies a non-null `serverId` pin if
 * the stored value differs.
 */
export async function ensurePrimaryEnvironment(
  tx: DbTx,
  projectId: string,
  serverId?: string | null,
  defaultEnvironmentName?: string
): Promise<string> {
  await lockProjectForEnvironmentChange(tx, projectId)
  const existing = await loadPrimaryEnvironment(tx, projectId)
  if (existing) {
    if (serverId != null && existing.serverId !== serverId) {
      await tx
        .update(environment)
        .set({ serverId, updatedAt: new Date().toISOString() })
        .where(eq(environment.id, existing.id))
    }
    return existing.id
  }

  const [inserted] = await tx
    .insert(environment)
    .values({
      projectId,
      name: defaultEnvironmentName ?? DEFAULT_PRODUCTION_ENVIRONMENT_NAME,
      description: DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
      isPrimary: true,
      ...(serverId ? { serverId } : {}),
      options: stampNewEnvironmentDeployOptions({ compose: emptyComposeDocument() }),
    })
    .returning({ id: environment.id })
  return inserted.id
}

function resolveCatalogProductionEnv(entry: CatalogEntry) {
  return (
    entry.environments.find((env) => isProductionEnvironmentName(env.displayName)) ??
    entry.environments[0]
  )
}

async function applyCatalogVariablesToEnvironment(
  tx: DbTx,
  environmentId: string,
  entry: CatalogEntry,
  dataEncryptionSecrets: DerivedSecretsConfig
): Promise<void> {
  const catalogEnv = resolveCatalogProductionEnv(entry)
  if (!catalogEnv?.variables?.length) return

  const existing = await tx
    .select({ key: variable.key })
    .from(variable)
    .where(eq(variable.environmentId, environmentId))
  const existingKeys = new Set(existing.map((row) => row.key))

  const sharedCredentials = new Map<string, string>()
  await forEachSequential(catalogEnv.variables, async (v) => {
    if (existingKeys.has(v.key)) return
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
  })
}

/** Project options for a catalog project: the Base stays empty, the content sits in the environments. */
function catalogConfigureOptions(entry: CatalogEntry): Record<string, unknown> {
  const base = emptyComposeDocument()
  if (entry.options) {
    return { compose: base, ...entry.options }
  }
  return { compose: base }
}

export type ConfigureProjectResult =
  { ok: true; alreadyConfigured: boolean } | { ok: false; error: string; status: 400 | 409 | 503 }

function alreadyConfiguredResult(
  row: { kind: string | null; metadata: ProjectTypeMetadata },
  projectType: CreateProjectType,
  catalogCode?: string
): ConfigureProjectResult {
  // A template is compose plus a catalog code; a plain compose project has none.
  const sameType =
    row.kind === projectKindForType(projectType) &&
    (projectType !== 'docker-compose' || row.metadata.code === undefined)
  if (!sameType) {
    return {
      ok: false,
      error: 'Project type already configured',
      status: 409,
    }
  }
  if (
    (projectType === 'template' || projectType === 'managed') &&
    row.metadata.code !== catalogCode
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
  primaryId: string,
  entry: CatalogEntry
): Promise<void> {
  const catalogEnv = resolveCatalogProductionEnv(entry)
  const compose = catalogEnvironmentCompose(entry, catalogEnv)
  if (!compose) return
  // Replaces the compose overlay but keeps (or, for a first configure, stamps)
  // the deploy settings the environment already carries.
  const [existing] = await tx
    .select({ options: environment.options })
    .from(environment)
    .where(eq(environment.id, primaryId))
    .limit(1)
  const options = stampNewEnvironmentDeployOptions(
    settleDeployOptions(existing?.options, { compose }, 'environment')
  )
  await tx
    .update(environment)
    .set({
      options,
      description: catalogEnv?.description ?? DEFAULT_PRODUCTION_ENVIRONMENT_DESCRIPTION,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(environment.id, primaryId))
  await syncEnvironmentWatch(tx, primaryId)
}

async function insertCatalogEnvVariables(
  tx: DbTx,
  environmentId: string,
  vars: CatalogVariable[],
  dataEncryptionSecrets: DerivedSecretsConfig
): Promise<void> {
  const sharedCredentials = new Map<string, string>()
  await forEachSequential(vars, async (v) => {
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
  })
}

async function insertExtraCatalogEnvironments(
  tx: DbTx,
  input: {
    projectId: string
    serverId?: string | null
    entry: CatalogEntry
    dataEncryptionSecrets: DerivedSecretsConfig
  }
): Promise<void> {
  await forEachSequential(input.entry.environments, async (env) => {
    if (isProductionEnvironmentName(env.displayName)) return
    const existingExtra = await tx
      .select({ id: environment.id })
      .from(environment)
      .where(and(eq(environment.projectId, input.projectId), eq(environment.name, env.displayName)))
      .limit(1)
    if (existingExtra[0]) return
    const extraCompose = catalogEnvironmentCompose(input.entry, env)
    const [insertedEnv] = await tx
      .insert(environment)
      .values({
        projectId: input.projectId,
        name: env.displayName,
        description: env.description ?? null,
        ...(input.serverId ? { serverId: input.serverId } : {}),
        options: stampNewEnvironmentDeployOptions(extraCompose ? { compose: extraCompose } : null),
      })
      .returning({ id: environment.id })
    if (extraCompose) await syncEnvironmentWatch(tx, insertedEnv.id)
    if (!env.variables?.length) return
    await insertCatalogEnvVariables(tx, insertedEnv.id, env.variables, input.dataEncryptionSecrets)
  })
}

function buildCatalogProjectMetadata(
  projectType: CreateProjectType,
  entry: CatalogEntry,
  isEngine: boolean
): ProjectTypeMetadata {
  if (isEngine || projectType === 'template') {
    return { code: entry.code }
  }
  return {}
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
    existingOptions?: unknown
  }
): Promise<ConfigureProjectResult> {
  const entry = getCatalogEntry(input.catalogCode)
  if (entry?.kind !== input.projectType) {
    return { ok: false, error: 'Unknown catalog code', status: 400 }
  }

  const isEngine = input.projectType === 'managed' && isManagedEngineCatalogEntry(entry)
  const nextMetadata = buildCatalogProjectMetadata(input.projectType, entry, isEngine)

  try {
    await db.transaction(async (tx) => {
      const primaryId = await ensurePrimaryEnvironment(
        tx,
        input.projectId,
        input.serverId,
        input.defaultEnvironmentName
      )
      await applyCatalogEnvCompose(tx, primaryId, entry)
      await applyCatalogVariablesToEnvironment(tx, primaryId, entry, input.dataEncryptionSecrets)
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
          kind: projectKindForType(input.projectType),
          options: settleDeployOptions(
            input.existingOptions,
            catalogConfigureOptions(entry),
            'project'
          ),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, input.projectId))
      await syncProjectWatch(tx, input.projectId)
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'encryption unavailable') {
      return { ok: false, error: 'Encryption unavailable', status: 503 }
    }
    const raced = primaryRaceResult(err)
    if (raced) return raced
    throw err
  }

  return { ok: true, alreadyConfigured: false }
}

/** A lost race on the primary-environment index is a conflict the caller can retry, not a 500. */
function primaryRaceResult(err: unknown): ConfigureProjectResult | null {
  if (!uniqueViolationMessage(err)?.includes('uniq_environment_project_primary')) return null
  return { ok: false, error: 'primary_environment_conflict', status: 409 }
}

async function configureDockerComposeProject(
  db: Db,
  projectId: string,
  serverId?: string | null,
  defaultEnvironmentName?: string,
  existingOptions?: unknown
): Promise<ConfigureProjectResult> {
  try {
    await db.transaction(async (tx) => {
      await ensurePrimaryEnvironment(tx, projectId, serverId, defaultEnvironmentName)
      await tx
        .update(project)
        .set({
          metadata: {},
          kind: projectKindForType('docker-compose'),
          options: settleDeployOptions(
            existingOptions,
            { compose: emptyComposeDocument() },
            'project'
          ),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))
      await syncProjectWatch(tx, projectId)
    })
  } catch (err) {
    const raced = primaryRaceResult(err)
    if (raced) return raced
    throw err
  }
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
  }
): Promise<ConfigureProjectResult> {
  const [row] = await db
    .select({
      id: project.id,
      kind: project.kind,
      metadata: project.metadata,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, input.projectId))
    .limit(1)

  if (!row) {
    return { ok: false, error: 'Not found', status: 400 }
  }

  if (!projectNeedsSetup(row.kind)) {
    return alreadyConfiguredResult(
      { kind: row.kind, metadata: (row.metadata ?? {}) as ProjectTypeMetadata },
      input.projectType,
      input.catalogCode
    )
  }

  if (input.projectType === 'docker-compose') {
    return configureDockerComposeProject(
      db,
      input.projectId,
      input.serverId,
      input.defaultEnvironmentName,
      row.options
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
    existingOptions: row.options,
  })
}
