/**
 * Compile a runtime Compose document for one server.
 *
 * Users author project + environment documents. Deploy sends one compiled
 * `compose.yaml` per participating daemon. Scheduler-only Swarm `deploy:`
 * keys are stripped so standalone Docker does not reinterpret replica counts.
 */

import { serviceDnsName } from "../naming.ts";
import { pruneUnreferencedComposeNetworks } from "./docker-external-networks.ts";
import { applyComposePlacement } from "./placement.ts";
import { type ComposeDocument, emptyComposeDocument } from "./types.ts";

/** Scheduler-only keys never copied into compiled runtime YAML. */
const SCHEDULER_ONLY_DEPLOY_KEYS = new Set([
  "mode",
  "replicas",
  "placement",
  "update_config",
  "rollback_config",
  "endpoint_mode",
]);

export type CompileRuntimeOptions = {
  /**
   * Server this compiled snapshot will run on. Emitted as
   * `x-turbopanel.placement.server_id` (audit only — Docker ignores `x-*`).
   */
  placementServerId?: string;
  /** When set, identity labels include this environment id. */
  environmentId?: string;
  /** When set, drop services not in this set (per-server compile). */
  localServiceNames?: ReadonlySet<string>;
  /** Local replica counts keyed by logical compose service name. */
  localReplicaCounts?: ReadonlyMap<string, number>;
  /**
   * Logical compose network key → host Docker network name (`tpn_<id>`).
   * Rewritten as `external: true` + `name`.
   */
  spanningNetworks?: ReadonlyMap<string, string>;
  /**
   * Local compose service name → slot → spanning-network address. Emits
   * `services.<name>.networks.<key>.ipv4_address` for spanning attachments.
   */
  taskAddressesByService?: ReadonlyMap<string, ReadonlyMap<number, string>>;
  /**
   * Sibling compose services that join spanning networks (same environment).
   * Static `extra_hosts` entries — superseded later by an embedded resolver
   * behind the same {@link serviceDnsName} shape. `networks` is the set of
   * spanning compose keys the peer joins; compile injects a peer only when
   * that set intersects the current service's spanning attachments.
   */
  spanningHostsByService?: ReadonlyMap<string, {
    primary: string;
    replicas: ReadonlyMap<number, string>;
    networks: ReadonlySet<string>;
  }>;
  /**
   * Per-service static `extra_hosts` for the ProxySQL listener
   * (`<serviceId>-in`) on hosts that are not co-resident with it.
   * Merged only into the bound consumer (and expanded clones that share
   * that spanning network). Co-resident consumers join
   * `turbopanel-managed` instead and must not receive these entries.
   */
  managedIngressHostsByService?: ReadonlyMap<
    string,
    ReadonlyArray<{ name: string; address: string }>
  >;
};

export type CompileRuntimeResult = {
  document: ComposeDocument;
  /** Logical compose key → runtime service keys (identity when not expanded). */
  expansion: Map<string, string[]>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function servicesMapping(document: ComposeDocument): Record<string, unknown> {
  const services = document.data.services;
  return isPlainObject(services) ? { ...services } : {};
}

function stripSchedulerDeploy(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(body.deploy)) return body;
  const deploy = { ...body.deploy };
  for (const key of SCHEDULER_ONLY_DEPLOY_KEYS) {
    delete deploy[key];
  }
  const next = { ...body };
  if (Object.keys(deploy).length === 0) {
    delete next.deploy;
  } else {
    next.deploy = deploy;
  }
  return next;
}

