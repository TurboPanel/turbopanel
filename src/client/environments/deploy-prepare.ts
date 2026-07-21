import type { Context } from 'hono'
import { eq, inArray, or } from 'drizzle-orm'
import type { AppEnv } from '../../app.ts'
import { decryptSecret, resealSecretForDaemon } from '../authn/data-encryption.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import {
  applyServiceOptionsToComposeDocument,
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
  type ServiceDeployHook,
} from '../../lib/compose/apply-service-options.ts'
import {
  applyVariablesToComposeDocument,
  type DeployVariableEntry,
  type DeployVariableMaterial,
} from '../../lib/compose/apply-variables.ts'
import {
  assertComposeDocument,
  composeDocumentToRuntimeYaml,
  mergeComposeOverlay,
  stripComposePlacement,
  type ComposeDocument,
} from '../../lib/compose/index.ts'
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeployVariableMaterial,
} from '../../lib/commands/schemas.ts'
import {
  environment,
  organization,
  principal,
  project,
  server,
  service,
  storage,
} from '../../lib/db/schema.ts'
import { parseResourceLimits, checkResourceLimits, sumServiceResourceUsage } from '../../lib/resource-limits.ts'
import { resolveHostingProxy } from '../../lib/hosting-options.ts'
import { reconcileServicesFromCompose } from './reconcile-services.ts'
import type { Db } from '../../db.ts'
import {
  resolveInheritedVariablesForEnvironment,
  resolveInheritedVariablesForService,
  resolveServerScopedVariables,
  type ResolvedVariableMap,
} from '../variables/resolve-inherited.ts'

export { readComposePlacementServerId } from '../../lib/compose/index.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readComposeServiceName(metadata: unknown, fallback: string): string {
  if (isPlainObject(metadata) && typeof metadata.composeServiceName === 'string') {
    return metadata.composeServiceName
  }
  return fallback
}

function extractComposeFromOptions(options: unknown): unknown {
  if (!isPlainObject(options)) return null
  return options.compose ?? null
}

function readPrincipalMetadata(metadata: unknown): { uid: number; gid: number; home?: string } | null {
  if (!isPlainObject(metadata)) return null
  const uid = metadata.uid
  const gid = metadata.gid
  if (typeof uid !== 'number' || typeof gid !== 'number') return null
  return {
    uid,
    gid,
    ...(typeof metadata.home === 'string' ? { home: metadata.home } : {}),
  }
}

export type PreparedDeployCompose = {
  composeYaml: string
  hooks: ServiceDeployHook[]
  variableMaterial: EnvironmentDeployVariableMaterial[]
  storageMaterial: EnvironmentDeployStorageMaterial[]
  principalMaterial: EnvironmentDeployPrincipalMaterial[]
}

export type DeployPrepareError =
  | { kind: 'health_check'; required: boolean; services: string[] }
  | { kind: 'resource_limit'; violations: ReturnType<typeof checkResourceLimits> }
  | { kind: 'empty_compose' }

async function sealVariableMaterialForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  material: DeployVariableMaterial[],
): Promise<EnvironmentDeployVariableMaterial[] | Response> {
  if (material.length === 0) return []

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const secretsConfig = c.get('secretsConfig')
  if (!dataEncryptionSecrets || !secretsConfig) {
    return Response.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return Response.json({ error: 'No encryption-capable daemon key on target server' }, 422)
  }
  const keyId = daemonState.key.id

  const sealed: EnvironmentDeployVariableMaterial[] = []
  for (const entry of material) {
    let envelope = entry.valueEnvelope
    if (entry.valueEnvelope.startsWith('tpsecret.')) {
      envelope = await resealSecretForDaemon(
        secretsConfig,
        dataEncryptionSecrets,
        { serverId, keyId },
        entry.valueEnvelope,
      )
    }
    sealed.push({
      key: entry.key,
      composeServiceName: entry.composeServiceName,
      forBuild: entry.forBuild,
      forRuntime: entry.forRuntime,
      isLiteral: entry.isLiteral,
      valueEnvelope: envelope,
    })
  }
  return sealed
}

