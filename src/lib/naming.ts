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
 * Managed engines always carry the ordinal so read-replica fan-out is
 * `-2`, `-3`, … with no rename of the primary (`ordinal` defaults to 1).
 */
export function managedContainerName(serviceId: string, ordinal = 1): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new TypeError(`Invalid managed container ordinal: ${ordinal}`)
  }
  const name = `${serviceId}-${ordinal}`
  if (!isValidDockerResourceName(name)) {
    throw new TypeError(
      `Invalid managed container name for service id: ${serviceId}`,
    )
  }
  return name
}

/**
 * Docker network name for a `network.kind = 'managed'` row is the row's own
 * bare UUID — no prefix. Distinct from `composeNetworkHostName`, which
 * prefixes `kind = 'compose'` spanning networks with `tpn_`.
 */
export function managedNetworkName(networkId: string): string {
  if (!isValidDockerResourceName(networkId)) {
    throw new TypeError(`Invalid managed network id: ${networkId}`)
  }
  return networkId
}

/** Suffix for Traefik ingress container names (`<serviceId>-in`). */
export const INGRESS_CONTAINER_NAME_SUFFIX = '-in'

/**
 * Docker `container_name` for an ingress-role row (`role='ingress'`, always
 * `ordinal = 1`): the per-service/hosting Traefik frontend **or** the shared
 * per-server ProxySQL managed-ingress frontend. Both use `<serviceId>-in`.
 * Managed engines no longer allocate a Traefik ingress row.
 */
export function ingressContainerNameFromService(serviceId: string): string {
  const name = `${serviceId}${INGRESS_CONTAINER_NAME_SUFFIX}`
  if (!isValidDockerResourceName(name)) {
    throw new TypeError(
      `Invalid ingress container name for service id: ${serviceId}`,
    )
  }
  return name
}

/** Suffix for managed-ha (Orchestrator) container names (`<serviceId>-ha`). */
export const MANAGED_HA_CONTAINER_NAME_SUFFIX = '-ha'

/**
 * Docker `container_name` for the shared per-server Orchestrator managed-ha
 * row (`role='turbopanel'`, always ordinal 1). Distinct from `-in` Traefik /
 * ProxySQL ingress rows.
 */
export function managedHaContainerNameFromService(
  serviceId: string,
): string {
  const name = `${serviceId}${MANAGED_HA_CONTAINER_NAME_SUFFIX}`
  if (!isValidDockerResourceName(name)) {
    throw new TypeError(
      `Invalid managed HA container name for service id: ${serviceId}`,
    )
  }
  return name
}

/** Docker volume name for a `storage.kind = volume` row is the storage UUID. */
export function dockerVolumeNameFromStorageId(storageId: string): string {
  if (!isValidDockerResourceName(storageId)) {
    throw new TypeError(`Invalid Docker volume storage id: ${storageId}`)
  }
  return storageId
}

/**
 * Resolve the on-host Docker volume name for a `storage.kind = volume` row.
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
      throw new TypeError(
        `Invalid pinned Docker volume name: ${input.pinnedName}`,
      )
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
/**
 * Inclusive low end of the reserved TurboPanel service-account UID band.
 *
 * Note the band check in `isValidPrincipalIdOverride` is belt-and-braces only:
 * the whole band sits below {@link PRINCIPAL_UID_START}, so the floor check
 * rejects these values first. Keep the band accurate anyway — it documents
 * which ids are spoken for, and the floor is the thing that could move.
 */
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
 *
 * The `tp*` entries here are documentation of the accounts that exist today —
 * the actual guard is the `tp` **prefix** rule in
 * {@link isReservedPrincipalUsername}. Enumerating them could never keep up:
 * this list already missed `tpnodeapp`, and every runtime-entitlement group
 * (`tpphp84`, `tpnode24`, …) would have to be added by hand.
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
  // Every TurboPanel-owned account and group is `tp`-prefixed, so reserving the
  // whole prefix closes the collision class permanently rather than one name at
  // a time. Costs tenants a two-letter prefix they have no reason to want.
  if (key.startsWith('tp')) return true
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
    throw new TypeError(
      `Invalid principal username for home path: ${username}`,
    )
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