function filterDependsOn(
  dependsOn: unknown,
  localServiceNames: ReadonlySet<string>,
): unknown {
  if (Array.isArray(dependsOn)) {
    const kept = dependsOn.filter(
      (entry) => typeof entry === "string" && localServiceNames.has(entry),
    );
    return kept.length > 0 ? kept : undefined;
  }
  if (!isPlainObject(dependsOn)) return dependsOn;
  const kept: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(dependsOn)) {
    if (localServiceNames.has(name)) kept[name] = spec;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function mergeServiceLabels(
  existing: unknown,
  extra: Record<string, string>,
): unknown {
  if (Array.isArray(existing)) {
    const next = [...existing];
    for (const [key, value] of Object.entries(extra)) {
      const prefix = `${key}=`;
      const idx = next.findIndex(
        (item) => typeof item === "string" && item.startsWith(prefix),
      );
      const rendered = `${key}=${value}`;
      if (idx === -1) next.push(rendered);
      else next[idx] = rendered;
    }
    return next;
  }
  const map = isPlainObject(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(extra)) {
    map[key] = value;
  }
  return map;
}

function applyLocalScale(
  body: Record<string, unknown>,
  replicas: number,
  identityLabels: Record<string, string>,
): Record<string, unknown> {
  const next = { ...body };
  if (replicas > 1) {
    next.scale = replicas;
    delete next.container_name;
    next.labels = mergeServiceLabels(next.labels, identityLabels);
  }
  return next;
}

function applyIdentityLabels(
  body: Record<string, unknown>,
  identityLabels: Record<string, string>,
): Record<string, unknown> {
  const next = { ...body };
  delete next.container_name;
  delete next.scale;
  next.labels = mergeServiceLabels(next.labels, identityLabels);
  return next;
}

function spanningReplicaCloneName(serviceName: string, slot: number): string {
  return `${serviceName}-${String(slot + 1)}`;
}

function rewriteSpanningNetworks(
  networks: Record<string, unknown>,
  spanning: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(networks)) {
    const hostName = spanning.get(key);
    if (hostName) {
      next[key] = { external: true, name: hostName };
      continue;
    }
    next[key] = value;
  }
  for (const [key, hostName] of spanning) {
    if (!(key in next)) {
      next[key] = { external: true, name: hostName };
    }
  }
  return next;
}

function attachDefaultNetworkIfNeeded(
  services: Record<string, unknown>,
  spanning: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!spanning.has("default")) return services;
  const next: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(services)) {
    if (!isPlainObject(raw) || raw.networks !== undefined) {
      next[name] = raw;
      continue;
    }
    next[name] = { ...raw, networks: ["default"] };
  }
  return next;
}

function serviceNetworkKeys(networks: unknown): string[] {
  if (Array.isArray(networks)) {
    return networks.filter((entry): entry is string =>
      typeof entry === "string"
    );
  }
  if (isPlainObject(networks)) return Object.keys(networks);
  return [];
}

function spanningKeysForService(
  body: Record<string, unknown>,
  spanning: ReadonlyMap<string, string>,
): string[] {
  const keys = body.networks === undefined && spanning.has("default")
    ? ["default"]
    : serviceNetworkKeys(body.networks);
  return keys.filter((key) => spanning.has(key));
}

function shouldExpandSpanningReplicas(
  replicas: number,
  body: Record<string, unknown>,
  spanning: ReadonlyMap<string, string> | undefined,
): boolean {
  if (replicas <= 1 || !spanning || spanning.size === 0) return false;
  return spanningKeysForService(body, spanning).length > 0;
}

function localSlotsForService(
  replicas: number,
  slots: ReadonlyMap<number, string> | undefined,
): number[] {
  if (slots && slots.size > 0) {
    return [...slots.keys()].sort((a, b) => a - b);
  }
  return Array.from({ length: replicas }, (_, index) => index);
}

function localTaskAddress(
  byService: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined,
  serviceName: string,
): string | undefined {
  const slots = byService?.get(serviceName);
  if (!slots || slots.size === 0) return undefined;
  const lowest = [...slots.keys()].sort((a, b) => a - b)[0];
  return lowest === undefined ? undefined : slots.get(lowest);
}

function sharesSpanningNetwork(
  peerNetworks: ReadonlySet<string> | undefined,
  localSpanningKeys: readonly string[],
): boolean {
  if (!peerNetworks || peerNetworks.size === 0) return false;
  return localSpanningKeys.some((key) => peerNetworks.has(key));
}

function attachServiceIpv4Address(
  body: Record<string, unknown>,
  spanning: ReadonlyMap<string, string>,
  address: string | undefined,
): Record<string, unknown> {
  if (!address || spanning.size === 0) return body;
  const keys = serviceNetworkKeys(body.networks);
  const spanningKeys = keys.filter((key) => spanning.has(key));
  if (spanningKeys.length === 0) return body;

  const asObject: Record<string, unknown> = {};
  if (Array.isArray(body.networks)) {
    for (const key of keys) asObject[key] = {};
  } else if (isPlainObject(body.networks)) {
    for (const [key, value] of Object.entries(body.networks)) {
      asObject[key] = isPlainObject(value) ? { ...value } : {};
    }
  }
  for (const key of spanningKeys) {
    const current = isPlainObject(asObject[key]) ? asObject[key] : {};
    asObject[key] = { ...current, ipv4_address: address };
  }
  return { ...body, networks: asObject };
}

