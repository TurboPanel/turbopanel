/**
 * Defensive parsers for `organization.options` jsonb fields used by the
 * client timezone, host-defaults, server-capacity, and default-environment APIs.
 */

import {
  isPrincipalNameScheme,
  type PrincipalNamePolicy,
  type PrincipalNameScheme,
  resolveOrgPrincipalNameScheme,
} from '../../lib/principal-name-scheme.ts'
import { DEPLOY_DEFAULT_TIMEOUT_MS } from '../commands/deploy-limits.ts'
import { isValidEnvironmentName } from '../../contracts/directory-names.ts'
import { normalizeDisplayName } from '../../lib/display-name-format.ts'
import {
  type NtpDefaults,
  parseHideWebServerNames,
  parseNtpDefaults,
  parseSshPort,
} from '../servers/host-defaults.ts'
import {
  type ManagedOrganizationDefaults,
  parseManagedOrganizationDefaults,
} from '../managed/org-defaults.ts'
import {
  type MetricsCapabilityPlanOverride,
  parseMetricsCapabilityPlanOverride,
} from './metrics-capability-override.ts'
import {
  type OrganizationDockerNetworking,
  parseOrganizationDockerNetworking,
} from '../deploy/docker-address-pools.ts'
import { parsePhpModes, type PhpMode } from '../hostings/php-mode.ts'
import {
  DEFAULT_DIRECTORY_NAME_MODE,
  type DirectoryNameMode,
  isDirectoryNameMode,
} from '../folders/vocabulary.ts'

/** Platform fallback when `defaultEnvironmentName` is unset. */
export const DEFAULT_ENVIRONMENT_NAME = 'production'

/** Display unit for temperature metrics (chart axes, tooltips, thresholds). */
export type TemperatureUnit = 'celsius' | 'fahrenheit'

const TEMPERATURE_UNITS = new Set<TemperatureUnit>(['celsius', 'fahrenheit'])

/** Platform fallback when `temperatureUnit` is unset. */
export const DEFAULT_TEMPERATURE_UNIT: TemperatureUnit = 'celsius'

/** Smallest and largest organization deploy time limit, in minutes. */
export const DEPLOY_TIMEOUT_MIN_MINUTES = 5
export const DEPLOY_TIMEOUT_MAX_MINUTES = 240

