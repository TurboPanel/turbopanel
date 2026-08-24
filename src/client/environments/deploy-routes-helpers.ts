import { attachWebMetadataToSites } from '../../lib/hosting-web-env.ts'
import { assignSiteListenPorts } from '../../lib/compose/site.ts'
import { assignNativeAppListenPorts } from '../../lib/compose/native-app.ts'
import type {
  EnvironmentDeployComposeFile,
  EnvironmentDeployHosting,
  EnvironmentDeployIngressService,
  EnvironmentDeployNativeAppService,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeploySite,
  EnvironmentLifecycleAction,
} from '../../lib/commands/schemas.ts'
import type { DeployPrepareError, PreparedNativeAppService } from './deploy-prepare.ts'
import {
  validateDeployHostings,
  validateDeployStorageMaterialList,
} from '../../lib/commands/deploy-validation.ts'
import type { FabricGateOutcome } from '../../lib/fabric/gate.ts'
import type { ScheduleErrorCode } from '../../lib/schedule/index.ts'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readHostnames(options: unknown): string[] {
  if (!isPlainObject(options)) return []
  const hostnames = options.hostnames
  if (!Array.isArray(hostnames)) return []
  return hostnames.filter((h): h is string => typeof h === 'string' && h.length > 0)
}

export function readPathPrefix(options: unknown): string | undefined {
  if (!isPlainObject(options)) return undefined
  return typeof options.pathPrefix === 'string' ? options.pathPrefix : undefined
}

export function readTargetPort(options: unknown): number | undefined {
  if (!isPlainObject(options)) return undefined
  return typeof options.targetPort === 'number' && Number.isFinite(options.targetPort)
    ? options.targetPort
    : undefined
}

export function readHostingProtocol(options: unknown): 'http' | 'tcp' | 'udp' {
  if (!isPlainObject(options)) return 'http'
  return options.protocol === 'tcp' || options.protocol === 'udp' ? options.protocol : 'http'
}

function isValidHostingPortValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

export function readHostingPorts(options: unknown): { published: number; target: number }[] {
  if (!isPlainObject(options) || !Array.isArray(options.ports)) return []
  const ports: { published: number; target: number }[] = []
  for (const entry of options.ports) {
    if (
      isPlainObject(entry) &&
      isValidHostingPortValue(entry.published) &&
      isValidHostingPortValue(entry.target)
    ) {
      ports.push({ published: entry.published, target: entry.target })
    }
  }
  return ports
}

/**
 * Docker Compose `-p` project name for an environment deploy.
 *
 * Uses the TurboPanel **project** UUID — never the operator display name.
 * Container names are separately obfuscated via service-UUID allocation
 * (`containerNaming: uuid`).
 */
export function composeProjectName(projectId: string): string {
  return projectId
}

export function tlsPinErrorCode(
  error: 'pin_not_found' | 'pin_mismatch' | 'pin_not_ready',
): string {
  switch (error) {
    case 'pin_mismatch':
      return 'tls_pin_mismatch'
    case 'pin_not_ready':
      return 'tls_pin_not_ready'
    case 'pin_not_found':
      return 'tls_pin_not_found'
  }
}

export type PrepareErrorResponse = {
  status: number
  body: Record<string, unknown>
}

export function fabricGateErrorResponse(
  outcome: Exclude<FabricGateOutcome, { kind: 'ready' }>,
): PrepareErrorResponse {
  if (outcome.kind === 'failed') {
    return {
      status: 422,
      body: {
        error: 'fabric_reconcile_failed',
        serverId: outcome.serverId,
        commandId: outcome.commandId,
        ...(outcome.error ? { message: outcome.error } : {}),
      },
    }
  }
  return {
    status: 409,
    body: {
      error: 'fabric_reconcile_pending',
      pending: outcome.pending,
    },
  }
}

export function scheduleErrorResponse(
  error: ScheduleErrorCode,
  message: string,
): PrepareErrorResponse {
  if (error === 'no_eligible_server') {
    return { status: 409, body: { error: 'server_placement_required' } }
  }
  return { status: 422, body: { error, message } }
}

export type QueuedCommandRef = {
  commandId: string
  serverId: string
  status: 'queued'
}

export function queuedCommandsResponseBody(
  commands: readonly QueuedCommandRef[],
): Record<string, unknown> {
  const first = commands[0]
  return {
    ok: true as const,
    commandId: first?.commandId ?? '',
    status: 'queued' as const,
    ...(first ? { serverId: first.serverId } : {}),
    commands: commands.map((row) => ({
      commandId: row.commandId,
      serverId: row.serverId,
      status: row.status,
    })),
  }
}

