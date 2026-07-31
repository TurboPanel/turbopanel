import type { Context } from 'hono'
import { and, eq, inArray, or } from 'drizzle-orm'
import type { AppEnv } from '../../app.ts'
import {
  decryptSecret,
  ENVELOPE_MAGIC,
  resealSecretForDaemon,
} from '../authn/data-encryption.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import {
  applyServiceOptionsToComposeDocument,
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
  type ServiceDeployHook,
  type ServiceOptionsByComposeName,
} from '../../lib/compose/apply-service-options.ts'
import {
  applyVariablesToComposeDocument,
  injectSecretPlaceholdersIntoComposeDocument,
  type DeployVariableEntry,
  type DeployVariableMaterial,
} from '../../lib/compose/apply-variables.ts'
import { expandComposeServiceInstances } from '../../lib/compose/expand-instances.ts'
import {
  assertComposeDocument,
  composeDocumentToRuntimeYaml,
  emptyContainerComposeYaml,
  isTraditionalWebComposeService,
  mergeComposeOverlay,
  splitTraditionalWebServices,
  stripComposePlacement,
  type ComposeDocument,
  type TraditionalWebSiteSpec,
} from '../../lib/compose/index.ts'
import {
  buildPlatformDeployVariables,
  stripReservedDeployVariableKeys,
} from '../../lib/compose/platform-variables.ts'
import { renameComposeVolumes } from '../../lib/compose/rename-volumes.ts'
import {
  collectComposeExternalDockerNetworkNames,
  pruneUnreferencedComposeNetworks,
} from '../../lib/compose/docker-external-networks.ts'
import {
  principalHomeDir,
  principalVolumePath,
  resolveDockerVolumeName,
} from '../../lib/naming.ts'
import {
  parsePrincipalOptions,
  resolvePrincipalShell,
} from '../../lib/principal-options.ts'
import {
  parseProjectOptions,
  resolveContainerNaming,
} from '../../lib/project-options.ts'
import {
  parseServiceOptions,
  resolveServiceInstances,
  type ServiceOptions,
} from '../../lib/service-options.ts'
import { validateRegisteredExternalDockerNetworks } from './validate-docker-external-networks.ts'
import {
  allocateEnvironmentContainers,
  buildContainerServiceSpecs,
  ensureServiceIngressContainerAllocation,
  type ContainerAllocation,
} from './allocate-containers.ts'
import { resolveTcpUdpIngressServices } from './tcp-udp-ingress.ts'
import {
  registerComposeVolumes,
  type RegisteredComposeVolume,
} from './register-compose-volumes.ts'
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployIngressService,
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

function extractComposeFromOptions(options: unknown): unknown {
  if (!isPlainObject(options)) return null
  return options.compose ?? null
}

function readPrincipalMetadata(metadata: unknown): { uid: number; gid: number } | null {
  if (!isPlainObject(metadata)) return null
  const uid = metadata.uid
  const gid = metadata.gid
  if (typeof uid !== 'number' || typeof gid !== 'number') return null
  return { uid, gid }
}

export type DeployPrepareWarningCode =
  | 'empty_compose'
  | 'resource_limit_exceeded'
  | 'health_check_missing'
  | 'docker_external_network_unregistered'
  | 'traditional_web_principal_ambiguous'

export type DeployPrepareWarning = {
  code: DeployPrepareWarningCode
  message: string
  details?: Record<string, unknown>
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
  /** Pre-allocated container rows for this deploy (uuid / explicit-name paths). */
  containers: ContainerAllocation[]
  /**
   * Per-service tcp/udp Traefik ingress allocations (`<service.id>-ingress`).
   * Empty when no service publishes raw ports.
   */
  ingressServices: EnvironmentDeployIngressService[]
  /** Original compose service key → clone keys after multi-instance expansion. */
  composeServiceExpansion: Record<string, string[]>
  /** Auto-registered compose named volumes (storage rows + resolved Docker names). */
  volumes: RegisteredComposeVolume[]
  /** Soft prepare issues (preview mode); empty for deploy. */
  warnings: DeployPrepareWarning[]
}

