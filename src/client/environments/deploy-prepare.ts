import type { Context } from 'hono'
import { and, eq, inArray, or } from 'drizzle-orm'
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
  emptyContainerComposeYaml,
  mergeComposeOverlay,
  splitTraditionalWebServices,
  stripComposePlacement,
  type ComposeDocument,
  type TraditionalWebSiteSpec,
} from '../../lib/compose/index.ts'
import {
  collectComposeExternalDockerNetworkNames,
  pruneUnreferencedComposeNetworks,
} from '../../lib/compose/docker-external-networks.ts'
import { validateRegisteredExternalDockerNetworks } from './validate-docker-external-networks.ts'
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeployTraditionalWebPrincipal,
  EnvironmentDeployTraditionalWebSite,
  EnvironmentDeployVariableMaterial,
} from '../../lib/commands/schemas.ts'
import {
  environment,
  ip,
  organization,
  principal,
  project,
  server,
  service,
  storage,
} from '../../lib/db/schema.ts'
import { parseResourceLimits, checkResourceLimits, sumServiceResourceUsage } from '../../lib/resource-limits.ts'
import {
  parseHostingOptions,
  resolveHostingBind,
  resolveHostingProxy,
} from '../../lib/hosting-options.ts'
import { isValidIpAddress } from '../../lib/ip-address.ts'
import { reconcileServicesFromCompose } from './reconcile-services.ts'
import type { Db } from '../../db.ts'
import {
  mergeHostingVariablesForService,
  resolveInheritedVariablesForEnvironment,
  resolveInheritedVariablesForService,
  resolveServerScopedVariables,
  type ResolvedVariableMap,
} from '../variables/resolve-inherited.ts'
import {
  loadPrincipalIdsAssignedToEnvironment,
  loadPrincipalIdsByServiceIdForEnvironment,
  pickSolePrincipalId,
} from '../principals/assignments.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when `serverId` belongs to `organizationId`. */
export async function verifyServerInOrg(
  db: Db,
  serverId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  return Boolean(row)
}

function readComposeServiceName(
  composeServiceName: string | null | undefined,
  fallback: string,
): string {
  if (typeof composeServiceName === 'string' && composeServiceName.length > 0) {
    return composeServiceName
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
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[]
  /** External Docker network names declared in compose — must be registered on the server. */
  dockerExternalNetworks: string[]
}

export type DeployPrepareError =
  | { kind: 'health_check'; required: boolean; services: string[] }
  | { kind: 'resource_limit'; violations: ReturnType<typeof checkResourceLimits> }
  | { kind: 'empty_compose' }
  | { kind: 'datacenter_ip_required'; serverId: string }
  | { kind: 'docker_external_network_unregistered'; names: string[] }
  | { kind: 'traditional_web_principal_ambiguous'; composeServiceName: string }

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
    // Placement is never stored in compose — strip both sides before merge.
    return mergeComposeOverlay(
      stripComposePlacement(baseCompose),
      stripComposePlacement(overlayCompose),
    )
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
  composeServiceName: string | null
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
    serviceRowByComposeName.set(
      readComposeServiceName(row.composeServiceName, row.id),
      row,
    )
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
    let varMap: ResolvedVariableMap
    if (row) {
      varMap = await resolveInheritedVariablesForService(db, row.id)
      // Hostname-scoped vars override service scope for compose injection.
      await mergeHostingVariablesForService(db, row.id, varMap)
    } else {
      varMap = fallbackGlobal
    }
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
      composeServiceName: service.composeServiceName,
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
    composeServiceNameByServiceId.set(
      row.id,
      readComposeServiceName(row.composeServiceName, row.id),
    )
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

  const assignmentPrincipalIds = await loadPrincipalIdsAssignedToEnvironment(
    db,
    params.environmentId,
  )
  const storagePrincipalIds = storageMaterial
    .map((entry) => entry.principalId)
    .filter((id): id is string => typeof id === 'string')
  const principalMaterial = await loadPrincipalMaterial(db, [
    ...assignmentPrincipalIds,
    ...storagePrincipalIds,
  ])

  const split = splitTraditionalWebFromDocument(withServiceOptions.document)

  // Drop traditional-web hooks — they are not Docker compose services.
  const traditionalNames = new Set(
    split.sites.map((site) => site.composeServiceName),
  )
  const hooks = withServiceOptions.hooks.filter(
    (hook) => !traditionalNames.has(hook.composeServiceName),
  )

  const traditionalWebSitesOrError = await attachPrincipalsToTraditionalWebSites(
    db,
    params.environmentId,
    serviceRows,
    principalMaterial,
    split.sites,
  )
  if ('kind' in traditionalWebSitesOrError) return traditionalWebSitesOrError

  const dockerExternalNetworks = collectComposeExternalDockerNetworkNames(
    split.composeYaml,
  )
  const unregisteredDockerNetworks = await validateRegisteredExternalDockerNetworks(
    db,
    params.organizationId,
    params.serverId,
    dockerExternalNetworks,
  )
  if (unregisteredDockerNetworks) {
    return {
      kind: 'docker_external_network_unregistered',
      names: unregisteredDockerNetworks,
    }
  }

  return {
    composeYaml: split.composeYaml,
    hooks,
    variableMaterial,
    storageMaterial,
    principalMaterial,
    traditionalWebSites: traditionalWebSitesOrError,
    dockerExternalNetworks,
  }
}