export function deployMaterialsErrorResponse(
  hostings: EnvironmentDeployHosting[],
  storageMaterial: EnvironmentDeployStorageMaterial[],
): Response | null {
  const validationError = validateDeployMaterials(hostings, storageMaterial)
  if (!validationError) return null
  return Response.json(
    { error: validationError.error, message: validationError.message },
    { status: 400 },
  )
}

type VariablePrepareError = Extract<
  DeployPrepareError,
  {
    kind:
      | 'variable_unresolved'
      | 'variable_ref_invalid'
      | 'variable_secret_interpolation'
  }
>

type StorageLocationUnavailableError = Extract<
  DeployPrepareError,
  { kind: 'storage_location_unavailable' }
>

function variablePrepareErrorResponse(prepared: VariablePrepareError): PrepareErrorResponse {
  const body: Record<string, unknown> = {
    error: prepared.kind,
    message: prepared.message,
  }
  if (prepared.composeServiceName) {
    body.composeServiceName = prepared.composeServiceName
  }
  if ('ref' in prepared && prepared.ref) {
    body.ref = prepared.ref
  }
  if (prepared.envKey) {
    body.envKey = prepared.envKey
  }
  return { status: 422, body }
}

function storageLocationUnavailableMessage(prepared: StorageLocationUnavailableError): string {
  const prefix =
    `Storage "${prepared.storageName}" (${prepared.accessMode}) has no usable location on this server`
  if (!prepared.primaryServerId) {
    return prefix
  }
  return `${prefix}; primary copy is on ${prepared.primaryServerId}`
}

function storageLocationUnavailableResponse(
  prepared: StorageLocationUnavailableError,
): PrepareErrorResponse {
  return {
    status: 422,
    body: {
      error: 'storage_location_unavailable',
      storageId: prepared.storageId,
      storageName: prepared.storageName,
      accessMode: prepared.accessMode,
      primaryServerId: prepared.primaryServerId,
      scheduledServerId: prepared.scheduledServerId,
      serviceId: prepared.serviceId,
      message: storageLocationUnavailableMessage(prepared),
    },
  }
}

export function mapPrepareErrorResponse(prepared: DeployPrepareError): PrepareErrorResponse {
  switch (prepared.kind) {
    case 'health_check':
      return {
        status: 409,
        body: {
          error: 'health_check_missing',
          required: prepared.required,
          services: prepared.services,
        },
      }
    case 'empty_compose':
      return { status: 400, body: { error: 'compose_empty' } }
    case 'datacenter_ip_required':
      return {
        status: 422,
        body: {
          error: 'datacenter_ip_required',
          serverId: prepared.serverId,
        },
      }
    case 'docker_external_network_unregistered':
      return {
        status: 422,
        body: {
          error: 'docker_external_network_unregistered',
          names: prepared.names,
          message:
            'Compose references external Docker network(s) that are not registered for this server. Add a Docker network under Servers → Networks with matching options.dockerNetworkName.',
        },
      }
    case 'site_principal_ambiguous':
      return {
        status: 422,
        body: {
          error: 'site_principal_ambiguous',
          composeServiceName: prepared.composeServiceName,
          message:
            `Site "${prepared.composeServiceName}" has more than one project principal assigned. Keep a single principal for site ownership.`,
        },
      }
    case 'source_principal_ambiguous':
      return {
        status: 422,
        body: {
          error: 'source_principal_ambiguous',
          composeServiceName: prepared.composeServiceName,
          message:
            `Git-backed service "${prepared.composeServiceName}" has more than one project principal assigned. Keep a single principal for release ownership.`,
        },
      }
    case 'source_ref_unresolved':
      return {
        status: 422,
        body: {
          error: 'source_ref_unresolved',
          composeServiceName: prepared.composeServiceName,
          sourceId: prepared.sourceId,
          ref: prepared.ref,
          message:
            `Could not resolve a commit for "${prepared.composeServiceName}" (ref "${prepared.ref}"): ${prepared.message}`,
        },
      }
    case 'binding_endpoint_unavailable':
      return {
        status: 422,
        body: {
          error: 'binding_endpoint_unavailable',
          message:
            'A service binding could not resolve a ProxySQL listener for its managed cluster.',
        },
      }
    case 'variable_unresolved':
    case 'variable_ref_invalid':
    case 'variable_secret_interpolation':
      return variablePrepareErrorResponse(prepared)
    case 'storage_location_unavailable':
      return storageLocationUnavailableResponse(prepared)
    case 'resource_limit':
      return {
        status: 409,
        body: {
          error: 'resource_limit_exceeded',
          violations: prepared.violations,
        },
      }
  }
}

/** Longest accepted `ref`; matches `SOURCE_BRANCH_MAX_LENGTH` on the source row. */
export const DEPLOY_REF_MAX_LENGTH = 255