export type OrganizationOptions = {
  /** Org-wide default timezone applied when a server has no override. */
  defaultServerTimezone?: string
  /**
   * When true, the org default wins over any per-server `options.timezone`
   * override.
   */
  enforceServerTimezone?: boolean
  /**
   * Cap on enrolled servers + unconsumed registration keys for this org.
   * Omitted or `null` = unlimited (self-hosted default). Workers/Stripe billing
   * will set a concrete cap later; self-hosted operators may set one on the
   * control plane.
   */
  maxServers?: number | null
  /**
   * Org-wide name used for the environment scaffolded with every new project.
   * Platform fallback is {@link DEFAULT_ENVIRONMENT_NAME} (`production`).
   */
  defaultEnvironmentName?: string
  /**
   * Desired SSH listen port for fleet hosts that do not set a datacenter or
   * server override. Omitted → inherit platform default 22.
   */
  sshPort?: number
  /** Desired NTP client settings inherited by datacenters and servers. */
  ntp?: NtpDefaults
  /**
   * Hide web server names and versions on servers that do not set their own.
   * Omitted → on.
   */
  hideWebServerNames?: boolean
  /**
   * Preferred TurboFabric state for this organization. Does not create or tear
   * down the mesh — `PUT /organizations/:id/fabric` remains the enable path.
   */
  defaultFabricEnabled?: boolean
  /**
   * Org-wide managed-database defaults inherited by services that set no
   * override. See `managed/org-defaults.ts`.
   */
  managedDatabase?: ManagedOrganizationDefaults
  /**
   * When on (the default — preferred for security), every newly created
   * principal's applied login (Linux account / database role) is the short
   * `username` plus a random `_<11 chars>` suffix. Off = applied login equals
   * the short name. Decided per principal at create; toggling never renames
   * existing principals. Managed root logins are always suffixed regardless.
   */
  randomizedPrincipalUsernames?: boolean
  /**
   * Org default principal name scheme (`plain` | `partial` | `random`) for
   * the system name (login on the host or engine). Wins over the legacy
   * boolean above, which stays readable as a fallback (true = partial,
   * false = plain). See `lib/principal-name-scheme.ts`.
   */
  principalNameScheme?: PrincipalNameScheme
  /**
   * Org policy lock: when true every NEW principal must use the effective
   * default scheme and a create asking for another one is refused with
   * `principal_scheme_locked`. Never renames existing principals.
   */
  principalNameSchemeLocked?: boolean
  /**
   * How service and volume folders are named for the whole organization:
   * `slug` (a readable name), `uuid` (the asset id) or `both` (a choice per
   * asset, default slug). Absent means `slug`. Never renames an existing
   * folder. See `features/folders/names.ts`.
   */
  directoryNames?: DirectoryNameMode
  /**
   * True once the first folder exists for the organization (written when that
   * folder is planned) or a manager locks it by hand. While true the setting
   * cannot change and a create asking for another kind of name is refused.
   */
  directoryNamesLocked?: boolean
  /**
   * Display unit for temperature metrics (chart axes, tooltips, thresholds).
   * Platform fallback is {@link DEFAULT_TEMPERATURE_UNIT} (`celsius`).
   */
  temperatureUnit?: TemperatureUnit
  /**
   * Org-wide default overrides for the v5 metrics capability plan (see
   * `../daemon/metrics/capability-plan.ts`). Layered under any per-server
   * `server.options.metricsCapabilityPlan` override by
   * `resolveEffectiveMetricsCapabilityPlan` (`db/server-metadata.ts`), on
   * top of a license-tier base when one is bound.
   */
  metricsCapabilityPlan?: MetricsCapabilityPlanOverride
  /**
   * Org-wide Docker host addressing (`default-address-pools` / `bip`) every
   * enrolled host merges into `/etc/docker/daemon.json`. See
   * `docker-address-pools.ts`. Pool bases and the default bridge network also
   * join the org CIDR registry (`dockerHostCidrs`).
   */
  docker?: OrganizationDockerNetworking
  /**
   * Gate for Let's Encrypt / ACME certificate issuance — the tenant `tls`
   * library (`POST /tls` with `source: 'lets_encrypt'`), the one-click button,
   * compose `tls.mode: automatic`, and the deploy-time `tlsMode: 'acme'` wire
   * the resolved TLS status can produce. New organizations start with it on
   * ({@link NEW_ORGANIZATION_OPTIONS}); a row without the key (an organization
   * made before that) reads as off, so existing organizations keep what they
   * had. Some operators do not want Let's Encrypt used against their servers
   * at all and turn it off. Toggling off does not revoke certificates already
   * issued.
   */
  acmeEnabled?: boolean
  /**
   * Step-up re-authentication for permanent actions (delete a project, remove
   * a member, revoke a key, ...). When on, those routes refuse with
   * `reauth_required` until the signed-in person has just proved who they are
   * (see `client/authn/step-up.ts`). Off by default so a self-hosted install
   * never surprises anyone; turning it on is recommended and owner-only.
   */
  requireReauthForDestructive?: boolean
  /**
   * Opt-in gate for the namespace/capability-escaping Compose fields
   * (`privileged`, `cap_add`, `devices`, `network_mode`, `pid`, `ipc`,
   * `userns_mode`, `security_opt`, `cgroup_parent`, `sysctls` — see
   * `lib/compose/field-policy.ts`'s `GATED_SERVICE_FIELD_KEYS`). Off by
   * default: any of these on a tenant compose service is root-equivalent
   * access to the shared daemon host, compromising every co-hosted tenant —
   * see the 2026-09-15 security audit's `sec-compose-privileged-gate`
   * finding. An org that has a real need for one of these (rare) has to turn
   * this on explicitly; it is not a per-field allowlist.
   */
  composeGatedFieldsEnabled?: boolean
  /**
   * Whether a Compose build may fetch its source from a public remote: a
   * `build.context` that is a URL or git repository. Off by default, because
   * the fetched tree (and anything a Dockerfile it contains pulls in) was never
   * seen by a project member's reviewers. Internal hosts stay refused either
   * way. Dockerfile `ADD http(s)://` lines are not read by the control plane.
   */
  composeRemoteBuildSourcesEnabled?: boolean
  /**
   * Whether services in this organization may carry `preDeployCommand` /
   * `postDeployCommand`. Off by default: a hook is arbitrary shell authored
   * by a project member and executed by the daemon at deploy time (confined
   * to the service's container, but still code a member did not have to
   * commit). An owner turns it on explicitly for the organization; until
   * then the options parser drops hook fields and no deploy carries them.
   */
  deployHooksEnabled?: boolean
  /**
   * Whether the new-project form opens its Environment section (the primary
   * environment name) without being asked. Off by default: most projects keep
   * one environment, so the name stays tucked away. A display preference for
   * the client; nothing on the server branches on it.
   */
  openEnvironmentSectionByDefault?: boolean
  /**
   * Whether the new-project form opens its Workspace section without being
   * asked. Off by default: a new project goes into the default workspace.
   */
  openWorkspaceSectionByDefault?: boolean
  /**
   * Per-service ceiling applied at deploy to any container service whose
   * compose sets none (`mem_limit` / `cpus` / `deploy.resources.limits`).
   *
   * Opt-in, and omitted by default: decided 2026-09-16 (user) that 0.1.0
   * ships no platform-wide number, because a wrong one breaks legitimate
   * workloads and there are no per-container metrics yet to justify a
   * figure. The compose linter says so advisorily on every unbounded
   * service (`field_recommends_resource_limits`); this is the organization's
   * answer when it wants one. A service that declares its own ceiling is
   * never overridden — the default fills a gap, it does not cap anyone.
   */
  composeDefaultResourceLimits?: {
    /** Whole or fractional cores, as Compose's `cpus`. */
    cpus?: number
    /** Bytes, as Compose's `mem_limit`. */
    memoryBytes?: number
  }
  /**
   * PHP modes this organization offers its sites (`fastcgi`, `fpm`,
   * `lsphp-detached`, `lsphp-attached`). Omitted offers every mode; managers
   * and owners set it through `/organizations/:id/php-modes`. See
   * `features/hostings/php-mode.ts`.
   */
  phpModes?: PhpMode[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when no finite server seat cap is configured. */
export function isUnlimitedMaxServers(maxServers: number | null | undefined): boolean {
  return maxServers === null || maxServers === undefined
}

/**
 * Parse a maxServers value from JSON. Returns `{ ok: true, value }` where
 * `value` is a non-negative integer, or `null` for unlimited. Invalid input
 * returns `{ ok: false }`.
 */
export function parseMaxServersInput(
  value: unknown
): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false }
  }
  return { ok: true, value }
}

