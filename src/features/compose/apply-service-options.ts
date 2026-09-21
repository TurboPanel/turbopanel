import type { ComposeDocument } from "./types.ts";
import {
  formatStopGracePeriod,
  parseServiceOptions,
  resolveHealthCheckPolicy,
  resolveMaxRestartAttempts,
  resolveStopGracePeriodSeconds,
  type ServiceOptions,
} from "../projects/service-options.ts";
import { isNodeComposeService, isSiteComposeService } from "./service-kind.ts";

export type ServiceOptionsByComposeName = Map<string, ServiceOptions>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listComposeServiceNames(document: ComposeDocument): string[] {
  const services = document.data.services;
  if (!isRecord(services)) return [];
  return Object.keys(services).sort((a, b) => a.localeCompare(b));
}

function hasHealthCheck(service: Record<string, unknown>): boolean {
  return isRecord(service.healthcheck);
}

export function serviceHasComposeHealthCheck(
  document: ComposeDocument,
  composeServiceName: string,
): boolean {
  const services = document.data.services;
  if (!isRecord(services)) return false;
  const service = services[composeServiceName];
  return isRecord(service) && hasHealthCheck(service);
}

export type HealthCheckWarning = {
  composeServiceName: string;
  policy: "warn" | "required";
};

export function collectHealthCheckWarnings(
  document: ComposeDocument,
  optionsByComposeName: ServiceOptionsByComposeName,
): HealthCheckWarning[] {
  const warnings: HealthCheckWarning[] = [];
  for (const composeServiceName of listComposeServiceNames(document)) {
    const options = optionsByComposeName.get(composeServiceName) ?? {};
    const parsed = parseServiceOptions(options) ?? {};
    const policy = resolveHealthCheckPolicy(parsed);
    if (policy === "disabled") continue;
    const services = document.data.services;
    const rawService = isRecord(services)
      ? services[composeServiceName]
      : undefined;
    // Sites are host nginx/apache — not Docker healthchecks.
    if (isRecord(rawService) && isSiteComposeService(rawService)) {
      continue;
    }
    // Compose `healthcheck:` (or an image HEALTHCHECK once Docker reports it)
    // is enough — we only gate when the operator opted into warn/required and
    // the compose service has no healthcheck block.
    if (isRecord(rawService) && hasHealthCheck(rawService)) {
      continue;
    }
    if (policy === "warn" || policy === "required") {
      warnings.push({ composeServiceName, policy });
    }
  }
  return warnings;
}

/**
 * Map resource limits onto a Compose service fragment.
 * Shared by tenant deploy and managed-engine runtime specs so `cpus` /
 * `mem_limit` / `mem_reservation` / `deploy.resources.limits` never drift.
 */
export function applyResourcesToComposeService(
  service: Record<string, unknown>,
  resources: NonNullable<ServiceOptions["resources"]>,
): void {
  if (resources.cpus !== undefined) {
    service.cpus = resources.cpus;
  }
  if (resources.memoryBytes !== undefined) {
    service.mem_limit = resources.memoryBytes;
  }
  if (resources.memoryReservationBytes !== undefined) {
    service.mem_reservation = resources.memoryReservationBytes;
  }

  const deploy = isRecord(service.deploy) ? { ...service.deploy } : {};
  const deployResources = isRecord(deploy.resources)
    ? { ...deploy.resources }
    : {};
  const limits = isRecord(deployResources.limits)
    ? { ...deployResources.limits }
    : {};

  if (resources.cpus !== undefined) {
    limits.cpus = String(resources.cpus);
  }
  if (resources.memoryBytes !== undefined) {
    limits.memory = `${resources.memoryBytes}`;
  }

  if (Object.keys(limits).length > 0) {
    deployResources.limits = limits;
    deploy.resources = deployResources;
    service.deploy = deploy;
  }
}

function applyRestartPolicy(
  service: Record<string, unknown>,
  maxAttempts: number,
): void {
  const deploy = isRecord(service.deploy) ? { ...service.deploy } : {};
  const restartPolicy: Record<string, unknown> = isRecord(deploy.restart_policy)
    ? { ...deploy.restart_policy }
    : { condition: "on-failure" };
  restartPolicy.max_attempts = maxAttempts;
  deploy.restart_policy = restartPolicy;
  service.deploy = deploy;
}

/**
 * Where the daemon runs a hook: inside the named compose service's container
 * (`docker compose run` before `up`, `exec` after) — never a host shell. The
 * daemon refuses a command-bearing hook without this field.
 */