function extraHostsHasName(existing: unknown, name: string): boolean {
  if (Array.isArray(existing)) {
    return existing.some((item) => {
      if (typeof item !== "string") return false;
      return item === name || item.startsWith(`${name}:`) ||
        item.startsWith(`${name}=`);
    });
  }
  if (isPlainObject(existing)) return name in existing;
  return false;
}

function appendReplicaHostAdditions(
  additions: Array<{ name: string; address: string }>,
  hosts: {
    replicas: ReadonlyMap<number, string>;
  },
  serviceName: string,
  environmentId: string,
): void {
  const ordinals = [...hosts.replicas.keys()].sort((a, b) => a - b);
  for (const ordinal of ordinals) {
    const address = hosts.replicas.get(ordinal);
    if (!address) continue;
    const replicaName = serviceDnsName(serviceName, ordinal, environmentId)[0];
    if (!replicaName) continue;
    additions.push({ name: replicaName, address });
  }
}

function extraHostAdditions(
  spanningHosts: ReadonlyMap<string, {
    primary: string;
    replicas: ReadonlyMap<number, string>;
    networks: ReadonlySet<string>;
  }>,
  environmentId: string,
  currentServiceName: string,
  localSpanningKeys: readonly string[],
): Array<{ name: string; address: string }> {
  const additions: Array<{ name: string; address: string }> = [];
  const serviceNames = [...spanningHosts.keys()].sort((a, b) =>
    a.localeCompare(b)
  );
  for (const serviceName of serviceNames) {
    if (serviceName === currentServiceName) continue;
    const hosts = spanningHosts.get(serviceName);
    if (!hosts || !sharesSpanningNetwork(hosts.networks, localSpanningKeys)) {
      continue;
    }
    for (const name of serviceDnsName(serviceName, null, environmentId)) {
      additions.push({ name, address: hosts.primary });
    }
    appendReplicaHostAdditions(additions, hosts, serviceName, environmentId);
  }
  return additions;
}

function mergeExtraHosts(
  existing: unknown,
  additions: ReadonlyArray<{ name: string; address: string }>,
): unknown {
  if (additions.length === 0) return existing;
  if (isPlainObject(existing)) {
    const map = { ...existing };
    for (const { name, address } of additions) {
      if (!(name in map)) map[name] = address;
    }
    return map;
  }
  const next = Array.isArray(existing) ? [...existing] : [];
  for (const { name, address } of additions) {
    if (extraHostsHasName(next, name)) continue;
    next.push(`${name}:${address}`);
  }
  return next;
}

function managedIngressHostsForCompiledService(
  compiledName: string,
  body: Record<string, unknown>,
  options: CompileRuntimeOptions,
  logicalNameByCompiled: ReadonlyMap<string, string>,
): ReadonlyArray<{ name: string; address: string }> {
  const byService = options.managedIngressHostsByService;
  if (!byService || byService.size === 0) return [];
  const logicalName = logicalNameByCompiled.get(compiledName) ?? compiledName;
  const hosts = byService.get(logicalName);
  if (!hosts || hosts.length === 0) return [];
  const spanning = options.spanningNetworks;
  if (
    spanning && spanning.size > 0 &&
    spanningKeysForService(body, spanning).length === 0
  ) {
    return [];
  }
  return hosts;
}

function attachSpanningServiceNetworking(
  services: Record<string, unknown>,
  options: CompileRuntimeOptions,
  logicalNameByCompiled: ReadonlyMap<string, string>,
  addressByCompiled: ReadonlyMap<string, string | undefined>,
): Record<string, unknown> {
  const spanning = options.spanningNetworks;
  const environmentId = options.environmentId;
  const spanningHosts = options.spanningHostsByService;
  const next: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(services)) {
    if (!isPlainObject(raw)) {
      next[name] = raw;
      continue;
    }
    let body = spanning && spanning.size > 0
      ? attachServiceIpv4Address(
        raw,
        spanning,
        addressByCompiled.get(name),
      )
      : raw;
    if (
      environmentId && spanning && spanning.size > 0 && spanningHosts &&
      spanningHosts.size > 0
    ) {
      const logicalName = logicalNameByCompiled.get(name) ?? name;
      const additions = extraHostAdditions(
        spanningHosts,
        environmentId,
        logicalName,
        spanningKeysForService(body, spanning),
      );
      if (additions.length > 0) {
        body = {
          ...body,
          extra_hosts: mergeExtraHosts(body.extra_hosts, additions),
        };
      }
    }
    const managedHosts = managedIngressHostsForCompiledService(
      name,
      body,
      options,
      logicalNameByCompiled,
    );
    if (managedHosts.length > 0) {
      body = {
        ...body,
        extra_hosts: mergeExtraHosts(body.extra_hosts, managedHosts),
      };
    }
    next[name] = body;
  }
  return next;
}