/**
 * A branch, tag, or commit SHA to deploy.
 *
 * An **allowlist**, not a denylist of the characters git forbids (`~ ^ : ? * [
 * \\`, whitespace, control codes). The value ends up in a checkout, so the safe
 * direction is to accept only what real ref names actually use and reject
 * everything else — a denylist has to be complete to be correct, and this one
 * does not have to be.
 */
const DEPLOY_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/

/**
 * Rejection sentinel for {@link parseDeployRef}.
 *
 * A symbol rather than the string `'invalid'`: `invalid` is itself a legal ref (it
 * matches {@link DEPLOY_REF_RE}), so a string sentinel cannot be told apart
 * from a branch or tag actually named that.
 */
export const DEPLOY_REF_INVALID: unique symbol = Symbol('deploy_ref_invalid')

/**
 * Parse the optional `ref`. Returns `null` when absent (deploy whatever each
 * source's own branch resolves to), the trimmed value when valid, or
 * {@link DEPLOY_REF_INVALID}.
 */
export function parseDeployRef(
  value: unknown,
): string | null | typeof DEPLOY_REF_INVALID {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return DEPLOY_REF_INVALID
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > DEPLOY_REF_MAX_LENGTH) return DEPLOY_REF_INVALID
  if (trimmed.startsWith('-') || trimmed.includes('..')) return DEPLOY_REF_INVALID
  if (!DEPLOY_REF_RE.test(trimmed)) return DEPLOY_REF_INVALID
  return trimmed
}

export function parseDeployRequestFlags(
  body: unknown,
):
  | {
    acknowledgeHealthCheckWarnings: boolean
    noCache: boolean
    ref: string | null
  }
  | 'invalid' {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'invalid'
  }
  const record = body as Record<string, unknown>
  const ref = parseDeployRef(record.ref)
  if (ref === DEPLOY_REF_INVALID) return 'invalid'
  return {
    acknowledgeHealthCheckWarnings: record.acknowledgeHealthCheckWarnings === true,
    noCache: record.noCache === true,
    ref,
  }
}

export function parseLifecycleAction(
  body: unknown,
): EnvironmentLifecycleAction | 'invalid' {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'invalid'
  }
  const action = (body as Record<string, unknown>).action
  if (action === 'start' || action === 'stop' || action === 'restart') {
    return action
  }
  return 'invalid'
}

/**
 * Expand each hosting onto multi-instance clone compose keys.
 * Keeps the same `hostingId` / `serviceId` so Traefik merges labels.
 */
export function expandHostingsForComposeInstances(
  hostings: readonly EnvironmentDeployHosting[],
  expansion: Readonly<Record<string, string[]>>,
): EnvironmentDeployHosting[] {
  const out: EnvironmentDeployHosting[] = []
  for (const entry of hostings) {
    const clones = expansion[entry.composeServiceName]
    if (!clones || clones.length === 0) {
      out.push(entry)
      continue
    }
    for (const cloneName of clones) {
      out.push({
        ...entry,
        composeServiceName: cloneName,
      })
    }
  }
  return out
}

export function preferredListenPortsFromHostings(
  hostings: readonly EnvironmentDeployHosting[],
): Map<string, number> {
  const preferredListenPorts = new Map<string, number>()
  for (const entry of hostings) {
    if (typeof entry.targetPort === 'number') {
      preferredListenPorts.set(entry.composeServiceName, entry.targetPort)
    }
  }
  return preferredListenPorts
}

export function buildSitesForDeploy(
  sites: EnvironmentDeploySite[],
  hostings: EnvironmentDeployHosting[],
  used: Set<number> = new Set<number>(),
): EnvironmentDeploySite[] {
  return attachWebMetadataToSites(
    assignSiteListenPorts(
      sites,
      preferredListenPortsFromHostings(hostings),
      used,
    ),
    hostings,
  )
}

/**
 * Release-tree directory segment for one compose service.
 *
 * **Must** stay identical to the daemon's `resolveReleaseServiceId`
 * (`turbopaneld/src/deploy/release/apply-source-releases.ts`): hostings first,
 * then tcp/udp ingress, then the compose key. The release engine picks the
 * directory with that rule, so a native app unit whose `WorkingDirectory` were
 * derived any other way would point at a tree nothing ever published.
 */
export function resolveDeployReleaseServiceId(
  composeServiceName: string,
  hostings: readonly EnvironmentDeployHosting[],
  ingressServices: readonly EnvironmentDeployIngressService[],
): string {
  for (const hosting of hostings) {
    if (
      hosting.composeServiceName === composeServiceName && hosting.serviceId
    ) {
      return hosting.serviceId
    }
  }
  for (const ingress of ingressServices) {
    if (
      ingress.composeServiceName === composeServiceName && ingress.serviceId
    ) {
      return ingress.serviceId
    }
  }
  return composeServiceName
}