export type DeployPrepareError =
  | { kind: 'health_check'; required: boolean; services: string[] }
  | { kind: 'resource_limit'; violations: ReturnType<typeof checkResourceLimits> }
  | { kind: 'empty_compose' }
  | { kind: 'datacenter_ip_required'; serverId: string }
  | { kind: 'docker_external_network_unregistered'; names: string[] }
  | { kind: 'traditional_web_principal_ambiguous'; composeServiceName: string }

export type DeployPrepareMode = 'deploy' | 'preview'

function emptyPreparedCompose(
  warnings: DeployPrepareWarning[],
): PreparedDeployCompose {
  return {
    composeYaml: emptyContainerComposeYaml(),
    hooks: [],
    variableMaterial: [],
    storageMaterial: [],
    principalMaterial: [],
    traditionalWebSites: [],
    dockerExternalNetworks: [],
    containers: [],
    ingressServices: [],
    composeServiceExpansion: {},
    volumes: [],
    warnings,
  }
}

function warningFromPrepareError(
  error: Exclude<DeployPrepareError, { kind: 'datacenter_ip_required' }>,
): DeployPrepareWarning {
  switch (error.kind) {
    case 'empty_compose':
      return {
        code: 'empty_compose',
        message: 'Compose has no services to deploy.',
      }
    case 'resource_limit':
      return {
        code: 'resource_limit_exceeded',
        message: 'Requested resources exceed organization or server limits.',
        details: { violations: error.violations },
      }
    case 'health_check':
      return {
        code: 'health_check_missing',
        message: error.required
          ? 'One or more services require a health check before deploy.'
          : 'One or more services are missing a health check (warn policy).',
        details: {
          required: error.required,
          services: error.services,
        },
      }
    case 'docker_external_network_unregistered':
      return {
        code: 'docker_external_network_unregistered',
        message:
          'Compose references external Docker network(s) that are not registered for this server.',
        details: { names: error.names },
      }
    case 'traditional_web_principal_ambiguous':
      return {
        code: 'traditional_web_principal_ambiguous',
        message:
          `Traditional-web service "${error.composeServiceName}" has more than one project principal assigned.`,
        details: { composeServiceName: error.composeServiceName },
      }
  }
}

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
    if (entry.valueEnvelope.startsWith(`${ENVELOPE_MAGIC}.`)) {
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

function readPinnedDockerVolumeName(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) return null
  if (typeof metadata.dockerVolumeName !== 'string') return null
  return metadata.dockerVolumeName.length > 0 ? metadata.dockerVolumeName : null
}

function storageRowSurvivesFilter(
  row: { kind: string; destinationPath: string | null; serverId: string | null },
  serverId: string,
): boolean {
  if (row.serverId !== serverId) return false
  if (row.kind === 'docker_volume') return true
  return Boolean(row.destinationPath)
}

type StorageQueryRow = {
  id: string
  kind: string
  name: string
  sourcePath: string | null
  destinationPath: string | null
  principalId: string | null
  contentEnvelope: string | null
  serviceId: string | null
  serverId: string | null
  metadata: unknown
}

/** Principal-owned bind mounts without an explicit source_path use the canonical path. */
function resolveBindMountSourcePath(row: StorageQueryRow): string | undefined {
  const sourcePath = row.sourcePath ?? undefined
  if (sourcePath !== undefined && sourcePath.length > 0) return sourcePath
  if (
    row.kind !== 'bind_mount' ||
    typeof row.principalId !== 'string' ||
    row.principalId.length === 0
  ) {
    return sourcePath
  }
  return principalVolumePath(row.principalId, row.id)
}