export type ServiceDeployHookConfinement = "compose-service";

export type ServiceDeployHook = {
  composeServiceName: string;
  confinement?: ServiceDeployHookConfinement;
  preDeployCommand?: string;
  postDeployCommand?: string;
  buildDisableCache?: boolean;
};

/** Whether deploy hooks are read from service options for this deploy. */
export type ApplyServiceOptionsHookPolicy = {
  /** The organization's `deployHooksEnabled` gate; off drops hook commands. */
  enabled: boolean;
};

const DEFAULT_HOOK_POLICY: ApplyServiceOptionsHookPolicy = { enabled: false };

export type ApplyServiceOptionsResult = {
  document: ComposeDocument;
  hooks: ServiceDeployHook[];
};

/**
 * Friendly name the container answers to after allocation renames it to the
 * service UUID: the authored `container_name` when the operator typed one,
 * else the compose service key.
 */
export function friendlyContainerName(
  service: Record<string, unknown>,
  composeServiceName: string,
): string {
  const authored = service.container_name;
  if (typeof authored === "string" && authored.trim().length > 0) {
    return authored.trim();
  }
  return composeServiceName;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function cloneNetworkEntry(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function mergeAliases(existing: unknown, alias: string): string[] {
  const aliases: string[] = [];
  if (Array.isArray(existing)) {
    for (const entry of existing) {
      if (isNonEmptyString(entry) && !aliases.includes(entry)) {
        aliases.push(entry);
      }
    }
  }
  if (!aliases.includes(alias)) aliases.push(alias);
  return aliases;
}

function listFormNetworksToMapping(
  networks: unknown[],
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of networks) {
    if (isNonEmptyString(key)) next[key] = {};
  }
  return next;
}

function mappingFormNetworks(
  networks: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(networks)) {
    next[key] = cloneNetworkEntry(value);
  }
  return next;
}

function composeNetworksAsMapping(networks: unknown): Record<string, unknown> {
  if (Array.isArray(networks)) return listFormNetworksToMapping(networks);
  if (isRecord(networks)) return mappingFormNetworks(networks);
  return {};
}

function attachAliasToNetworkMapping(
  mapping: Record<string, unknown>,
  alias: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapping)) {
    const entry = cloneNetworkEntry(value);
    entry.aliases = mergeAliases(entry.aliases, alias);
    next[key] = entry;
  }
  return next;
}

/**
 * Docker allows exactly one container name, so the friendly name comes back as
 * a **network alias** on every network the service joins — a service that
 * declares none joins the implicit `default`, which is named explicitly here so
 * the alias has somewhere to live. Mapping form is deliberate: the daemon
 * overlay unions platform networks in the same shape, so aliases survive the
 * `-f compose.yaml -f daemon.yaml` merge.
 */
function applyNetworkAlias(
  service: Record<string, unknown>,
  alias: string,
): void {
  const mapping = composeNetworksAsMapping(service.networks);
  if (Object.keys(mapping).length === 0) mapping.default = {};
  service.networks = attachAliasToNetworkMapping(mapping, alias);
}

function applyParsedOptionsToService(
  service: Record<string, unknown>,
  parsed: ServiceOptions,
  containerName: string | undefined,
  composeServiceName: string,
): void {
  if (containerName !== undefined && containerName.length > 0) {
    // Allocation renames the container to the service UUID; give the operator's
    // name back as a network alias so it stays reachable.
    const friendlyName = friendlyContainerName(service, composeServiceName);
    service.container_name = containerName;
    if (friendlyName !== containerName) {
      applyNetworkAlias(service, friendlyName);
    }
  }

  if (service.stop_grace_period === undefined) {
    service.stop_grace_period = formatStopGracePeriod(
      resolveStopGracePeriodSeconds(parsed),
    );
  }

  if (parsed.resources) {
    applyResourcesToComposeService(service, parsed.resources);
  }

  applyRestartPolicy(service, resolveMaxRestartAttempts(parsed));
}

function buildServiceDeployHook(
  composeServiceName: string,
  parsed: ServiceOptions,
): ServiceDeployHook | undefined {
  const hook: ServiceDeployHook = { composeServiceName };
  if (parsed.preDeployCommand) hook.preDeployCommand = parsed.preDeployCommand;
  if (parsed.postDeployCommand) {
    hook.postDeployCommand = parsed.postDeployCommand;
  }
  if (hook.preDeployCommand || hook.postDeployCommand) {
    hook.confinement = "compose-service";
  }
  if (parsed.build?.disableCache) hook.buildDisableCache = true;
  if (
    hook.preDeployCommand || hook.postDeployCommand || hook.buildDisableCache
  ) {
    return hook;
  }
  return undefined;
}