/**
 * Finalize native app rows for the wire: re-assign loopback ports now that
 * hosting `targetPort` values are known, and resolve each release-tree
 * `serviceId`.
 *
 * `used` is the **same** ledger `buildSitesForDeploy` was handed,
 * so the two loopback lanes cannot be given the same port.
 */
export function buildNativeAppServicesForDeploy(
  nativeAppServices: readonly PreparedNativeAppService[],
  hostings: EnvironmentDeployHosting[],
  ingressServices: readonly EnvironmentDeployIngressService[],
  used: Set<number> = new Set<number>(),
): EnvironmentDeployNativeAppService[] {
  if (nativeAppServices.length === 0) return []
  return assignNativeAppListenPorts(
    nativeAppServices,
    preferredListenPortsFromHostings(hostings),
    used,
  ).map((app) => ({
    ...app,
    serviceId: resolveDeployReleaseServiceId(
      app.composeServiceName,
      hostings,
      ingressServices,
    ),
  }))
}

export type DeployMaterialValidationError = {
  error: 'invalid_deploy_hosting' | 'invalid_deploy_storage'
  message: string
}

export function validateDeployMaterials(
  hostings: EnvironmentDeployHosting[],
  storageMaterial: EnvironmentDeployStorageMaterial[],
): DeployMaterialValidationError | null {
  const hostingValidationError = validateDeployHostings(hostings)
  if (hostingValidationError) {
    return { error: 'invalid_deploy_hosting', message: hostingValidationError }
  }

  const storageValidationError = validateDeployStorageMaterialList(storageMaterial)
  if (storageValidationError) {
    return { error: 'invalid_deploy_storage', message: storageValidationError }
  }

  return null
}

/**
 * True when any hosting routes HTTP hostnames through the shared loopback
 * Traefik (`turbopanel-ingress`). Empty hostnames and `tcp`/`udp` hostings
 * do not need that proxy.
 */
export function hostingsNeedSharedHttpIngress(
  hostings: readonly EnvironmentDeployHosting[],
): boolean {
  for (const hosting of hostings) {
    if (hosting.protocol === 'tcp' || hosting.protocol === 'udp') continue
    if (hosting.hostnames.length > 0) return true
  }
  return false
}

export type DeployPreviewContainerRow = {
  serviceId: string
  composeServiceName: string
  containerName: string
  ordinal: number
  role: 'service' | 'ingress'
}

export function buildDeployPreviewContainers(input: {
  appContainers: Array<{
    serviceId: string
    cloneComposeServiceName: string
    containerName: string
    ordinal: number
  }>
  ingressServices: Array<{
    serviceId: string
    composeServiceName: string
    containerName: string
  }>
}): DeployPreviewContainerRow[] {
  const appContainers = input.appContainers.map((row) => ({
    serviceId: row.serviceId,
    composeServiceName: row.cloneComposeServiceName,
    containerName: row.containerName,
    ordinal: row.ordinal,
    role: 'service' as const,
  }))
  const ingressContainers = input.ingressServices.map((row) => ({
    serviceId: row.serviceId,
    composeServiceName: row.composeServiceName,
    containerName: row.containerName,
    ordinal: 1,
    role: 'ingress' as const,
  }))
  return [...appContainers, ...ingressContainers]
}

export type DeployPreviewServerRow = {
  serverId: string
  name: string
  composeFiles: EnvironmentDeployComposeFile[]
  services: string[]
}

/** Display name, then hostname, then the server id. */
export function deployPreviewServerLabel(
  name: string | null | undefined,
  hostname: string | null | undefined,
  serverId: string,
): string {
  const displayName = name?.trim()
  if (displayName) return displayName
  const host = hostname?.trim()
  if (host) return host
  return serverId
}

/**
 * Per-host compiled snapshots. Omitted for a whole-environment pin /
 * single-server plan so the UI does not duplicate the top-level compose.yaml.
 */
export function buildDeployPreviewServers(
  preparedByServer: ReadonlyArray<{
    serverId: string
    prepared: {
      composeFiles: EnvironmentDeployComposeFile[]
      replicaCounts: Record<string, number>
    }
  }>,
  labelById: ReadonlyMap<string, { name: string | null; hostname: string | null }>,
): DeployPreviewServerRow[] | undefined {
  if (preparedByServer.length <= 1) return undefined
  return preparedByServer.map((row) => {
    const label = labelById.get(row.serverId)
    return {
      serverId: row.serverId,
      name: deployPreviewServerLabel(label?.name, label?.hostname, row.serverId),
      composeFiles: row.prepared.composeFiles,
      services: Object.keys(row.prepared.replicaCounts).sort((a, b) =>
        a.localeCompare(b)
      ),
    }
  })
}