function toStorageMaterialEntry(
  row: StorageQueryRow,
  organizationId: string,
  serverId: string,
): EnvironmentDeployStorageMaterial {
  const base: EnvironmentDeployStorageMaterial = {
    storageId: row.id,
    kind: row.kind as EnvironmentDeployStorageMaterial['kind'],
    name: row.name,
    sourcePath: resolveBindMountSourcePath(row),
    ...(row.destinationPath ? { destinationPath: row.destinationPath } : {}),
    principalId: row.principalId ?? undefined,
    serviceId: row.serviceId ?? undefined,
    serverId,
    ...(row.contentEnvelope ? { contentEnvelope: row.contentEnvelope } : {}),
  }
  if (row.kind === 'docker_volume') {
    base.volumeName = resolveDockerVolumeName({
      storageId: row.id,
      organizationId,
      name: row.name,
      pinnedName: readPinnedDockerVolumeName(row.metadata),
    })
  }
  return base
}

function pushStorageMaterialEntries(
  material: EnvironmentDeployStorageMaterial[],
  base: EnvironmentDeployStorageMaterial,
  cloneNames: string[] | undefined,
): void {
  if (!base.serviceId || !cloneNames || cloneNames.length === 0) {
    material.push(base)
    return
  }
  for (const cloneName of cloneNames) {
    material.push({
      ...base,
      composeServiceName: cloneName,
    })
  }
}

function appendUnseenRegisteredVolumes(
  material: EnvironmentDeployStorageMaterial[],
  seenStorageIds: ReadonlySet<string>,
  registeredVolumes: readonly RegisteredComposeVolume[],
  serverId: string,
): void {
  for (const registered of registeredVolumes) {
    if (seenStorageIds.has(registered.storageId)) continue
    material.push({
      storageId: registered.storageId,
      kind: 'docker_volume',
      name: registered.composeKey,
      serverId,
      volumeName: registered.volumeName,
    })
  }
}