function expandDependsOnNames(
  name: string,
  expansion: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const clones = expansion.get(name);
  if (!clones || clones.length === 0) return [name];
  return clones;
}

function rewriteDependsOnList(
  dependsOn: unknown[],
  expansion: ReadonlyMap<string, readonly string[]>,
): string[] | undefined {
  const next: string[] = [];
  for (const entry of dependsOn) {
    if (typeof entry !== "string") continue;
    next.push(...expandDependsOnNames(entry, expansion));
  }
  return next.length > 0 ? next : undefined;
}

function rewriteDependsOnMap(
  dependsOn: Record<string, unknown>,
  expansion: ReadonlyMap<string, readonly string[]>,
): Record<string, unknown> | undefined {
  const kept: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(dependsOn)) {
    for (const clone of expandDependsOnNames(name, expansion)) {
      kept[clone] = spec;
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function rewriteDependsOnValue(
  dependsOn: unknown,
  expansion: ReadonlyMap<string, readonly string[]>,
): unknown {
  if (Array.isArray(dependsOn)) {
    return rewriteDependsOnList(dependsOn, expansion);
  }
  if (!isPlainObject(dependsOn)) return dependsOn;
  return rewriteDependsOnMap(dependsOn, expansion);
}

function rewriteDependsOnForExpansion(
  services: Record<string, unknown>,
  expansion: ReadonlyMap<string, readonly string[]>,
): Record<string, unknown> {
  if (expansion.size === 0) return services;
  const next: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(services)) {
    if (!isPlainObject(raw) || raw.depends_on === undefined) {
      next[name] = raw;
      continue;
    }
    const dependsOn = rewriteDependsOnValue(raw.depends_on, expansion);
    const body = { ...raw };
    if (dependsOn === undefined) delete body.depends_on;
    else body.depends_on = dependsOn;
    next[name] = body;
  }
  return next;
}

function collectNamedVolumeSources(
  mounts: unknown,
  volumes: Record<string, unknown>,
  referenced: Set<string>,
): void {
  if (!Array.isArray(mounts)) return;
  for (const mount of mounts) {
    if (typeof mount !== "string") continue;
    const source = mount.split(":")[0];
    if (source && source in volumes) referenced.add(source);
  }
}

function referencedVolumeSources(
  services: Record<string, unknown>,
  volumes: Record<string, unknown>,
): Set<string> {
  const referenced = new Set<string>();
  for (const service of Object.values(services)) {
    if (!isPlainObject(service)) continue;
    collectNamedVolumeSources(service.volumes, volumes, referenced);
  }
  return referenced;
}

function pruneUnreferencedVolumes(
  services: Record<string, unknown>,
  volumes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!volumes || Object.keys(volumes).length === 0) return undefined;
  const referenced = referencedVolumeSources(services, volumes);
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(volumes)) {
    if (referenced.has(key)) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function referencedSecretSources(
  services: Record<string, unknown>,
): Set<string> {
  const referenced = new Set<string>();
  for (const service of Object.values(services)) {
    if (!isPlainObject(service)) continue;
    collectSecretSources(service.secrets, referenced);
    if (isPlainObject(service.build)) {
      collectSecretSources(service.build.secrets, referenced);
    }
  }
  return referenced;
}

function collectSecretSources(value: unknown, referenced: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string") {
      referenced.add(item);
      continue;
    }
    if (isPlainObject(item) && typeof item.source === "string") {
      referenced.add(item.source);
    }
  }
}

function pruneUnreferencedSecrets(
  services: Record<string, unknown>,
  secrets: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!secrets || Object.keys(secrets).length === 0) return undefined;
  const referenced = referencedSecretSources(services);
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (referenced.has(key)) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

