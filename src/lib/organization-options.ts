/**
 * Defensive parsers for `organization.options` jsonb fields used by the
 * client timezone, host-defaults, server-capacity, and default-environment APIs.
 */

import {
  isValidDisplayName,
  normalizeDisplayName,
} from "./display-name-format.ts";
import {
  type NtpDefaults,
  parseNtpDefaults,
  parseSshPort,
} from "./host-defaults.ts";
import {
  type ManagedOrganizationDefaults,
  parseManagedOrganizationDefaults,
} from "./managed/org-defaults.ts";
import {
  type MetricsCapabilityPlanOverride,
  parseMetricsCapabilityPlanOverride,
} from "../daemon/metrics/capability-plan.ts";
import {
  type OrganizationDockerNetworking,
  parseOrganizationDockerNetworking,
} from "./docker-address-pools.ts";

/** Platform fallback when `defaultEnvironmentName` is unset. */
export const DEFAULT_ENVIRONMENT_NAME = "Production";

/** Display unit for temperature metrics (chart axes, tooltips, thresholds). */
export type TemperatureUnit = "celsius" | "fahrenheit";

const TEMPERATURE_UNITS = new Set<TemperatureUnit>(["celsius", "fahrenheit"]);

/** Platform fallback when `temperatureUnit` is unset. */
export const DEFAULT_TEMPERATURE_UNIT: TemperatureUnit = "celsius";

export type OrganizationOptions = {
  /** Org-wide default timezone applied when a server has no override. */
  defaultServerTimezone?: string;
  /**
   * When true, the org default wins over any per-server `options.timezone`
   * override.
   */
  enforceServerTimezone?: boolean;
  /**
   * Cap on enrolled servers + unconsumed registration keys for this org.
   * Omitted or `null` = unlimited (self-hosted default). Workers/Stripe billing
   * will set a concrete cap later; self-hosted operators may set one on the
   * control plane.
   */
  maxServers?: number | null;
  /**
   * Org-wide name used for the environment scaffolded with every new project.
   * Platform fallback is {@link DEFAULT_ENVIRONMENT_NAME} (`Production`).
   */
  defaultEnvironmentName?: string;
  /**
   * Desired SSH listen port for fleet hosts that do not set a datacenter or
   * server override. Omitted → inherit platform default 22.
   */
  sshPort?: number;
  /** Desired NTP client settings inherited by datacenters and servers. */
  ntp?: NtpDefaults;
  /**
   * Preferred TurboFabric state for this organization. Does not create or tear
   * down the mesh — `PUT /organizations/:id/fabric` remains the enable path.
   */
  defaultFabricEnabled?: boolean;
  /**
   * Org-wide managed-database defaults inherited by services that set no
   * override. See `managed/org-defaults.ts`.
   */
  managedDatabase?: ManagedOrganizationDefaults;
  /**
   * When on (the default — preferred for security), every newly created
   * principal's applied login (Linux account / database role) is the short
   * `username` plus a random `_<11 chars>` suffix. Off = applied login equals
   * the short name. Decided per principal at create; toggling never renames
   * existing principals. Managed root logins are always suffixed regardless.
   */
  randomizedPrincipalUsernames?: boolean;
  /**
   * Display unit for temperature metrics (chart axes, tooltips, thresholds).
   * Platform fallback is {@link DEFAULT_TEMPERATURE_UNIT} (`celsius`).
   */
  temperatureUnit?: TemperatureUnit;
  /**
   * Org-wide default overrides for the v5 metrics capability plan (see
   * `../daemon/metrics/capability-plan.ts`). Layered under any per-server
   * `server.options.metricsCapabilityPlan` override by
   * `resolveEffectiveMetricsCapabilityPlan` (`db/server-metadata.ts`), on
   * top of a license-tier base when one is bound.
   */
  metricsCapabilityPlan?: MetricsCapabilityPlanOverride;
  /**
   * Org-wide Docker host addressing (`default-address-pools` / `bip`) every
   * enrolled host merges into `/etc/docker/daemon.json`. See
   * `docker-address-pools.ts`. Pool bases and the default bridge network also
   * join the org CIDR registry (`dockerHostCidrs`).
   */
  docker?: OrganizationDockerNetworking;
  /**
   * Opt-in gate for Let's Encrypt / ACME certificate issuance — both the
   * tenant `tls` library (`POST /tls` with `source: 'lets_encrypt'`) and the
   * deploy-time `tlsMode: 'acme'` wire the resolved TLS status can produce.
   * Off by default: some operators do not want Let's Encrypt used against
   * their servers at all, so a `managed` TLS row is inert until the org
   * turns this on. Toggling off does not revoke certificates already issued.
   */
  acmeEnabled?: boolean;
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
  composeGatedFieldsEnabled?: boolean;
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
    cpus?: number;
    /** Bytes, as Compose's `mem_limit`. */
    memoryBytes?: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when no finite server seat cap is configured. */
export function isUnlimitedMaxServers(
  maxServers: number | null | undefined,
): boolean {
  return maxServers === null || maxServers === undefined;
}

/**
 * Parse a maxServers value from JSON. Returns `{ ok: true, value }` where
 * `value` is a non-negative integer, or `null` for unlimited. Invalid input
 * returns `{ ok: false }`.
 */
export function parseMaxServersInput(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Parse a defaultEnvironmentName PUT body value.
 * `null` → `{ ok: true, value: null }` (reset to platform default). Empty /
 * whitespace-only strings, non-strings, names longer than the display-name
 * cap, or names with control characters → `{ ok: false }`.
 */
export function parseDefaultEnvironmentNameInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const normalized = normalizeDisplayName(value);
  if (!isValidDisplayName(normalized)) {
    return { ok: false };
  }
  return { ok: true, value: normalized };
}

/** Resolved scaffold name: option when set, else platform fallback. */
export function resolveDefaultEnvironmentName(
  options: OrganizationOptions,
): string {
  return options.defaultEnvironmentName ?? DEFAULT_ENVIRONMENT_NAME;
}

function assignTrimmedOption(
  options: OrganizationOptions,
  key: "defaultServerTimezone" | "defaultEnvironmentName",
  value: unknown,
): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length > 0) options[key] = trimmed;
}