export async function loadStorageMaterial(
  db: Db,
  params: {
    environmentId: string
    projectId: string
    organizationId: string
    serverId: string
    serviceIds: string[]
    /** Origin service id → clone compose keys (for service-scoped fan-out). */
    cloneNamesByServiceId: Map<string, string[]>
    registeredVolumes: readonly RegisteredComposeVolume[]
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
      metadata: storage.metadata,
    })
    .from(storage)
    .where(or(...scopeConditions))

  const material: EnvironmentDeployStorageMaterial[] = []
  const seenStorageIds = new Set<string>()

  for (const row of rows) {
    if (!storageRowSurvivesFilter(row, params.serverId)) continue
    seenStorageIds.add(row.id)
    const base = toStorageMaterialEntry(row, params.organizationId, params.serverId)
    const cloneNames = row.serviceId
      ? params.cloneNamesByServiceId.get(row.serviceId)
      : undefined
    pushStorageMaterialEntries(material, base, cloneNames)
  }

  appendUnseenRegisteredVolumes(
    material,
    seenStorageIds,
    params.registeredVolumes,
    params.serverId,
  )
  return material
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
  const needsReseal = material.some((entry) =>
    entry.contentEnvelope?.startsWith(`${ENVELOPE_MAGIC}.`),
  )
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
    if (contentEnvelope?.startsWith(`${ENVELOPE_MAGIC}.`)) {
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

export async function loadPrincipalMaterial(
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
      options: principal.options,
    })
    .from(principal)
    .where(inArray(principal.id, uniqueIds))

  const material: EnvironmentDeployPrincipalMaterial[] = []
  for (const row of rows) {
    const meta = readPrincipalMetadata(row.metadata)
    if (!meta) continue
    // naming.ts is the single source of truth for home; metadata.home is a
    // mirror for display only (legacy /var/lib/… paths are corrected on deploy).
    material.push({
      principalId: row.id,
      username: row.username,
      uid: meta.uid,
      gid: meta.gid,
      home: principalHomeDir(row.id),
      shell: resolvePrincipalShell(parsePrincipalOptions(row.options)),
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
  composeServiceName: string
  options: unknown
}

async function resolveDeployVariableBuckets(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    composeServiceNames: readonly string[]
    /** Clone compose key → origin service row (same row for every clone). */
    serviceRowByComposeName: Map<string, ServiceRow>
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

  const composeServices = params.composeServiceNames
  const globalEntries: DeployVariableEntry[] = composeServices.length === 0
    ? fallbackEntries
    : []
  const perServiceEntries = new Map<string, DeployVariableEntry[]>()

  if (composeServices.length === 0) {
    return { globalEntries, perServiceEntries }
  }
  if (params.serviceRowByComposeName.size === 0) {
    globalEntries.push(...fallbackEntries)
    return { globalEntries, perServiceEntries }
  }

  // Cache user vars per origin service id so clones share one resolve.
  const userEntriesByServiceId = new Map<string, DeployVariableEntry[]>()

  for (const composeServiceName of composeServices) {
    const row = params.serviceRowByComposeName.get(composeServiceName)
    let userEntries: DeployVariableEntry[]
    if (row) {
      let cached = userEntriesByServiceId.get(row.id)
      if (!cached) {
        const varMap = await resolveInheritedVariablesForService(db, row.id)
        await mergeHostingVariablesForService(db, row.id, varMap)
        const mergedServer = new Map([...varMap, ...serverVars])
        cached = await mapResolvedVariablesToDeployEntries(
          mergedServer,
          params.dataEncryptionSecrets,
        )
        userEntriesByServiceId.set(row.id, cached)
      }
      userEntries = cached
    } else {
      userEntries = fallbackEntries
    }
    perServiceEntries.set(composeServiceName, userEntries)
  }
  return { globalEntries, perServiceEntries }
}

function listContainerComposeNames(document: ComposeDocument): Set<string> {
  const services = isPlainObject(document.data.services)
    ? (document.data.services as Record<string, unknown>)
    : {}
  const names = new Set<string>()
  for (const [name, raw] of Object.entries(services)) {
    if (isPlainObject(raw) && isTraditionalWebComposeService(raw)) continue
    names.add(name)
  }
  return names
}

function buildExpandedServiceOptionsMap(
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>,
  allocations: readonly ContainerAllocation[],
): ServiceOptionsByComposeName {
  const originOptions = buildServiceOptionsMap(serviceRows)
  const allocationByClone = new Map(
    allocations.map((row) => [row.cloneComposeServiceName, row]),
  )
  const map: ServiceOptionsByComposeName = new Map()

  for (const [originName, clones] of expansion) {
    const origin = originOptions.get(originName) ?? {}
    for (const cloneName of clones) {
      const parsed: ServiceOptions = { ...origin }
      // Allocation is the single source of truth for container_name — including
      // explicit options.container.name (with per-ordinal suffixes when N > 1).
      const allocation = allocationByClone.get(cloneName)
      if (allocation) {
        parsed.container = {
          ...parsed.container,
          name: allocation.containerName,
        }
      }
      map.set(cloneName, parsed)
    }
  }
  return map
}

function appendPlatformVariablesToEntries(
  perServiceEntries: Map<string, DeployVariableEntry[]>,
  params: {
    projectId: string
    environmentId: string
    serviceRowByCloneName: Map<string, ServiceRow>
    allocationByClone: Map<string, ContainerAllocation>
  },
): Map<string, DeployVariableEntry[]> {
  const next = new Map<string, DeployVariableEntry[]>()
  for (const [cloneName, userEntries] of perServiceEntries) {
    const stripped = stripReservedDeployVariableKeys(userEntries)
    const row = params.serviceRowByCloneName.get(cloneName)
    const allocation = params.allocationByClone.get(cloneName)
    const platform = row
      ? buildPlatformDeployVariables({
        projectId: params.projectId,
        environmentId: params.environmentId,
        serviceId: row.id,
        ...(allocation
          ? {
            containerId: allocation.containerRowId,
            containerName: allocation.containerName,
          }
          : {}),
      })
      : []
    next.set(cloneName, [...stripped, ...platform])
  }
  return next
}

function expansionToRecord(expansion: Map<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, value] of expansion) {
    out[key] = value
  }
  return out
}