async function loadStorageMaterial(
  db: Db,
  params: {
    environmentId: string
    projectId: string
    serverId: string
    serviceIds: string[]
    composeServiceNameByServiceId: Map<string, string>
  },
): Promise<EnvironmentDeployStorageMaterial[]> {
  const scopeConditions = [
    eq(storage.environmentId, params.environmentId),
    eq(storage.projectId, params.projectId),
  ]
  if (params.serviceIds.length > 0) {
    scopeConditions.push(inArray(storage.serviceId, params.serviceIds))
  }

  const rows = await db
    .select({
      id: storage.id,
      kind: storage.kind,
      name: storage.name,
      sourcePath: storage.sourcePath,
      destinationPath: storage.destinationPath,
      principalId: storage.principalId,
      contentEnvelope: storage.contentEnvelope,
      serviceId: storage.serviceId,
      serverId: storage.serverId,
    })
    .from(storage)
    .where(or(...scopeConditions))

  return rows
    .filter((row) => row.destinationPath && row.serverId === params.serverId)
    .map((row) => ({
      storageId: row.id,
      kind: row.kind as EnvironmentDeployStorageMaterial['kind'],
      name: row.name,
      sourcePath: row.sourcePath ?? undefined,
      destinationPath: row.destinationPath!,
      principalId: row.principalId ?? undefined,
      serviceId: row.serviceId ?? undefined,
      composeServiceName: row.serviceId
        ? params.composeServiceNameByServiceId.get(row.serviceId)
        : undefined,
      serverId: params.serverId,
      ...(row.contentEnvelope ? { contentEnvelope: row.contentEnvelope } : {}),
    }))
}

async function sealStorageMaterialForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  material: EnvironmentDeployStorageMaterial[],
): Promise<EnvironmentDeployStorageMaterial[] | Response> {
  if (material.length === 0) return []

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const secretsConfig = c.get('secretsConfig')
  const needsReseal = material.some((entry) => entry.contentEnvelope?.startsWith('tpsecret.'))
  if (!needsReseal) return material

  if (!dataEncryptionSecrets || !secretsConfig) {
    return Response.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return Response.json({ error: 'No encryption-capable daemon key on target server' }, 422)
  }
  const keyId = daemonState.key.id

  const sealed: EnvironmentDeployStorageMaterial[] = []
  for (const entry of material) {
    let contentEnvelope = entry.contentEnvelope
    if (contentEnvelope?.startsWith('tpsecret.')) {
      contentEnvelope = await resealSecretForDaemon(
        secretsConfig,
        dataEncryptionSecrets,
        { serverId, keyId },
        contentEnvelope,
      )
    }
    sealed.push({
      ...entry,
      ...(contentEnvelope ? { contentEnvelope } : {}),
    })
  }
  return sealed
}

async function loadPrincipalMaterial(
  db: Db,
  principalIds: string[],
): Promise<EnvironmentDeployPrincipalMaterial[]> {
  if (principalIds.length === 0) return []

  const uniqueIds = [...new Set(principalIds)]
  const rows = await db
    .select({
      id: principal.id,
      username: principal.username,
      metadata: principal.metadata,
    })
    .from(principal)
    .where(inArray(principal.id, uniqueIds))

  const material: EnvironmentDeployPrincipalMaterial[] = []
  for (const row of rows) {
    const meta = readPrincipalMetadata(row.metadata)
    if (!meta) continue
    material.push({
      principalId: row.id,
      username: row.username,
      uid: meta.uid,
      gid: meta.gid,
      ...(meta.home ? { home: meta.home } : {}),
    })
  }
  return material
}

export function mergeProjectEnvironmentCompose(
  projectOptions: unknown,
  environmentOptions: unknown,
): ComposeDocument | Response {
  try {
    const baseCompose = assertComposeDocument(extractComposeFromOptions(projectOptions))
    const overlayCompose = assertComposeDocument(extractComposeFromOptions(environmentOptions))
    return mergeComposeOverlay(stripComposePlacement(baseCompose), overlayCompose)
  } catch {
    return Response.json({ error: 'Invalid compose document' }, { status: 400 })
  }
}

