import { attachWebMetadataToTraditionalSites } from '../../lib/hosting-web-env.ts'
import { assignTraditionalWebListenPorts } from '../../lib/compose/traditional-web.ts'
import type { EnvironmentDeployHosting } from '../../lib/commands/schemas.ts'
import type { EnvironmentDeployStorageMaterial } from '../../lib/commands/schemas.ts'
import type { EnvironmentDeployTraditionalWebSite } from '../../lib/commands/schemas.ts'
import type { EnvironmentLifecycleAction } from '../../lib/commands/schemas.ts'
import {
  validateDeployHostings,
  validateDeployStorageMaterialList,
} from '../../lib/commands/deploy-validation.ts'
import type { DeployPrepareError } from './deploy-prepare.ts'

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

export function mapPrepareErrorResponse(prepared: DeployPrepareError): PrepareErrorResponse {
  if (prepared.kind === 'health_check') {
    return {
      status: 409,
      body: {
        error: 'health_check_missing',
        required: prepared.required,
        services: prepared.services,
      },
    }
  }
  if (prepared.kind === 'empty_compose') {
    return { status: 400, body: { error: 'compose_empty' } }
  }
  if (prepared.kind === 'datacenter_ip_required') {
    return {
      status: 422,
      body: {
        error: 'datacenter_ip_required',
        serverId: prepared.serverId,
      },
    }
  }
  if (prepared.kind === 'docker_external_network_unregistered') {
    return {
      status: 422,
      body: {
        error: 'docker_external_network_unregistered',
        names: prepared.names,
        message:
          'Compose references external Docker network(s) that are not registered for this server. Add a Docker network under Servers → Networks with matching options.dockerNetworkName.',
      },
    }
  }
  if (prepared.kind === 'traditional_web_principal_ambiguous') {
    return {
      status: 422,
      body: {
        error: 'traditional_web_principal_ambiguous',
        composeServiceName: prepared.composeServiceName,
        message:
          `Traditional-web service "${prepared.composeServiceName}" has more than one project principal assigned. Keep a single principal for site ownership.`,
      },
    }
  }
  return {
    status: 409,
    body: {
      error: 'resource_limit_exceeded',
      violations: prepared.violations,
    },
  }
}

export function parseDeployRequestFlags(
  body: unknown,
): { acknowledgeHealthCheckWarnings: boolean; noCache: boolean } | 'invalid' {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'invalid'
  }
  const record = body as Record<string, unknown>
  return {
    acknowledgeHealthCheckWarnings: record.acknowledgeHealthCheckWarnings === true,
    noCache: record.noCache === true,
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

export function buildTraditionalWebSitesForDeploy(
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[],
  hostings: EnvironmentDeployHosting[],
): EnvironmentDeployTraditionalWebSite[] {
  return attachWebMetadataToTraditionalSites(
    assignTraditionalWebListenPorts(
      traditionalWebSites,
      preferredListenPortsFromHostings(hostings),
    ),
    hostings,
  )
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
