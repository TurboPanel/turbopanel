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

/** Suffix for Traefik ingress container names (`<serviceId>-in`). */
export const INGRESS_CONTAINER_NAME_SUFFIX = '-in'

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
 * Must satisfy `service_name_format_check` (`[A-Za-z0-9._-]+`, ≤255).
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
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
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
 * Resolve the on-host Docker volume name for a `docker_volume` storage row.
 *
 * Uses `pinnedName` when present (typically `metadata.dockerVolumeName`);
 * otherwise the storage UUID.
 */
export function resolveDockerVolumeName(input: {
  storageId: string
  pinnedName?: string | null
}): string {
  if (typeof input.pinnedName === 'string' && input.pinnedName.length > 0) {
    if (!isValidDockerResourceName(input.pinnedName)) {
      throw new TypeError(`Invalid pinned Docker volume name: ${input.pinnedName}`)
    }
    return input.pinnedName
  }
  return dockerVolumeNameFromStorageId(input.storageId)
}

/**
 * Principal home root on managed hosts. The host allocates uid/gid; when an
 * operator supplies an explicit override it must be ≥ {@link PRINCIPAL_UID_START}
 * and outside the reserved `tp*` service band
 * [{@link PRINCIPAL_RESERVED_UID_MIN}, {@link PRINCIPAL_RESERVED_UID_MAX}].
 */
export const PRINCIPAL_HOME_ROOT = '/srv/users'
/** Floor for an optional operator uid/gid override (host allocates when omitted). */
export const PRINCIPAL_UID_START = 10001
/** Inclusive low end of the reserved TurboPanel service-account UID band. */
export const PRINCIPAL_RESERVED_UID_MIN = 9989
/** Inclusive high end of the reserved TurboPanel service-account UID band. */
export const PRINCIPAL_RESERVED_UID_MAX = 9999

/**
 * Max Linux username length so `<username>-grp` still fits the host group-name
 * limit (32). Keep in sync with daemon `MAX_PRINCIPAL_USERNAME_LENGTH` and
 * command-schema validators.
 */
export const MAX_PRINCIPAL_USERNAME_LENGTH = 28

/** Suffix appended by daemon `principalUnixGroupName` (`${username}-grp`). */
export const PRINCIPAL_UNIX_GROUP_SUFFIX = '-grp'

/** POSIX-shaped username used for home paths — mirrors the daemon allowlist. */
const PRINCIPAL_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * Reserved Linux / TurboPanel account names (lowercased). Rejected on create
 * so tenant principals cannot collide with host or service accounts.
 */
export const RESERVED_PRINCIPAL_USERNAMES: ReadonlySet<string> = new Set([
  'root',
  'daemon',
  'bin',
  'sys',
  'sync',
  'games',
  'man',
  'mail',
  'news',
  'www-data',
  'nobody',
  'sshd',
  'postgres',
  'redis',
  'docker',
  'tp',
  'tpctrl',
  'tpcache',
  'tpdata',
  'tpqueue',
  'tpmetrics',
  'tpcaddy',
  'tpnginx',
  'tpapache',
  'tpols',
  'tplsws',
])

export function isReservedPrincipalUsername(value: string): boolean {
  const key = value.trim().toLowerCase()
  if (RESERVED_PRINCIPAL_USERNAMES.has(key)) return true
  return key.startsWith('systemd-')
}

/**
 * Validate a principal username for home/SSH/volume path segments.
 * Rejects non-strings, empty, length > {@link MAX_PRINCIPAL_USERNAME_LENGTH},
 * or names outside the POSIX allowlist
 * (`^[A-Za-z_][A-Za-z0-9_-]*$` — also excludes `/`, `\`, NUL, `.`, `..`).
 * Length is capped so `<username>-grp` fits the Linux group-name limit.
 */
export function assertSafePrincipalUsername(username: string): string {
  if (
    typeof username !== 'string' ||
    username.length === 0 ||
    username.length > MAX_PRINCIPAL_USERNAME_LENGTH ||
    !PRINCIPAL_USERNAME_RE.test(username)
  ) {
    throw new TypeError(`Invalid principal username for home path: ${username}`)
  }
  return username
}

export function principalHomeDir(username: string): string {
  return `${PRINCIPAL_HOME_ROOT}/${assertSafePrincipalUsername(username)}`
}

export function principalSshDir(username: string): string {
  return `${principalHomeDir(username)}/.ssh`
}

export function principalVolumesDir(username: string): string {
  return `${principalHomeDir(username)}/volumes`
}

export function principalVolumePath(username: string, storageId: string): string {
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
  return `${principalVolumesDir(username)}/${storageId}`
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