function buildCloneNamesByServiceId(
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>,
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const row of serviceRows) {
    map.set(row.id, expansion.get(row.composeServiceName) ?? [row.composeServiceName])
  }
  return map
}

/** Soft prepare errors that preview can absorb into `warnings`. */
type SoftDeployPrepareError = Exclude<
  DeployPrepareError,
  { kind: 'datacenter_ip_required' }
>

function absorbSoftPrepareError(
  mode: DeployPrepareMode,
  warnings: DeployPrepareWarning[],
  error: SoftDeployPrepareError | null | undefined,
): SoftDeployPrepareError | null {
  if (!error) return null
  if (mode === 'preview') {
    warnings.push(warningFromPrepareError(error))
    return null
  }
  return error
}

function listComposeServiceKeys(document: ComposeDocument): string[] {
  if (!isPlainObject(document.data.services)) return []
  return Object.keys(document.data.services as Record<string, unknown>)
}

function emptyComposePrepareResult(
  mode: DeployPrepareMode,
): PreparedDeployCompose | DeployPrepareError {
  if (mode === 'preview') {
    return emptyPreparedCompose([warningFromPrepareError({ kind: 'empty_compose' })])
  }
  return { kind: 'empty_compose' }
}

function buildInstancesByComposeName(
  composeServiceNames: readonly string[],
  containerServices: ReturnType<typeof buildContainerServiceSpecs>,
  serviceRows: ServiceRow[],
): Map<string, number> {
  const instancesByComposeName = new Map<string, number>()
  for (const spec of containerServices) {
    instancesByComposeName.set(spec.composeServiceName, spec.instances)
  }
  // Traditional-web keeps count 1 (expansion skips them regardless).
  for (const name of composeServiceNames) {
    if (instancesByComposeName.has(name)) continue
    const row = serviceRows.find((serviceRow) => serviceRow.composeServiceName === name)
    instancesByComposeName.set(
      name,
      resolveServiceInstances(parseServiceOptions(row?.options) ?? {}),
    )
  }
  return instancesByComposeName
}

function buildServiceRowByCloneName(
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>,
): Map<string, ServiceRow> {
  const serviceRowByCloneName = new Map<string, ServiceRow>()
  for (const row of serviceRows) {
    for (const cloneName of expansion.get(row.composeServiceName) ?? [row.composeServiceName]) {
      serviceRowByCloneName.set(cloneName, row)
    }
  }
  return serviceRowByCloneName
}

function resourceLimitPrepareError(
  optionsByComposeName: ServiceOptionsByComposeName,
  serviceCount: number,
  orgOptions: unknown,
  serverOptions: unknown,
): SoftDeployPrepareError | null {
  const orgLimits = parseResourceLimits(
    isPlainObject(orgOptions) ? orgOptions.resourceLimits : null,
  ) ?? {}
  const serverLimits = parseResourceLimits(
    isPlainObject(serverOptions) ? serverOptions.resourceLimits : null,
  ) ?? {}
  const usage = sumServiceResourceUsage(optionsByComposeName, serviceCount)
  const violations = checkResourceLimits(usage, orgLimits, serverLimits)
  if (violations.length === 0) return null
  return { kind: 'resource_limit', violations }
}

async function loadDeployEnvAndProject(
  db: Db,
  environmentId: string,
): Promise<
  | {
    envRow: { id: string; projectId: string; options: unknown }
    projectRow: { id: string; options: unknown }
  }
  | Response
> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      options: environment.options,
    })
    .from(environment)
    .where(eq(environment.id, environmentId))
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

  return { envRow, projectRow }
}

type DeployExpandPipeline = {
  containers: ContainerAllocation[]
  ingressServices: EnvironmentDeployIngressService[]
  registeredVolumes: RegisteredComposeVolume[]
  expandedDocument: ComposeDocument
  expansion: Map<string, string[]>
  expandedServiceNames: string[]
  optionsByComposeName: ServiceOptionsByComposeName
}