export function principalVolumePath(
  username: string,
  storageId: string,
): string {
  if (
    typeof storageId !== 'string' ||
    storageId.length === 0 ||
    storageId.includes('/') ||
    storageId.includes('\\') ||
    storageId.includes('\0') ||
    storageId === '.' ||
    storageId === '..'
  ) {
    throw new TypeError(
      `Invalid storage id for principal volume path: ${storageId}`,
    )
  }
  return `${principalVolumesDir(username)}/${storageId}`
}

/**
 * Load-bearing DNS name shape for spanning-network `extra_hosts`.
 * Most-specific-first: per-replica `<service>-<ordinal>.<environmentId>` then
 * service-level `<service>.<environmentId>` (the latter points at the primary
 * task). These static hosts-file entries are superseded later by an embedded
 * resolver behind the same name shape.
 */
export function serviceDnsName(
  composeServiceName: string,
  replicaOrdinal: number | null,
  environmentId: string,
): string[] {
  const serviceLevel = `${composeServiceName}.${environmentId}`
  if (
    replicaOrdinal !== null &&
    Number.isInteger(replicaOrdinal) &&
    replicaOrdinal >= 1
  ) {
    return [
      `${composeServiceName}-${replicaOrdinal}.${environmentId}`,
      serviceLevel,
    ]
  }
  return [serviceLevel]
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

/** Default `binding.key_prefix` when the operator omits one. */
export const DEFAULT_BINDING_KEY_PREFIX = 'DATABASE'

/** Binding key-prefix shape (mirrored by DB CHECK `binding_key_prefix_format_check`). */
export const BINDING_KEY_PREFIX_RE = /^[A-Za-z_]\w*$/

export const MAX_BINDING_KEY_PREFIX_LENGTH = 64

export type BindingPrefixedKeys = {
  url: string
  caCert: string
  readSplit: string
  host: string
  port: string
  database: string
  user: string
  password: string
}

/**
 * Prefixed env keys a binding materializes for a service. Per-service compute —
 * not folded into {@link RESERVED_DEPLOY_VARIABLE_KEYS}.
 */
export function bindingPrefixedKeys(prefix: string): BindingPrefixedKeys {
  return {
    url: `${prefix}_URL`,
    caCert: `${prefix}_CA_CERT`,
    readSplit: `${prefix}_READ_SPLIT`,
    host: `${prefix}_HOST`,
    port: `${prefix}_PORT`,
    database: `${prefix}_NAME`,
    user: `${prefix}_USER`,
    password: `${prefix}_PASSWORD`,
  }
}

/**
 * Validate a binding key prefix. Rejects malformed prefixes and any prefix
 * whose emitted keys would land in {@link RESERVED_DEPLOY_VARIABLE_KEYS}
 * (i.e. reject `TURBOPANEL`).
 */
export function assertSafeBindingKeyPrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (
    trimmed.length < 1 ||
    trimmed.length > MAX_BINDING_KEY_PREFIX_LENGTH ||
    !BINDING_KEY_PREFIX_RE.test(trimmed)
  ) {
    throw new TypeError('invalid binding key prefix')
  }
  const keys = bindingPrefixedKeys(trimmed)
  for (const key of Object.values(keys)) {
    if (isReservedDeployVariableKey(key)) {
      throw new TypeError(
        'binding key prefix collides with reserved deploy keys',
      )
    }
  }
  // Catch the short prefix that would mint reserved keys when extended with
  // suffixes we control (e.g. `TURBOPANEL` → `TURBOPANEL_SERVICE_ID`).
  if (trimmed === 'TURBOPANEL' || trimmed.startsWith('TURBOPANEL_')) {
    throw new TypeError(
      'binding key prefix collides with reserved deploy keys',
    )
  }
  return trimmed
}
