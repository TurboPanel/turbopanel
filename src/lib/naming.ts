/**
 * Single pure source of truth for generated resource names and principal paths.
 * Runtime-neutral — no Deno/Node/Workers APIs and no DB access.
 */

/**
 * Docker Engine resource-name allowlist (container / volume / network names).
 * Docker's engine rule additionally wants ≥2 chars, which UUIDs always satisfy.
 */
export const DOCKER_RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/

export function isValidDockerResourceName(value: string): boolean {
  return DOCKER_RESOURCE_NAME_RE.test(value)
}

/**
 * Compose `container_name` from a **service** identity. Single-instance
 * services use the bare service id; multi-instance appends `-<ordinal>`.
 *
 * Identity is the `service` row (not the `container` row) so names stay
 * stable across container-row reallocation and match
 * `uniq_container_service_ordinal`.
 */
export function containerNameFromService(input: {
  serviceId: string
  ordinal: number
  instanceCount: number
}): string {
  if (input.instanceCount === 1) return input.serviceId
  return `${input.serviceId}-${input.ordinal}`
}

/**
 * Managed engines always carry the ordinal so a future read-replica fan-out
 * is `-2`, `-3`, … with no rename of the primary.
 */
export function managedContainerName(serviceId: string): string {
  return `${serviceId}-1`
}

/** Suffix for Traefik ingress container names (`<serviceId>-ingress`). */
export const INGRESS_CONTAINER_NAME_SUFFIX = '-ingress'

/**
 * Docker `container_name` for a service's dedicated Traefik ingress row
 * (`role='ingress'`, always `ordinal = 1`).
 */
export function ingressContainerNameFromService(serviceId: string): string {
  const name = `${serviceId}${INGRESS_CONTAINER_NAME_SUFFIX}`
  if (!isValidDockerResourceName(name)) {
    throw new TypeError(`Invalid ingress container name for service id: ${serviceId}`)
  }
  return name
}

/**
 * Compose service key for a managed service's dedicated Traefik ingress.
 * Must satisfy `service_display_name_format_check` (`[A-Za-z0-9 ._-]+`, ≤255).
 */
export function managedIngressComposeServiceName(
  engineComposeServiceName: string,
): string {
  const name = `${engineComposeServiceName}-ingress`
  if (name.length === 0 || name.length > 255) {
    throw new TypeError(
      `Invalid managed ingress compose service name length: ${name.length}`,
    )
  }
  if (!/^[A-Za-z0-9 ._-]+$/.test(name)) {
    throw new TypeError(
      `Invalid managed ingress compose service name: ${engineComposeServiceName}`,
    )
  }
  return name
}

/** Docker volume name for a `docker_volume` storage row is the row UUID. */
export function dockerVolumeNameFromStorageId(storageId: string): string {
  if (!isValidDockerResourceName(storageId)) {
    throw new TypeError(`Invalid Docker volume storage id: ${storageId}`)
  }
  return storageId
}

/**
 * Legacy daemon-era Docker volume name (`tp-<org8>-<name>`).
 *
 * **Back-compat only** — mirrors the daemon's `namespaceDockerVolumeName`.
 * Never used for new `storage` rows; those stamp `metadata.dockerVolumeName`
 * to the storage UUID via {@link resolveDockerVolumeName}.
 */
export function legacyNamespacedDockerVolumeName(
  organizationId: string,
  name: string,
): string {
  return `tp-${organizationId.slice(0, 8)}-${name}`
}

/**
 * Resolve the on-host Docker volume name for a `docker_volume` storage row.
 *
 * Prefers `pinnedName` (typically `metadata.dockerVolumeName` — the storage
 * UUID for new rows). Unstamped legacy rows fall back to
 * {@link legacyNamespacedDockerVolumeName}.
 */
export function resolveDockerVolumeName(input: {
  storageId: string
  organizationId: string
  name: string
  pinnedName?: string | null
}): string {
  if (typeof input.pinnedName === 'string' && input.pinnedName.length > 0) {
    if (!isValidDockerResourceName(input.pinnedName)) {
      throw new TypeError(`Invalid pinned Docker volume name: ${input.pinnedName}`)
    }
    return input.pinnedName
  }
  return legacyNamespacedDockerVolumeName(input.organizationId, input.name)
}

/**
 * Principal home root on managed hosts. 10001 clears the `tp*` service
 * accounts at 9989–9999 and normal `useradd` ranges.
 */
export const PRINCIPAL_HOME_ROOT = '/srv/users'
export const PRINCIPAL_UID_START = 10001

function assertSafePrincipalId(principalId: string): string {
  if (
    typeof principalId !== 'string' ||
    principalId.length === 0 ||
    principalId.includes('/') ||
    principalId.includes('\\') ||
    principalId.includes('\0') ||
    principalId === '.' ||
    principalId === '..'
  ) {
    throw new TypeError(`Invalid principal id for home path: ${principalId}`)
  }
  return principalId
}

export function principalHomeDir(principalId: string): string {
  return `${PRINCIPAL_HOME_ROOT}/${assertSafePrincipalId(principalId)}`
}

export function principalSshDir(principalId: string): string {
  return `${principalHomeDir(principalId)}/.ssh`
}

export function principalVolumesDir(principalId: string): string {
  return `${principalHomeDir(principalId)}/volumes`
}

export function principalVolumePath(principalId: string, storageId: string): string {
  if (
    typeof storageId !== 'string' ||
    storageId.length === 0 ||
    storageId.includes('/') ||
    storageId.includes('\\') ||
    storageId.includes('\0') ||
    storageId === '.' ||
    storageId === '..'
  ) {
    throw new TypeError(`Invalid storage id for principal volume path: ${storageId}`)
  }
  return `${principalVolumesDir(principalId)}/${storageId}`
}

/**
 * DNS name shape only — most-specific-first so the container label precedes
 * the project label. No resolver, zone, or hosts-file writer exists yet, and
 * nothing may depend on this resolving.
 */
export function serviceDnsName(projectId: string, containerId: string): string {
  return `${containerId}.${projectId}`
}

/** Reserved for the tenant-deploy phase; user variables must never shadow them. */
export const RESERVED_DEPLOY_VARIABLE_KEYS: ReadonlySet<string> = new Set([
  'TURBOPANEL_PROJECT_ID',
  'TURBOPANEL_ENVIRONMENT_ID',
  'TURBOPANEL_SERVICE_ID',
  'TURBOPANEL_CONTAINER_ID',
  'TURBOPANEL_CONTAINER_NAME',
  'TURBOPANEL_SERVICE_HOST',
])

export function isReservedDeployVariableKey(key: string): boolean {
  return RESERVED_DEPLOY_VARIABLE_KEYS.has(key)
}