async function allocateExpandDeployPipeline(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    organizationId: string
    projectOptions: unknown
    merged: ComposeDocument
    composeServiceNames: readonly string[]
    serviceRows: ServiceRow[]
  },
): Promise<DeployExpandPipeline> {
  const containerNaming = resolveContainerNaming(parseProjectOptions(params.projectOptions))
  const containerComposeNames = listContainerComposeNames(params.merged)
  const containerServices = buildContainerServiceSpecs(
    params.serviceRows,
    containerComposeNames,
  )

  // Per-service tcp/udp Traefik rows — allocated before app prune so their
  // containerRowIds stay in keepIds; HTTP-only services drop out of resolve
  // and their stale pending ingress rows are swept.
  const tcpUdpServices = await resolveTcpUdpIngressServices(db, params.environmentId)
  const ingressServices: EnvironmentDeployIngressService[] = []
  const ingressKeepIds = new Set<string>()
  for (const svc of tcpUdpServices) {
    const alloc = await ensureServiceIngressContainerAllocation(db, {
      serviceId: svc.serviceId,
      serverId: params.serverId,
      composeServiceName: svc.composeServiceName,
    })
    ingressKeepIds.add(alloc.containerRowId)
    ingressServices.push({
      serviceId: alloc.serviceId,
      composeServiceName: alloc.composeServiceName,
      containerName: alloc.containerName,
    })
  }

  // Idempotent by (service, ordinal) — preview may allocate; deploy reuses rows.
  const containers = await allocateEnvironmentContainers(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    containerServices,
    containerNaming,
    environmentServiceIds: params.serviceRows.map((row) => row.id),
    extraKeepIds: ingressKeepIds,
  })

  // Idempotent by (environment, composeVolumeKey) — preview may register; deploy reuses.
  const registeredVolumes = await registerComposeVolumes(db, {
    document: params.merged,
    organizationId: params.organizationId,
    environmentId: params.environmentId,
    serverId: params.serverId,
  })
  const volumeRenames = new Map(
    registeredVolumes.map((row) => [row.composeKey, row.volumeName]),
  )
  const withRenamedVolumes = renameComposeVolumes(params.merged, volumeRenames)
  const instancesByComposeName = buildInstancesByComposeName(
    params.composeServiceNames,
    containerServices,
    params.serviceRows,
  )
  const { document: expandedDocument, expansion } = expandComposeServiceInstances(
    withRenamedVolumes,
    instancesByComposeName,
  )
  return {
    containers,
    ingressServices,
    registeredVolumes,
    expandedDocument,
    expansion,
    expandedServiceNames: listComposeServiceKeys(expandedDocument),
    optionsByComposeName: buildExpandedServiceOptionsMap(
      params.serviceRows,
      expansion,
      containers,
    ),
  }
}

function documentForServiceOptions(
  mode: DeployPrepareMode,
  withVariables: ReturnType<typeof applyVariablesToComposeDocument>,
): ComposeDocument {
  if (mode === 'preview') {
    return injectSecretPlaceholdersIntoComposeDocument(
      withVariables.document,
      withVariables.secretMaterial,
    )
  }
  return withVariables.document
}

async function maybeSealDeployMaterials(
  mode: DeployPrepareMode,
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  secretMaterial: DeployVariableMaterial[],
  storageMaterialRaw: EnvironmentDeployStorageMaterial[],
): Promise<
  | {
    variableMaterial: EnvironmentDeployVariableMaterial[]
    storageMaterial: EnvironmentDeployStorageMaterial[]
  }
  | Response
> {
  // Preview must not require an online daemon — skip sealing / daemon-key steps.
  if (mode === 'preview') {
    return { variableMaterial: [], storageMaterial: storageMaterialRaw }
  }
  const variableMaterial = await sealVariableMaterialForDaemon(
    c,
    db,
    serverId,
    secretMaterial,
  )
  if (variableMaterial instanceof Response) return variableMaterial
  const storageMaterial = await sealStorageMaterialForDaemon(
    c,
    db,
    serverId,
    storageMaterialRaw,
  )
  if (storageMaterial instanceof Response) return storageMaterial
  return { variableMaterial, storageMaterial }
}