export function applyServiceOptionsToComposeDocument(
  document: ComposeDocument,
  optionsByComposeName: ServiceOptionsByComposeName,
  /**
   * Allocation is the sole writer of compose `container_name`. Keys are
   * (possibly clone) compose service names → allocated container_name values.
   * Overwrites any operator-typed value on the document.
   */
  containerNameByComposeName?: ReadonlyMap<string, string>,
  /**
   * The organization's opt-in per-service ceiling, applied only to container
   * services that declare none of their own — never a cap on a service that
   * set one, and absent unless the organization opted in.
   */
  defaultResourceLimits?: { cpus?: number; memoryBytes?: number } | null,
  /**
   * Deploy-hook gate. Hooks are only read from `service.options` when the
   * organization enabled them; the default (absent) reads none, so a caller
   * that has not consulted the gate cannot emit a hook by accident.
   */
  hookPolicy?: ApplyServiceOptionsHookPolicy,
): ApplyServiceOptionsResult {
  const hooksEnabled = (hookPolicy ?? DEFAULT_HOOK_POLICY).enabled;
  const data = { ...document.data };
  const services = isRecord(data.services) ? { ...data.services } : {};
  const hooks: ServiceDeployHook[] = [];

  for (const composeServiceName of listComposeServiceNames(document)) {
    const rawService = services[composeServiceName];
    if (!isRecord(rawService)) continue;

    const service = { ...rawService };
    const parsed = parseServiceOptions(
      optionsByComposeName.get(composeServiceName),
      { deployHooks: hooksEnabled },
    ) ?? {};
    applyParsedOptionsToService(
      service,
      parsed,
      containerNameByComposeName?.get(composeServiceName),
      composeServiceName,
    );

    applyDefaultResourceLimits(service, defaultResourceLimits);

    const hook = buildServiceDeployHook(composeServiceName, parsed);
    if (hook) hooks.push(hook);

    services[composeServiceName] = service;
  }

  data.services = services;

  return {
    document: {
      version: 1,
      data,
      presentation: document.presentation,
    },
    hooks,
  };
}

/**
 * Fill a per-service ceiling only where the document has none.
 *
 * Runs after the per-service options above, so an operator's own
 * `mem_limit` / `cpus` / `deploy.resources.limits`, and anything the service
 * row pinned, both win. A host-native service (site, node app) is skipped:
 * it runs under systemd rather than Docker and takes its ceiling from the
 * unit. Decided 2026-09-16 (user): opt-in per organization, never a silent
 * platform-wide number.
 */
function applyDefaultResourceLimits(
  service: Record<string, unknown>,
  limits: { cpus?: number; memoryBytes?: number } | null | undefined,
): void {
  if (!limits) return;
  if (limits.cpus === undefined && limits.memoryBytes === undefined) return;
  if (isHostNativeComposeService(service)) return;
  if (serviceHasResourceCeiling(service)) return;
  applyResourcesToComposeService(service, {
    ...(limits.cpus === undefined ? {} : { cpus: limits.cpus }),
    ...(limits.memoryBytes === undefined
      ? {}
      : { memoryBytes: limits.memoryBytes }),
  });
}

/** Any of the places Compose can express a ceiling — mirrors the linter's rule. */
function serviceHasResourceCeiling(service: Record<string, unknown>): boolean {
  if (service.mem_limit !== undefined || service.cpus !== undefined) {
    return true;
  }
  const deploy = isRecord(service.deploy) ? service.deploy : undefined;
  const resources = deploy && isRecord(deploy.resources)
    ? deploy.resources
    : undefined;
  const limits = resources && isRecord(resources.limits)
    ? resources.limits
    : undefined;
  return limits !== undefined &&
    (limits.memory !== undefined || limits.cpus !== undefined);
}

function isHostNativeComposeService(service: Record<string, unknown>): boolean {
  return isSiteComposeService(service) || isNodeComposeService(service);
}

export function buildServiceOptionsMap(
  rows: Array<{ composeServiceName: string; options: unknown }>,
): ServiceOptionsByComposeName {
  const map: ServiceOptionsByComposeName = new Map();
  for (const row of rows) {
    const parsed = parseServiceOptions(row.options);
    if (parsed) map.set(row.composeServiceName, parsed);
  }
  return map;
}