/**
 * Parse a defaultEnvironmentName PUT body value.
 * `null` → `{ ok: true, value: null }` (reset to platform default). Empty /
 * whitespace-only strings, non-strings, names longer than the display-name
 * cap, or names with control characters → `{ ok: false }`.
 */
export function parseDefaultEnvironmentNameInput(
  value: unknown
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false }
  // The default becomes the folder name of the first environment of every new
  // project, so it has to be a valid environment name, not just a display name.
  const normalized = normalizeDisplayName(value)
  if (!isValidEnvironmentName(normalized)) {
    return { ok: false }
  }
  return { ok: true, value: normalized }
}

/**
 * Resolved scaffold name: option when set and still a valid environment name,
 * else the platform fallback (a value saved before names became folder names
 * is not used).
 */
export function resolveDefaultEnvironmentName(options: OrganizationOptions): string {
  const configured = options.defaultEnvironmentName
  return configured !== undefined && isValidEnvironmentName(configured)
    ? configured
    : DEFAULT_ENVIRONMENT_NAME
}

function assignTrimmedOption(
  options: OrganizationOptions,
  key: 'defaultServerTimezone' | 'defaultEnvironmentName',
  value: unknown
): void {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (trimmed.length > 0) options[key] = trimmed
}

function assignMaxServers(options: OrganizationOptions, value: Record<string, unknown>): void {
  if (!('maxServers' in value)) return
  const parsed = parseMaxServersInput(value.maxServers)
  if (parsed.ok) options.maxServers = parsed.value
}

function assignHideWebServerNames(
  options: OrganizationOptions,
  value: Record<string, unknown>
): void {
  const hide = parseHideWebServerNames(value.hideWebServerNames)
  if (hide !== undefined) options.hideWebServerNames = hide
}

function assignManagedDatabase(options: OrganizationOptions, value: Record<string, unknown>): void {
  if (!('managedDatabase' in value)) return
  const managedDatabase = parseManagedOrganizationDefaults(value.managedDatabase)
  if (Object.keys(managedDatabase).length > 0) {
    options.managedDatabase = managedDatabase
  }
}

function assignMetricsCapabilityPlan(
  options: OrganizationOptions,
  value: Record<string, unknown>
): void {
  if (!('metricsCapabilityPlan' in value)) return
  const metricsCapabilityPlan = parseMetricsCapabilityPlanOverride(value.metricsCapabilityPlan)
  if (Object.keys(metricsCapabilityPlan).length > 0) {
    options.metricsCapabilityPlan = metricsCapabilityPlan
  }
}

function assignDocker(options: OrganizationOptions, value: Record<string, unknown>): void {
  if (!('docker' in value)) return
  const docker = parseOrganizationDockerNetworking(value.docker)
  if (Object.keys(docker).length > 0) {
    options.docker = docker
  }
}

