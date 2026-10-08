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
    throw new TypeError(`Invalid managed container name for service id: ${serviceId}`)
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
    throw new TypeError(`Invalid ingress container name for service id: ${serviceId}`)
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
export function managedHaContainerNameFromService(serviceId: string): string {
  const name = `${serviceId}${MANAGED_HA_CONTAINER_NAME_SUFFIX}`
  if (!isValidDockerResourceName(name)) {
    throw new TypeError(`Invalid managed HA container name for service id: ${serviceId}`)
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
      throw new TypeError(`Invalid pinned Docker volume name: ${input.pinnedName}`)
    }
    return input.pinnedName
  }
  return dockerVolumeNameFromStorageId(input.storageId)
}

/**
 * Principal home root on managed hosts. The host picks uid/gid from
 * {@link PRINCIPAL_UID_START} through {@link PRINCIPAL_UID_END}; when an
 * operator supplies an explicit override it must sit in that same band and
 * outside the reserved `tp*` service band
 * [{@link PRINCIPAL_RESERVED_UID_MIN}, {@link PRINCIPAL_RESERVED_UID_MAX}].
 */
export const PRINCIPAL_HOME_ROOT = '/srv/users'
/**
 * Floor for a principal uid/gid. The host picks from this value through
 * {@link PRINCIPAL_UID_END} when the operator omits an override; an explicit
 * override must be ≥ this constant. Keep in step with `PRINCIPAL_ID_MIN` in the
 * daemon's `src/deploy/ensure-principal.ts`.
 */
export const PRINCIPAL_UID_START = 15001
/**
 * Ceiling for a principal uid/gid (inclusive); an explicit override must be ≤
 * this constant. Above it, 61184–65519 is systemd's range for the throwaway
 * per-build users, which must never pass for a site owner's Linux user, so the
 * host refuses anything higher. Keep in step with `PRINCIPAL_ID_MAX` in the
 * daemon's `src/deploy/ensure-principal.ts`.
 */
export const PRINCIPAL_UID_END = 60000
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
 * Max Linux username length. The host gives the user the standard Debian
 * per-user group, named after it, so the group name is the same length. Keep
 * in sync with daemon `MAX_PRINCIPAL_USERNAME_LENGTH` and command-schema
 * validators. Applies to the **applied** username — the name that actually
 * lands on the host.
 */
export const MAX_PRINCIPAL_USERNAME_LENGTH = 28

/**
 * Random chars after the underscore in a randomized applied username
 * (`<short>_<11 chars>` — a 12-char suffix total, Plesk-style).
 */
export const PRINCIPAL_APPLIED_SUFFIX_RANDOM_LENGTH = 11
/** Total applied-suffix length including the underscore separator. */
export const PRINCIPAL_APPLIED_SUFFIX_LENGTH = PRINCIPAL_APPLIED_SUFFIX_RANDOM_LENGTH + 1
/**
 * Short-name cap for a server principal when the applied name is randomized:
 * `<short>_<11>` must still fit {@link MAX_PRINCIPAL_USERNAME_LENGTH}.
 */
export const MAX_SUFFIXED_PRINCIPAL_USERNAME_LENGTH =
  MAX_PRINCIPAL_USERNAME_LENGTH - PRINCIPAL_APPLIED_SUFFIX_LENGTH

const APPLIED_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Random `_<11 chars>` (lowercase alphanumeric, rejection-sampled) appended to
 * a short username to form the applied login.
 */
export function randomPrincipalUsernameSuffix(): string {
  const out: string[] = []
  const limit = 256 - (256 % APPLIED_SUFFIX_ALPHABET.length)
  while (out.length < PRINCIPAL_APPLIED_SUFFIX_RANDOM_LENGTH) {
    const bytes = new Uint8Array(PRINCIPAL_APPLIED_SUFFIX_RANDOM_LENGTH)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= limit) continue
      out.push(APPLIED_SUFFIX_ALPHABET[byte % APPLIED_SUFFIX_ALPHABET.length])
      if (out.length === PRINCIPAL_APPLIED_SUFFIX_RANDOM_LENGTH) break
    }
  }
  return `_${out.join('')}`
}