function evaluateHealthCheckGates(
  merged: ComposeDocument,
  optionsByComposeName: ReturnType<typeof buildServiceOptionsMap>,
  acknowledgeHealthCheckWarnings: boolean | undefined,
): Extract<DeployPrepareError, { kind: 'health_check' }> | null {
  const healthWarnings = collectHealthCheckWarnings(merged, optionsByComposeName)
  const requiredMissing = healthWarnings.filter((w) => w.policy === 'required')
  if (requiredMissing.length > 0) {
    return {
      kind: 'health_check',
      required: true,
      services: requiredMissing.map((w) => w.composeServiceName),
    }
  }
  const warnMissing = healthWarnings.filter((w) => w.policy === 'warn')
  if (warnMissing.length > 0 && !acknowledgeHealthCheckWarnings) {
    return {
      kind: 'health_check',
      required: false,
      services: warnMissing.map((w) => w.composeServiceName),
    }
  }
  return null
}

async function mapResolvedVariablesToDeployEntries(
  map: ResolvedVariableMap,
  dataEncryptionSecrets: Parameters<typeof decryptSecret>[0] | undefined,
): Promise<DeployVariableEntry[]> {
  const entries: DeployVariableEntry[] = []
  for (const [key, entry] of map) {
    let value = entry.value
    if (entry.isSecret && dataEncryptionSecrets) {
      value = await decryptSecret(dataEncryptionSecrets, entry.value)
    }
    entries.push({
      key,
      value,
      isSecret: entry.isSecret,
      isLiteral: entry.isLiteral,
      forBuild: entry.forBuild,
      forRuntime: entry.forRuntime,
    })
  }
  return entries
}

type ServiceRow = {
  id: string
  metadata: unknown
  options: unknown
}

async function resolveDeployVariableBuckets(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    merged: ComposeDocument
    serviceRows: ServiceRow[]
    dataEncryptionSecrets: Parameters<typeof mapResolvedVariablesToDeployEntries>[1]
  },
): Promise<{
  globalEntries: DeployVariableEntry[]
  perServiceEntries: Map<string, DeployVariableEntry[]>
}> {
  const envVars = await resolveInheritedVariablesForEnvironment(db, params.environmentId)
  const serverVars = await resolveServerScopedVariables(db, params.serverId)
  const fallbackGlobal = new Map([...envVars, ...serverVars])
  const fallbackEntries = await mapResolvedVariablesToDeployEntries(
    fallbackGlobal,
    params.dataEncryptionSecrets,
  )

  const serviceRowByComposeName = new Map<string, ServiceRow>()
  for (const row of params.serviceRows) {
    serviceRowByComposeName.set(readComposeServiceName(row.metadata, row.id), row)
  }

  const composeServices = isPlainObject(params.merged.data.services)
    ? Object.keys(params.merged.data.services as Record<string, unknown>)
    : []

  const globalEntries: DeployVariableEntry[] = composeServices.length === 0
    ? fallbackEntries
    : []
  const perServiceEntries = new Map<string, DeployVariableEntry[]>()

  if (composeServices.length === 0) {
    return { globalEntries, perServiceEntries }
  }
  if (params.serviceRows.length === 0) {
    globalEntries.push(...fallbackEntries)
    return { globalEntries, perServiceEntries }
  }

  for (const composeServiceName of composeServices) {
    const row = serviceRowByComposeName.get(composeServiceName)
    const varMap = row
      ? await resolveInheritedVariablesForService(db, row.id)
      : fallbackGlobal
    const mergedServer = new Map([...varMap, ...serverVars])
    perServiceEntries.set(
      composeServiceName,
      await mapResolvedVariablesToDeployEntries(mergedServer, params.dataEncryptionSecrets),
    )
  }
  return { globalEntries, perServiceEntries }
}