function assignComposeOptIns(options: OrganizationOptions, value: Record<string, unknown>): void {
  if (typeof value.composeGatedFieldsEnabled === 'boolean') {
    options.composeGatedFieldsEnabled = value.composeGatedFieldsEnabled
  }
  if (typeof value.composeRemoteBuildSourcesEnabled === 'boolean') {
    options.composeRemoteBuildSourcesEnabled = value.composeRemoteBuildSourcesEnabled
  }
}

function assignRequireReauth(options: OrganizationOptions, value: Record<string, unknown>): void {
  if (typeof value.requireReauthForDestructive === 'boolean') {
    options.requireReauthForDestructive = value.requireReauthForDestructive
  }
}

/** The new-project form's "open by default" switches; anything but a boolean is dropped. */
function assignProjectFormDefaults(
  options: OrganizationOptions,
  value: Record<string, unknown>
): void {
  if (typeof value.openEnvironmentSectionByDefault === 'boolean') {
    options.openEnvironmentSectionByDefault = value.openEnvironmentSectionByDefault
  }
  if (typeof value.openWorkspaceSectionByDefault === 'boolean') {
    options.openWorkspaceSectionByDefault = value.openWorkspaceSectionByDefault
  }
}

/** Parse organization.options jsonb (missing/invalid keys → omitted). */
export function parseOrganizationOptions(value: unknown): OrganizationOptions {
  if (!isRecord(value)) return {}
  const options: OrganizationOptions = {}
  assignTrimmedOption(options, 'defaultServerTimezone', value.defaultServerTimezone)
  if (typeof value.enforceServerTimezone === 'boolean') {
    options.enforceServerTimezone = value.enforceServerTimezone
  }
  assignMaxServers(options, value)
  assignTrimmedOption(options, 'defaultEnvironmentName', value.defaultEnvironmentName)
  const sshPort = parseSshPort(value.sshPort)
  if (sshPort !== undefined) options.sshPort = sshPort
  const ntp = parseNtpDefaults(value.ntp)
  if (ntp) options.ntp = ntp
  assignHideWebServerNames(options, value)
  if (typeof value.defaultFabricEnabled === 'boolean') {
    options.defaultFabricEnabled = value.defaultFabricEnabled
  }
  assignManagedDatabase(options, value)
  if (typeof value.randomizedPrincipalUsernames === 'boolean') {
    options.randomizedPrincipalUsernames = value.randomizedPrincipalUsernames
  }
  if (isPrincipalNameScheme(value.principalNameScheme)) {
    options.principalNameScheme = value.principalNameScheme
  }
  if (typeof value.principalNameSchemeLocked === 'boolean') {
    options.principalNameSchemeLocked = value.principalNameSchemeLocked
  }
  if (
    typeof value.temperatureUnit === 'string' &&
    TEMPERATURE_UNITS.has(value.temperatureUnit as TemperatureUnit)
  ) {
    options.temperatureUnit = value.temperatureUnit as TemperatureUnit
  }
  assignMetricsCapabilityPlan(options, value)
  assignDocker(options, value)
  if (typeof value.acmeEnabled === 'boolean') {
    options.acmeEnabled = value.acmeEnabled
  }
  assignRequireReauth(options, value)
  assignComposeOptIns(options, value)
  if (typeof value.deployHooksEnabled === 'boolean') {
    options.deployHooksEnabled = value.deployHooksEnabled
  }
  assignProjectFormDefaults(options, value)
  assignComposeDefaultResourceLimits(options, value)
  assignPhpModes(options, value)
  assignDirectoryNames(options, value)
  return options
}

/** A whole number of minutes inside the allowed range; anything else is dropped. */
export function parseDeployTimeoutMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= DEPLOY_TIMEOUT_MIN_MINUTES && value <= DEPLOY_TIMEOUT_MAX_MINUTES
    ? value
    : undefined
}

/**
 * Effective deploy time limit in milliseconds from the stored
 * `organization.deploy_timeout_minutes`: the setting, or 30 minutes when it is
 * null or (defensively) outside 5 to 240 whole minutes.
 */
export function resolveDeployTimeoutMs(minutes: unknown): number {
  const valid = parseDeployTimeoutMinutes(minutes)
  return valid === undefined ? DEPLOY_DEFAULT_TIMEOUT_MS : valid * 60_000
}

function assignDirectoryNames(
  options: Pick<OrganizationOptions, 'directoryNames' | 'directoryNamesLocked'>,
  value: Record<string, unknown>
): void {
  if (isDirectoryNameMode(value.directoryNames)) options.directoryNames = value.directoryNames
  if (typeof value.directoryNamesLocked === 'boolean') {
    options.directoryNamesLocked = value.directoryNamesLocked
  }
}