type CompiledLocalServices = {
  services: Record<string, unknown>;
  expansion: Map<string, string[]>;
  logicalNameByCompiled: Map<string, string>;
  addressByCompiled: Map<string, string | undefined>;
};

function identityLabelsFor(
  serviceName: string,
  environmentId: string | undefined,
): Record<string, string> {
  const labels: Record<string, string> = {
    "com.turbopanel.service": serviceName,
  };
  if (environmentId) {
    labels["com.turbopanel.environment"] = environmentId;
  }
  return labels;
}

function emitExpandedSpanningReplicas(
  compiled: CompiledLocalServices,
  params: {
    name: string;
    body: Record<string, unknown>;
    replicas: number;
    identityLabels: Record<string, string>;
    slots: ReadonlyMap<number, string> | undefined;
  },
): void {
  const clones: string[] = [];
  for (const slot of localSlotsForService(params.replicas, params.slots)) {
    const cloneName = spanningReplicaCloneName(params.name, slot);
    compiled.services[cloneName] = applyIdentityLabels(
      structuredClone(params.body),
      params.identityLabels,
    );
    compiled.logicalNameByCompiled.set(cloneName, params.name);
    compiled.addressByCompiled.set(cloneName, params.slots?.get(slot));
    clones.push(cloneName);
  }
  compiled.expansion.set(params.name, clones);
}

function emptyCompiledLocalServices(): CompiledLocalServices {
  return {
    services: {},
    expansion: new Map(),
    logicalNameByCompiled: new Map(),
    addressByCompiled: new Map(),
  };
}

function emitIdentityCompiledService(
  compiled: CompiledLocalServices,
  name: string,
  body: unknown,
  address?: string,
): void {
  compiled.services[name] = body;
  compiled.expansion.set(name, [name]);
  compiled.logicalNameByCompiled.set(name, name);
  if (address !== undefined) compiled.addressByCompiled.set(name, address);
}

function stripLocalDependsOn(
  body: Record<string, unknown>,
  localNames: ReadonlySet<string> | undefined,
): Record<string, unknown> {
  if (!localNames) return body;
  const dependsOn = filterDependsOn(body.depends_on, localNames);
  if (dependsOn === undefined) delete body.depends_on;
  else body.depends_on = dependsOn;
  return body;
}

function compileOneLocalService(
  compiled: CompiledLocalServices,
  params: {
    name: string;
    raw: unknown;
    options: CompileRuntimeOptions;
    localNames: ReadonlySet<string> | undefined;
    spanning: ReadonlyMap<string, string> | undefined;
  },
): void {
  const { name, raw, options, localNames, spanning } = params;
  if (localNames && !localNames.has(name)) return;
  if (!isPlainObject(raw)) {
    emitIdentityCompiledService(compiled, name, raw);
    return;
  }

  const body = stripLocalDependsOn(
    stripSchedulerDeploy(structuredClone(raw)),
    localNames,
  );
  const replicas = options.localReplicaCounts?.get(name) ?? 1;
  if (replicas < 1) return;
  const identityLabels = identityLabelsFor(name, options.environmentId);
  if (shouldExpandSpanningReplicas(replicas, body, spanning)) {
    emitExpandedSpanningReplicas(compiled, {
      name,
      body,
      replicas,
      identityLabels,
      slots: options.taskAddressesByService?.get(name),
    });
    return;
  }

  emitIdentityCompiledService(
    compiled,
    name,
    applyLocalScale(body, replicas, identityLabels),
    localTaskAddress(options.taskAddressesByService, name),
  );
}

function remappedExpansion(
  expansion: ReadonlyMap<string, readonly string[]>,
): Map<string, readonly string[]> {
  return new Map(
    [...expansion.entries()].filter((entry) =>
      entry[1].length !== 1 || entry[1][0] !== entry[0]
    ),
  );
}

function compileLocalServices(
  document: ComposeDocument,
  options: CompileRuntimeOptions,
): CompiledLocalServices {
  const compiled = emptyCompiledLocalServices();
  const localNames = options.localServiceNames;
  const spanning = options.spanningNetworks;
  for (const [name, raw] of Object.entries(servicesMapping(document))) {
    compileOneLocalService(compiled, {
      name,
      raw,
      options,
      localNames,
      spanning,
    });
  }
  compiled.services = rewriteDependsOnForExpansion(
    compiled.services,
    remappedExpansion(compiled.expansion),
  );
  return compiled;
}