function assignMaxServers(
  options: OrganizationOptions,
  value: Record<string, unknown>,
): void {
  if (!("maxServers" in value)) return;
  const parsed = parseMaxServersInput(value.maxServers);
  if (parsed.ok) options.maxServers = parsed.value;
}

function assignManagedDatabase(
  options: OrganizationOptions,
  value: Record<string, unknown>,
): void {
  if (!("managedDatabase" in value)) return;
  const managedDatabase = parseManagedOrganizationDefaults(
    value.managedDatabase,
  );
  if (Object.keys(managedDatabase).length > 0) {
    options.managedDatabase = managedDatabase;
  }
}

function assignMetricsCapabilityPlan(
  options: OrganizationOptions,
  value: Record<string, unknown>,
): void {
  if (!("metricsCapabilityPlan" in value)) return;
  const metricsCapabilityPlan = parseMetricsCapabilityPlanOverride(
    value.metricsCapabilityPlan,
  );
  if (Object.keys(metricsCapabilityPlan).length > 0) {
    options.metricsCapabilityPlan = metricsCapabilityPlan;
  }
}

function assignDocker(
  options: OrganizationOptions,
  value: Record<string, unknown>,
): void {
  if (!("docker" in value)) return;
  const docker = parseOrganizationDockerNetworking(value.docker);
  if (Object.keys(docker).length > 0) {
    options.docker = docker;
  }
}