function resolveTraditionalWebSitesForMode(
  mode: DeployPrepareMode,
  warnings: DeployPrepareWarning[],
  sitesOrError:
    | EnvironmentDeployTraditionalWebSite[]
    | { kind: 'traditional_web_principal_ambiguous'; composeServiceName: string },
  fallbackSites: readonly TraditionalWebSiteSpec[],
): EnvironmentDeployTraditionalWebSite[] | SoftDeployPrepareError {
  if (!('kind' in sitesOrError)) return sitesOrError
  if (mode === 'preview') {
    warnings.push(warningFromPrepareError(sitesOrError))
    return fallbackSites.map((site) => ({ ...site }))
  }
  return sitesOrError
}

async function externalNetworkPrepareError(
  db: Db,
  organizationId: string,
  serverId: string,
  dockerExternalNetworks: string[],
): Promise<SoftDeployPrepareError | null> {
  const unregistered = await validateRegisteredExternalDockerNetworks(
    db,
    organizationId,
    serverId,
    dockerExternalNetworks,
  )
  if (!unregistered) return null
  return {
    kind: 'docker_external_network_unregistered',
    names: unregistered,
  }
}

function toPreparedDeployResult(
  mode: DeployPrepareMode,
  parts: {
    composeYaml: string
    hooks: ServiceDeployHook[]
    variableMaterial: EnvironmentDeployVariableMaterial[]
    storageMaterial: EnvironmentDeployStorageMaterial[]
    principalMaterial: EnvironmentDeployPrincipalMaterial[]
    traditionalWebSites: EnvironmentDeployTraditionalWebSite[]
    dockerExternalNetworks: string[]
    containers: ContainerAllocation[]
    ingressServices: EnvironmentDeployIngressService[]
    expansion: Map<string, string[]>
    registeredVolumes: RegisteredComposeVolume[]
    warnings: DeployPrepareWarning[]
  },
): PreparedDeployCompose {
  const omitSecrets = mode === 'preview'
  return {
    composeYaml: parts.composeYaml,
    hooks: parts.hooks,
    variableMaterial: omitSecrets ? [] : parts.variableMaterial,
    storageMaterial: omitSecrets ? [] : parts.storageMaterial,
    principalMaterial: parts.principalMaterial,
    traditionalWebSites: parts.traditionalWebSites,
    dockerExternalNetworks: parts.dockerExternalNetworks,
    containers: parts.containers,
    ingressServices: parts.ingressServices,
    composeServiceExpansion: expansionToRecord(parts.expansion),
    volumes: parts.registeredVolumes,
    warnings: parts.warnings,
  }
}