function assignPrunedNetworks(
  data: Record<string, unknown>,
  compiledServices: Record<string, unknown>,
  sourceNetworks: Record<string, unknown>,
  spanning: ReadonlyMap<string, string> | undefined,
): void {
  if (spanning && spanning.size > 0) {
    const pruned = pruneUnreferencedComposeNetworks(
      compiledServices,
      rewriteSpanningNetworks(sourceNetworks, spanning),
    );
    if (pruned) data.networks = pruned;
    else delete data.networks;
    return;
  }
  if (Object.keys(sourceNetworks).length === 0) return;
  const pruned = pruneUnreferencedComposeNetworks(
    compiledServices,
    sourceNetworks,
  );
  if (pruned) data.networks = pruned;
  else delete data.networks;
}

function assignPrunedMapping(
  data: Record<string, unknown>,
  key: "volumes" | "secrets",
  source: unknown,
  prune: (
    services: Record<string, unknown>,
    mapping: Record<string, unknown>,
  ) => Record<string, unknown> | undefined,
  compiledServices: Record<string, unknown>,
): void {
  if (!isPlainObject(source)) return;
  const pruned = prune(compiledServices, source);
  if (pruned) data[key] = pruned;
  else delete data[key];
}

function compiledServicesForSpanning(
  compiled: CompiledLocalServices,
  options: CompileRuntimeOptions,
): Record<string, unknown> {
  const spanning = options.spanningNetworks;
  const hasManagedHosts = (options.managedIngressHostsByService?.size ?? 0) > 0;
  if (spanning && spanning.size > 0) {
    return attachSpanningServiceNetworking(
      attachDefaultNetworkIfNeeded(compiled.services, spanning),
      options,
      compiled.logicalNameByCompiled,
      compiled.addressByCompiled,
    );
  }
  if (!hasManagedHosts) return compiled.services;
  return attachSpanningServiceNetworking(
    compiled.services,
    options,
    compiled.logicalNameByCompiled,
    compiled.addressByCompiled,
  );
}

function buildCompiledDocumentData(
  document: ComposeDocument,
  compiledServices: Record<string, unknown>,
  spanning: ReadonlyMap<string, string> | undefined,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    ...document.data,
    services: compiledServices,
  };
  const sourceNetworks = isPlainObject(document.data.networks)
    ? { ...document.data.networks }
    : {};
  assignPrunedNetworks(data, compiledServices, sourceNetworks, spanning);
  assignPrunedMapping(
    data,
    "volumes",
    document.data.volumes,
    pruneUnreferencedVolumes,
    compiledServices,
  );
  assignPrunedMapping(
    data,
    "secrets",
    document.data.secrets,
    pruneUnreferencedSecrets,
    compiledServices,
  );
  return data;
}

/**
 * Produce the per-server runtime document plus the logical→runtime service
 * expansion used by hosting fan-out. Phase 1 callers omit local filters so
 * the full effective document is compiled with scheduler keys stripped.
 */
export function compileRuntimeCompose(
  document: ComposeDocument,
  options?: CompileRuntimeOptions,
): CompileRuntimeResult {
  const resolved = options ?? {};
  const compiled = compileLocalServices(document, resolved);
  const compiledServices = compiledServicesForSpanning(compiled, resolved);
  const data = buildCompiledDocumentData(
    document,
    compiledServices,
    resolved.spanningNetworks,
  );
  if (
    Object.keys(compiledServices).length === 0 && !data.networks &&
    !data.volumes
  ) {
    return { document: emptyComposeDocument(), expansion: compiled.expansion };
  }
  let compiledDocument: ComposeDocument = {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  };
  if (resolved.placementServerId) {
    compiledDocument = applyComposePlacement(
      compiledDocument,
      resolved.placementServerId,
    );
  }
  return { document: compiledDocument, expansion: compiled.expansion };
}

/**
 * Produce the per-server runtime document. Phase 1 callers omit local filters
 * so the full effective document is compiled with scheduler keys stripped.
 */
export function compileRuntimeComposeDocument(
  document: ComposeDocument,
  options?: CompileRuntimeOptions,
): ComposeDocument {
  return compileRuntimeCompose(document, options).document;
}