/** POSIX-shaped username used for home paths — mirrors the daemon allowlist. */
const PRINCIPAL_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * Reserved Linux / TurboPanel account names (lowercased). Rejected on create
 * so tenant principals cannot collide with host or service accounts.
 *
 * The host gives each site owner's Linux user the standard Debian per-user
 * group, named after the user. sudoers, PAM and polkit grant power by group
 * name whether or not the group exists (Ubuntu's sudoers still names
 * `%admin`; `wheel` is the pam_wheel and polkit group), so a user called
 * `admin` would be an administrator. Every common Debian / Ubuntu system and
 * privilege group name is therefore reserved too. Kept equal to
 * `TP_RESERVED_NAMES` in the daemon's tp-host, which refuses the same names
 * (and any group sudoers names) on the host.
 *
 * The `tp*` entries here are documentation of the accounts that exist today —
 * the actual guard is the `tp` **prefix** rule in
 * {@link isReservedPrincipalUsername}. Enumerating them could never keep up
 * with every `tp*` service account and group a host carries.
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
  // System accounts and groups Debian and Ubuntu ship or commonly add, and
  // the groups that grant administrator power by name.
  'lp',
  'uucp',
  'proxy',
  'backup',
  'list',
  'irc',
  'gnats',
  'nogroup',
  'ssh',
  '_ssh',
  '_apt',
  '_chrony',
  'mysql',
  'adm',
  'admin',
  'audio',
  'avahi',
  'cdrom',
  'crontab',
  'dialout',
  'dip',
  'disk',
  'floppy',
  'fuse',
  'incus',
  'incus-admin',
  'input',
  'kmem',
  'kvm',
  'libvirt',
  'libvirt-qemu',
  'lpadmin',
  'lxd',
  'messagebus',
  'microk8s',
  'netdev',
  'operator',
  'plugdev',
  'polkitd',
  'render',
  'sambashare',
  'sasl',
  'sgx',
  'shadow',
  'src',
  'ssl-cert',
  'staff',
  'sudo',
  'tape',
  'tty',
  'users',
  'utmp',
  'video',
  'voice',
  'wheel',
  'bluetooth',
  'gpio',
  'i2c',
  'nopass' + 'wdlogin',
  'rdma',
  'scanner',
  'syslog',
  'tss',
  'uuidd',
  'vboxusers',
  'wireshark',
  // Platform cgroup slices directly under `turbopanel.slice`: a site owner's
  // Linux user gets `turbopanel-<name>.slice`, so these names are taken.
  // `containers` holds the platform's own containers; `tpbuild` holds builds
  // nobody owns (also caught by the `tp` prefix rule).
  'containers',
  'tpbuild',
])

export function isReservedPrincipalUsername(value: string): boolean {
  const key = value.trim().toLowerCase()
  if (RESERVED_PRINCIPAL_USERNAMES.has(key)) return true
  // Every TurboPanel-owned account and group is `tp`-prefixed, so reserving the
  // whole prefix closes the collision class permanently rather than one name at
  // a time. Costs tenants a two-letter prefix they have no reason to want.
  if (key.startsWith('tp')) return true
  // `<name>-grp` is the group of a site owner from before the group took the
  // owner's own name: a new user called that would share it.
  if (key.endsWith('-grp')) return true
  return key.startsWith('systemd-')
}

/**
 * True when every `-` in the name sits between two other characters: no
 * trailing `-` and no `--`. The host writes each `-` of a site owner's Linux
 * user as `.` in its slice names and refuses to run builds for a name that ends
 * in `-` or holds `--`, so new names are held to that shape up front. (A
 * leading `-` is already refused by the username pattern.)
 */
export function hasPlainPrincipalDashes(username: string): boolean {
  return !username.endsWith('-') && !username.includes('--')
}

/**
 * Validate a principal username for home/SSH/volume path segments.
 * Rejects non-strings, empty, length > {@link MAX_PRINCIPAL_USERNAME_LENGTH},
 * or names outside the POSIX allowlist
 * (`^[A-Za-z_][A-Za-z0-9_-]*$` — also excludes `/`, `\`, NUL, `.`, `..`).
 * Length is capped at {@link MAX_PRINCIPAL_USERNAME_LENGTH}.
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
 * Load-bearing DNS name shape for spanning-network `extra_hosts`.
 * Most-specific-first: per-replica `<service>-<ordinal>.<environmentId>` then
 * service-level `<service>.<environmentId>` (the latter points at the primary
 * task). These static hosts-file entries are superseded later by an embedded
 * resolver behind the same name shape.
 */
export function serviceDnsName(
  composeServiceName: string,
  replicaOrdinal: number | null,
  environmentId: string
): string[] {
  const serviceLevel = `${composeServiceName}.${environmentId}`
  if (replicaOrdinal !== null && Number.isInteger(replicaOrdinal) && replicaOrdinal >= 1) {
    return [`${composeServiceName}-${replicaOrdinal}.${environmentId}`, serviceLevel]
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

/**
 * What a host-run service (a PHP site or native app, not a container) dials
 * for its managed database: ProxySQL's published listener on loopback.
 */
export const HOST_RUN_LOOPBACK_HOST = '127.0.0.1'

/** Default `binding.key_prefix` when the operator omits one. */
export const DEFAULT_BINDING_KEY_PREFIX = 'DATABASE'

/** Binding key-prefix shape (mirrored by DB CHECK `binding_key_prefix_format_check`). */
export const BINDING_KEY_PREFIX_RE = /^[A-Za-z_]\w*$/

export const MAX_BINDING_KEY_PREFIX_LENGTH = 64

export type BindingPrefixedKeys = {
  url: string
  caCert: string
  /** Host-run PHP sites only: path of a CA file the daemon keeps for the site. */
  caFile: string
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
    caFile: `${prefix}_CA_FILE`,
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
      throw new TypeError('binding key prefix collides with reserved deploy keys')
    }
  }
  // Catch the short prefix that would mint reserved keys when extended with
  // suffixes we control (e.g. `TURBOPANEL` → `TURBOPANEL_SERVICE_ID`).
  if (trimmed === 'TURBOPANEL' || trimmed.startsWith('TURBOPANEL_')) {
    throw new TypeError('binding key prefix collides with reserved deploy keys')
  }
  return trimmed
}