/** Effective folder-name mode and lock for new services and volumes. */
export function resolveDirectoryNames(options: OrganizationOptions): {
  mode: DirectoryNameMode
  locked: boolean
} {
  return {
    mode: options.directoryNames ?? DEFAULT_DIRECTORY_NAME_MODE,
    locked: options.directoryNamesLocked === true,
  }
}

function assignPhpModes(options: { phpModes?: PhpMode[] }, value: Record<string, unknown>): void {
  const phpModes = parsePhpModes(value.phpModes)
  if (phpModes) options.phpModes = phpModes
}

/** Effective randomized-usernames default: on unless the org opted out. */
export function resolveRandomizedPrincipalUsernames(options: OrganizationOptions): boolean {
  return resolveOrgPrincipalNameScheme(options) !== 'plain'
}

/** Effective org default scheme and lock for new principals. */
export function resolvePrincipalNamePolicy(options: OrganizationOptions): PrincipalNamePolicy {
  return {
    defaultScheme: resolveOrgPrincipalNameScheme(options),
    locked: options.principalNameSchemeLocked === true,
  }
}

/** Resolved display unit: option when set, else platform fallback (celsius). */
export function resolveTemperatureUnit(options: OrganizationOptions): TemperatureUnit {
  return options.temperatureUnit ?? DEFAULT_TEMPERATURE_UNIT
}

/**
 * `organization.options` for an organization being created: Let's Encrypt
 * allowed. Only new rows get this; nothing rewrites existing organizations.
 */
export const NEW_ORGANIZATION_OPTIONS: Readonly<OrganizationOptions> = Object.freeze({
  acmeEnabled: true,
})

/** Effective Let's Encrypt gate: off unless the key is set (new organizations set it on). */
export function resolveAcmeEnabled(options: OrganizationOptions): boolean {
  return options.acmeEnabled ?? false
}

/** Effective step-up gate for permanent actions: off unless an owner turned it on. */
export function resolveRequireReauthForDestructive(options: OrganizationOptions): boolean {
  return options.requireReauthForDestructive ?? false
}

function assignComposeDefaultResourceLimits(
  options: OrganizationOptions,
  value: Record<string, unknown>
): void {
  const raw = value.composeDefaultResourceLimits
  if (!isRecord(raw)) return
  const limits: NonNullable<OrganizationOptions['composeDefaultResourceLimits']> = {}
  if (typeof raw.cpus === 'number' && Number.isFinite(raw.cpus) && raw.cpus > 0) {
    limits.cpus = raw.cpus
  }
  if (
    typeof raw.memoryBytes === 'number' &&
    Number.isFinite(raw.memoryBytes) &&
    raw.memoryBytes > 0
  ) {
    limits.memoryBytes = Math.trunc(raw.memoryBytes)
  }
  // An empty or all-invalid object is the same as not opting in.
  if (Object.keys(limits).length > 0) {
    options.composeDefaultResourceLimits = limits
  }
}

/**
 * The organization's default per-service ceiling, or null when it has not
 * opted into one (the 0.1.0 default).
 */
export function resolveComposeDefaultResourceLimits(
  options: OrganizationOptions
): NonNullable<OrganizationOptions['composeDefaultResourceLimits']> | null {
  return options.composeDefaultResourceLimits ?? null
}

/** Effective deploy-hook posture: off (hooks dropped) unless the org opted in. */
export function resolveDeployHooksEnabled(options: OrganizationOptions): boolean {
  return options.deployHooksEnabled ?? false
}

/** Effective gated-Compose-fields posture: off (deny) unless the org opted in. */
export function resolveComposeGatedFieldsEnabled(options: OrganizationOptions): boolean {
  return options.composeGatedFieldsEnabled ?? false
}

/**
 * Parse a temperatureUnit PUT body value.
 * Anything other than `"celsius"` or `"fahrenheit"` → `{ ok: false }` (there
 * is no reset-to-default sentinel — the platform fallback already applies
 * whenever the option is unset).
 */
export function parseTemperatureUnitInput(
  value: unknown
): { ok: true; value: TemperatureUnit } | { ok: false } {
  if (typeof value === 'string' && TEMPERATURE_UNITS.has(value as TemperatureUnit)) {
    return { ok: true, value: value as TemperatureUnit }
  }
  return { ok: false }
}

/** Effective remote-build-sources posture: off (deny) unless the org opted in. */
export function resolveComposeRemoteBuildSourcesEnabled(options: OrganizationOptions): boolean {
  return options.composeRemoteBuildSourcesEnabled ?? false
}