export async function prepareDeployCompose(
  c: Context<AppEnv>,
  db: Db,
  params: {
    environmentId: string
    serverId: string
    organizationId: string
    acknowledgeHealthCheckWarnings?: boolean
    /**
     * `preview` skips daemon sealing, softens prepare gates into `warnings`,
     * and redacts secret values in the returned YAML. Allocation + volume
     * registration still run (idempotent) so previewed UUIDs match deploy.
     */
    mode?: DeployPrepareMode
  },
): Promise<PreparedDeployCompose | DeployPrepareError | Response> {
  const mode = params.mode ?? 'deploy'
  const warnings: DeployPrepareWarning[] = []

  const loaded = await loadDeployEnvAndProject(db, params.environmentId)
  if (loaded instanceof Response) return loaded
  const { envRow, projectRow } = loaded

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

  const composeServiceNames = listComposeServiceKeys(merged)
  if (composeServiceNames.length === 0) return emptyComposePrepareResult(mode)

  await reconcileServicesFromCompose(db, params.environmentId, merged)

  const serviceRows = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
      options: service.options,
    })
    .from(service)
    .where(eq(service.environmentId, params.environmentId))

  const pipeline = await allocateExpandDeployPipeline(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    organizationId: params.organizationId,
    projectOptions: projectRow.options,
    merged,
    composeServiceNames,
    serviceRows,
  })

  const limitErr = absorbSoftPrepareError(
    mode,
    warnings,
    resourceLimitPrepareError(
      pipeline.optionsByComposeName,
      pipeline.expandedServiceNames.length,
      orgRow?.options,
      serverRow?.options,
    ),
  )
  if (limitErr) return limitErr

  const healthErr = absorbSoftPrepareError(
    mode,
    warnings,
    evaluateHealthCheckGates(
      pipeline.expandedDocument,
      pipeline.optionsByComposeName,
      mode === 'preview' ? false : params.acknowledgeHealthCheckWarnings,
    ),
  )
  if (healthErr) return healthErr

  const serviceRowByCloneName = buildServiceRowByCloneName(
    serviceRows,
    pipeline.expansion,
  )
  const { globalEntries, perServiceEntries: userPerService } =
    await resolveDeployVariableBuckets(db, {
      environmentId: params.environmentId,
      serverId: params.serverId,
      composeServiceNames: pipeline.expandedServiceNames,
      serviceRowByComposeName: serviceRowByCloneName,
      dataEncryptionSecrets: c.get('dataEncryptionSecrets'),
    })

  const allocationByClone = new Map(
    pipeline.containers.map((row) => [row.cloneComposeServiceName, row]),
  )
  const perServiceEntries = appendPlatformVariablesToEntries(userPerService, {
    projectId: envRow.projectId,
    environmentId: params.environmentId,
    serviceRowByCloneName,
    allocationByClone,
  })

  const withVariables = applyVariablesToComposeDocument(pipeline.expandedDocument, {
    globalEntries,
    perServiceEntries,
  })
  const withServiceOptions = applyServiceOptionsToComposeDocument(
    documentForServiceOptions(mode, withVariables),
    pipeline.optionsByComposeName,
  )

  const storageMaterialRaw = await loadStorageMaterial(db, {
    environmentId: params.environmentId,
    projectId: envRow.projectId,
    organizationId: params.organizationId,
    serverId: params.serverId,
    serviceIds: serviceRows.map((row) => row.id),
    cloneNamesByServiceId: buildCloneNamesByServiceId(serviceRows, pipeline.expansion),
    registeredVolumes: pipeline.registeredVolumes,
  })
  const sealed = await maybeSealDeployMaterials(
    mode,
    c,
    db,
    params.serverId,
    withVariables.secretMaterial,
    storageMaterialRaw,
  )
  if (sealed instanceof Response) return sealed
  const { variableMaterial, storageMaterial } = sealed

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

  const traditionalResolved = resolveTraditionalWebSitesForMode(
    mode,
    warnings,
    await attachPrincipalsToTraditionalWebSites(
      db,
      params.environmentId,
      serviceRows,
      principalMaterial,
      split.sites,
    ),
    split.sites,
  )
  if ('kind' in traditionalResolved) return traditionalResolved

  const dockerExternalNetworks = collectComposeExternalDockerNetworkNames(
    split.composeYaml,
  )
  const networkErr = absorbSoftPrepareError(
    mode,
    warnings,
    await externalNetworkPrepareError(
      db,
      params.organizationId,
      params.serverId,
      dockerExternalNetworks,
    ),
  )
  if (networkErr) return networkErr

  return toPreparedDeployResult(mode, {
    composeYaml: split.composeYaml,
    hooks,
    variableMaterial,
    storageMaterial,
    principalMaterial,
    traditionalWebSites: traditionalResolved,
    dockerExternalNetworks,
    containers: pipeline.containers,
    ingressServices: pipeline.ingressServices,
    expansion: pipeline.expansion,
    registeredVolumes: pipeline.registeredVolumes,
    warnings,
  })
}

/**
 * Pin each traditional-web site to at most one assigned project principal.
 * Multiple principals on the same service is ambiguous ownership → prepare error.
 */
export async function attachPrincipalsToTraditionalWebSites(
  db: Db,
  environmentId: string,
  serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>,
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
    serviceIdByComposeName.set(row.composeServiceName, row.id)
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