/** Parse organization.options jsonb (missing/invalid keys → omitted). */
export function parseOrganizationOptions(value: unknown): OrganizationOptions {
  if (!isRecord(value)) return {};
  const options: OrganizationOptions = {};
  assignTrimmedOption(
    options,
    "defaultServerTimezone",
    value.defaultServerTimezone,
  );
  if (typeof value.enforceServerTimezone === "boolean") {
    options.enforceServerTimezone = value.enforceServerTimezone;
  }
  assignMaxServers(options, value);
  assignTrimmedOption(
    options,
    "defaultEnvironmentName",
    value.defaultEnvironmentName,
  );
  const sshPort = parseSshPort(value.sshPort);
  if (sshPort !== undefined) options.sshPort = sshPort;
  const ntp = parseNtpDefaults(value.ntp);
  if (ntp) options.ntp = ntp;
  if (typeof value.defaultFabricEnabled === "boolean") {
    options.defaultFabricEnabled = value.defaultFabricEnabled;
  }
  assignManagedDatabase(options, value);
  if (typeof value.randomizedPrincipalUsernames === "boolean") {
    options.randomizedPrincipalUsernames = value.randomizedPrincipalUsernames;
  }
  if (
    typeof value.temperatureUnit === "string" &&
    TEMPERATURE_UNITS.has(value.temperatureUnit as TemperatureUnit)
  ) {
    options.temperatureUnit = value.temperatureUnit as TemperatureUnit;
  }
  assignMetricsCapabilityPlan(options, value);
  assignDocker(options, value);
  if (typeof value.acmeEnabled === "boolean") {
    options.acmeEnabled = value.acmeEnabled;
  }
  if (typeof value.composeGatedFieldsEnabled === "boolean") {
    options.composeGatedFieldsEnabled = value.composeGatedFieldsEnabled;
  }
  assignComposeDefaultResourceLimits(options, value);
  return options;
}

/** Effective randomized-usernames default: on unless the org opted out. */
export function resolveRandomizedPrincipalUsernames(
  options: OrganizationOptions,
): boolean {
  return options.randomizedPrincipalUsernames ?? true;
}

/** Resolved display unit: option when set, else platform fallback (celsius). */
export function resolveTemperatureUnit(
  options: OrganizationOptions,
): TemperatureUnit {
  return options.temperatureUnit ?? DEFAULT_TEMPERATURE_UNIT;
}

/** Effective Let's Encrypt gate: off unless the org has opted in. */
export function resolveAcmeEnabled(options: OrganizationOptions): boolean {
  return options.acmeEnabled ?? false;
}

function assignComposeDefaultResourceLimits(
  options: OrganizationOptions,
  value: Record<string, unknown>,
): void {
  const raw = value.composeDefaultResourceLimits;
  if (!isRecord(raw)) return;
  const limits: NonNullable<
    OrganizationOptions["composeDefaultResourceLimits"]
  > = {};
  if (
    typeof raw.cpus === "number" && Number.isFinite(raw.cpus) && raw.cpus > 0
  ) {
    limits.cpus = raw.cpus;
  }
  if (
    typeof raw.memoryBytes === "number" &&
    Number.isFinite(raw.memoryBytes) &&
    raw.memoryBytes > 0
  ) {
    limits.memoryBytes = Math.trunc(raw.memoryBytes);
  }
  // An empty or all-invalid object is the same as not opting in.
  if (Object.keys(limits).length > 0) {
    options.composeDefaultResourceLimits = limits;
  }
}

/**
 * The organization's default per-service ceiling, or null when it has not
 * opted into one (the 0.1.0 default).
 */
export function resolveComposeDefaultResourceLimits(
  options: OrganizationOptions,
): NonNullable<OrganizationOptions["composeDefaultResourceLimits"]> | null {
  return options.composeDefaultResourceLimits ?? null;
}

/** Effective gated-Compose-fields posture: off (deny) unless the org opted in. */
export function resolveComposeGatedFieldsEnabled(
  options: OrganizationOptions,
): boolean {
  return options.composeGatedFieldsEnabled ?? false;
}

/**
 * Parse a temperatureUnit PUT body value.
 * Anything other than `"celsius"` or `"fahrenheit"` → `{ ok: false }` (there
 * is no reset-to-default sentinel — the platform fallback already applies
 * whenever the option is unset).
 */
export function parseTemperatureUnitInput(
  value: unknown,
): { ok: true; value: TemperatureUnit } | { ok: false } {
  if (
    typeof value === "string" && TEMPERATURE_UNITS.has(value as TemperatureUnit)
  ) {
    return { ok: true, value: value as TemperatureUnit };
  }
  return { ok: false };
}