/**
 * Pin each traditional-web site to at most one assigned project principal.
 * Multiple principals on the same service is ambiguous ownership → prepare error.
 */
export async function attachPrincipalsToTraditionalWebSites(
  db: Db,
  environmentId: string,
  serviceRows: ReadonlyArray<{ id: string; composeServiceName: string | null }>,
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[],
  sites: readonly TraditionalWebSiteSpec[],
): Promise<
  | EnvironmentDeployTraditionalWebSite[]
  | { kind: 'traditional_web_principal_ambiguous'; composeServiceName: string }
> {
  if (sites.length === 0) return []

  const principalById = new Map(
    principalMaterial.map((entry) => [entry.principalId, entry]),
  )
  const principalIdsByServiceId = await loadPrincipalIdsByServiceIdForEnvironment(
    db,
    environmentId,
  )
  const serviceIdByComposeName = new Map<string, string>()
  for (const row of serviceRows) {
    serviceIdByComposeName.set(
      readComposeServiceName(row.composeServiceName, row.id),
      row.id,
    )
  }

  const out: EnvironmentDeployTraditionalWebSite[] = []
  for (const site of sites) {
    const serviceId = serviceIdByComposeName.get(site.composeServiceName)
    const assignedIds = serviceId
      ? (principalIdsByServiceId.get(serviceId) ?? [])
      : []
    const sole = pickSolePrincipalId(assignedIds)
    if (sole.status === 'ambiguous') {
      return {
        kind: 'traditional_web_principal_ambiguous',
        composeServiceName: site.composeServiceName,
      }
    }
    const material = sole.status === 'one'
      ? principalById.get(sole.principalId)
      : undefined
    const principalPin = material
      ? toTraditionalWebPrincipal(material)
      : undefined
    out.push({
      ...site,
      ...(principalPin ? { principal: principalPin } : {}),
    })
  }
  return out
}

function toTraditionalWebPrincipal(
  material: EnvironmentDeployPrincipalMaterial,
): EnvironmentDeployTraditionalWebPrincipal {
  return {
    principalId: material.principalId,
    username: material.username,
    uid: material.uid,
    gid: material.gid,
  }
}

function splitTraditionalWebFromDocument(document: ComposeDocument): {
  composeYaml: string
  sites: TraditionalWebSiteSpec[]
} {
  const services = isPlainObject(document.data.services)
    ? (document.data.services as Record<string, unknown>)
    : {}
  const { containerServices, sites } = splitTraditionalWebServices(services)

  if (Object.keys(containerServices).length === 0) {
    return {
      composeYaml: emptyContainerComposeYaml(),
      sites,
    }
  }

  const existingNetworks = isPlainObject(document.data.networks)
    ? (document.data.networks as Record<string, unknown>)
    : undefined
  const prunedNetworks = pruneUnreferencedComposeNetworks(
    containerServices,
    existingNetworks,
  )

  const nextData: Record<string, unknown> = {
    ...document.data,
    services: containerServices,
  }
  if (prunedNetworks) {
    nextData.networks = prunedNetworks
  } else {
    delete nextData.networks
  }

  const containerDocument: ComposeDocument = {
    ...document,
    data: nextData,
  }
  return {
    composeYaml: composeDocumentToRuntimeYaml(containerDocument),
    sites,
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

function inetAddressToString(address: unknown): string | undefined {
  if (typeof address !== 'string') return undefined
  const trimmed = address.trim()
  if (!isValidIpAddress(trimmed)) return undefined
  return trimmed
}

/**
 * Resolve the Caddy `bind` address for one hosting entry at deploy-prepare time
 * so the daemon stays DB-free. Returns `undefined` when no bind directive should
 * be emitted (public bind with no pinned IP).
 */
export async function resolveHostingBindAddress(
  db: Db,
  params: Readonly<{
    serverId: string
    options: unknown
    ipId: string | null
  }>,
): Promise<string | undefined | Extract<DeployPrepareError, { kind: 'datacenter_ip_required' }>> {
  const bind = resolveHostingBind(parseHostingOptions(params.options))

  if (bind === 'local') return '127.0.0.1'

  if (bind === 'datacenter') {
    const [row] = await db
      .select({ address: ip.address })
      .from(ip)
      .where(and(eq(ip.serverId, params.serverId), eq(ip.scope, 'datacenter')))
      .limit(1)
    const address = inetAddressToString(row?.address)
    if (!address) {
      return { kind: 'datacenter_ip_required', serverId: params.serverId }
    }
    return address
  }

  // public (default)
  if (!params.ipId) return undefined

  const [row] = await db
    .select({ address: ip.address, serverId: ip.serverId })
    .from(ip)
    .where(eq(ip.id, params.ipId))
    .limit(1)
  if (!row) {
    throw new Error('hosting ip pin not found')
  }
  if (row.serverId !== null && row.serverId !== params.serverId) {
    throw new Error('hosting ip pin server mismatch')
  }
  const address = inetAddressToString(row.address)
  if (!address) {
    throw new Error('hosting ip pin address invalid')
  }
  return address
}

export { extractComposeFromOptions }