export async function prepareDeployCompose(
  c: Context<AppEnv>,
  db: Db,
  params: {
    environmentId: string
    serverId: string
    organizationId: string
    acknowledgeHealthCheckWarnings?: boolean
  },
): Promise<PreparedDeployCompose | DeployPrepareError | Response> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      options: environment.options,
    })
    .from(environment)
    .where(eq(environment.id, params.environmentId))
    .limit(1)
  if (!envRow) return Response.json({ error: 'Not found' }, { status: 404 })

  const [projectRow] = await db
    .select({
      id: project.id,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return Response.json({ error: 'Not found' }, { status: 404 })

  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, params.organizationId))
    .limit(1)

  const [serverRow] = await db
    .select({ options: server.options })
    .from(server)
    .where(eq(server.id, params.serverId))
    .limit(1)

  const merged = mergeProjectEnvironmentCompose(projectRow.options, envRow.options)
  if (merged instanceof Response) return merged

  const composeServiceNames = isPlainObject(merged.data.services)
    ? Object.keys(merged.data.services as Record<string, unknown>)
    : []
  if (composeServiceNames.length === 0) {
    return { kind: 'empty_compose' }
  }

  await reconcileServicesFromCompose(db, params.environmentId, merged)

  const serviceRows = await db
    .select({
      id: service.id,
      metadata: service.metadata,
      options: service.options,
    })
    .from(service)
    .where(eq(service.environmentId, params.environmentId))

  const optionsByComposeName = buildServiceOptionsMap(
    serviceRows,
    readComposeServiceName,
    'unknown',
  )

  const orgLimits = parseResourceLimits(
    isPlainObject(orgRow?.options) ? orgRow.options.resourceLimits : null,
  ) ?? {}
  const serverLimits = parseResourceLimits(
    isPlainObject(serverRow?.options) ? serverRow.options.resourceLimits : null,
  ) ?? {}

  const usage = sumServiceResourceUsage(optionsByComposeName, composeServiceNames.length)
  const violations = checkResourceLimits(usage, orgLimits, serverLimits)
  if (violations.length > 0) {
    return { kind: 'resource_limit', violations }
  }

  const healthGate = evaluateHealthCheckGates(
    merged,
    optionsByComposeName,
    params.acknowledgeHealthCheckWarnings,
  )
  if (healthGate) return healthGate

  const { globalEntries, perServiceEntries } = await resolveDeployVariableBuckets(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    merged,
    serviceRows,
    dataEncryptionSecrets: c.get('dataEncryptionSecrets'),
  })

  const withVariables = applyVariablesToComposeDocument(merged, {
    globalEntries,
    perServiceEntries,
  })

  const withServiceOptions = applyServiceOptionsToComposeDocument(
    withVariables.document,
    optionsByComposeName,
  )

  const variableMaterial = await sealVariableMaterialForDaemon(
    c,
    db,
    params.serverId,
    withVariables.secretMaterial,
  )
  if (variableMaterial instanceof Response) return variableMaterial

  const composeServiceNameByServiceId = new Map<string, string>()
  for (const row of serviceRows) {
    composeServiceNameByServiceId.set(row.id, readComposeServiceName(row.metadata, row.id))
  }

  const storageMaterialRaw = await loadStorageMaterial(db, {
    environmentId: params.environmentId,
    projectId: envRow.projectId,
    serverId: params.serverId,
    serviceIds: serviceRows.map((row) => row.id),
    composeServiceNameByServiceId,
  })

  const storageMaterial = await sealStorageMaterialForDaemon(
    c,
    db,
    params.serverId,
    storageMaterialRaw,
  )
  if (storageMaterial instanceof Response) return storageMaterial

  const principalMaterial = await loadPrincipalMaterial(
    db,
    storageMaterial
      .map((entry) => entry.principalId)
      .filter((id): id is string => typeof id === 'string'),
  )

  return {
    composeYaml: composeDocumentToRuntimeYaml(withServiceOptions.document),
    hooks: withServiceOptions.hooks,
    variableMaterial,
    storageMaterial,
    principalMaterial,
  }
}

export function readHostingProxyFromOptions(options: unknown): EnvironmentDeployHosting['proxy'] {
  if (!isPlainObject(options)) return undefined
  const proxy = resolveHostingProxy({ proxy: isPlainObject(options.proxy) ? options.proxy : undefined })
  return {
    forceHttps: proxy.forceHttps,
    gzip: proxy.gzip,
    brotli: proxy.brotli,
    ...(proxy.stripPrefix ? { stripPrefix: proxy.stripPrefix } : {}),
  }
}

export { extractComposeFromOptions }
