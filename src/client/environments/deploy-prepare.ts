import type { Context } from "hono";
import { and, eq, inArray, or } from "drizzle-orm";
import type { AppEnv } from "../../app.ts";
import {
  decryptSecret,
  encryptSecretForDaemon,
  ENVELOPE_MAGIC,
  isDaemonSealedEnvelope,
  isSealedEnvelope,
  resealSecretForDaemon,
} from "../authn/data-encryption.ts";
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from "../../daemon/authn/server-identity-db.ts";
import {
  applyServiceOptionsToComposeDocument,
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
  type ServiceDeployHook,
  type ServiceOptionsByComposeName,
} from "../../lib/compose/apply-service-options.ts";
import {
  compileRuntimeCompose,
  type CompileRuntimeOptions,
} from "../../lib/compose/compile-runtime.ts";
import { sha256HexUtf8 } from "../../lib/compose/desired-hash.ts";
import {
  type ApplyVariablesError,
  applyVariablesToComposeDocument,
  type DeployVariableEntry,
  type DeployVariableMaterial,
  isApplyVariablesError,
  type VariableScopeEntryMap,
} from "../../lib/compose/apply-variables.ts";
import type { DeploySecretPlanEntry } from "../../lib/compose/secret-files.ts";
import {
  assertComposeDocument,
  type ComposeDocument,
  composeDocumentToRuntimeYaml,
  type ComposeLayer,
  emptyContainerComposeYaml,
  isTraditionalWebComposeService,
  mergeComposeLayers,
  splitTraditionalWebServices,
  type TraditionalWebSiteSpec,
} from "../../lib/compose/index.ts";
import {
  environmentComposeFilename,
  PROJECT_COMPOSE_FILENAME,
  renderRuntimeComposeFiles,
} from "./deploy-layers.ts";
import {
  buildPlatformDeployVariables,
  stripReservedDeployVariableKeys,
} from "../../lib/compose/platform-variables.ts";
import { renameComposeVolumes } from "../../lib/compose/rename-volumes.ts";
import {
  collectComposeExternalDockerNetworkNames,
  pruneUnreferencedComposeNetworks,
} from "../../lib/compose/docker-external-networks.ts";
import {
  principalHomeDir,
  principalVolumePath,
  resolveDockerVolumeName,
} from "../../lib/naming.ts";
import {
  parsePrincipalOptions,
  resolvePrincipalIdOverride,
  resolvePrincipalShell,
} from "../../lib/principal-options.ts";
import {
  parseProjectOptions,
  resolveContainerNaming,
} from "../../lib/project-options.ts";
import {
  parseServiceOptions,
  resolveServiceInstances,
} from "../../lib/service-options.ts";
import { validateRegisteredExternalDockerNetworks } from "./validate-docker-external-networks.ts";
import type { DesiredTaskInput } from "../../lib/db/task-records.ts";
import {
  localReplicaCounts,
  localServiceNames,
} from "../../lib/schedule/planner.ts";
import type { SpanningHostsForService } from "../../lib/schedule/task-addresses.ts";
import {
  allocateEnvironmentContainers,
  buildContainerServiceSpecs,
  type ContainerAllocation,
  type ContainerServiceSpec,
  ensureServiceIngressContainerAllocation,
  readComposeContainerNames,
} from "./allocate-containers.ts";
import { resolveTcpUdpIngressServices } from "./tcp-udp-ingress.ts";
import {
  registerComposeVolumes,
  type RegisteredComposeVolume,
} from "./register-compose-volumes.ts";
import { registerComposeMounts } from "./register-compose-mounts.ts";
import type {
  EnvironmentDeployComposeFile,
  EnvironmentDeployFabricNetwork,
  EnvironmentDeployHosting,
  EnvironmentDeployIngressService,
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeployStorageMount,
  EnvironmentDeployTraditionalWebPrincipal,
  EnvironmentDeployTraditionalWebSite,
  EnvironmentDeployVariableMaterial,
} from "../../lib/commands/schemas.ts";
import {
  binding,
  environment,
  ip,
  location,
  mount,
  organization,
  principal,
  project,
  server,
  service,
  storage,
} from "../../lib/db/schema.ts";
import {
  checkResourceLimits,
  parseResourceLimits,
  sumServiceResourceUsage,
} from "../../lib/resource-limits.ts";
import {
  parseHostingOptions,
  resolveHostingBind,
  resolveHostingProxy,
} from "../../lib/hosting-options.ts";
import { inetAddressToString } from "../../lib/ip-address.ts";
import { loadServerDatacenterAddress } from "../../lib/net/private-endpoint.ts";
import { reconcileServicesFromCompose } from "./reconcile-services.ts";
import type { Db } from "../../db.ts";
import {
  mergeHostingVariablesForService,
  type ResolvedVariableMap,
  type ResolvedVariableScopes,
  resolveInheritedVariableBundleForService,
  resolveInheritedVariablesForEnvironment,
  resolveServerScopedVariables,
} from "../variables/resolve-inherited.ts";
import {
  loadPrincipalIdsByServiceIdForEnvironment,
  loadStewardPrincipalIdsForEnvironment,
  pickSolePrincipalId,
} from "../principals/stewards.ts";
import {
  materializeBindingsForServices,
  reapplyBindingOwnedVariables,
} from "../bindings/materialize.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `serverId` belongs to `organizationId`. */
export async function verifyServerInOrg(
  db: Db,
  serverId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: server.id })
    .from(server)
    .where(
      and(eq(server.id, serverId), eq(server.organizationId, organizationId)),
    )
    .limit(1);
  return Boolean(row);
}

function extractComposeFromOptions(options: unknown): unknown {
  if (!isPlainObject(options)) return null;
  return options.compose ?? null;
}

export type DeployPrepareWarningCode =
  | "empty_compose"
  | "resource_limit_exceeded"
  | "health_check_missing"
  | "docker_external_network_unregistered"
  | "traditional_web_principal_ambiguous"
  | "binding_endpoint_unavailable";

export type DeployPrepareWarning = {
  code: DeployPrepareWarningCode;
  message: string;
  details?: Record<string, unknown>;
};

export type PreparedDeployCompose = {
  /**
   * Compiled runtime YAML (internal prepare output for hashing/preview).
   * Wire payloads use required `composeFiles` with `role: 'runtime'`.
   */
  composeYaml: string;
  /**
   * Required runtime snapshot: exactly one `role: 'runtime'` `compose.yaml`.
   */
  composeFiles: EnvironmentDeployComposeFile[];
  /** SHA-256 hex of `composeYaml` (compiled runtime, before daemon overlay). */
  desiredHash: string;
  /** Local replica counts keyed by logical compose service name. */
  replicaCounts: Record<string, number>;
  hooks: ServiceDeployHook[];
  variableMaterial: EnvironmentDeployVariableMaterial[];
  storageMaterial: EnvironmentDeployStorageMaterial[];
  principalMaterial: EnvironmentDeployPrincipalMaterial[];
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[];
  /** External Docker network names declared in compose — must be registered on the server. */
  dockerExternalNetworks: string[];
  /**
   * Routed fabric bridges this server must self-ensure before compose up
   * (`tpn_*` spanning networks). Disjoint from `dockerExternalNetworks` —
   * never operator-registered.
   */
  fabricNetworks: EnvironmentDeployFabricNetwork[];
  /**
   * Compose service names that must join the daemon's shared managed-ingress
   * network so their managed-database binding endpoint (a ProxySQL container
   * name) resolves. Disjoint from `dockerExternalNetworks` — this is a
   * platform network, never operator-registered.
   */
  managedNetworkServices: string[];
  /** Pre-allocated container rows for this deploy (uuid / explicit-name paths). */
  containers: ContainerAllocation[];
  /**
   * Per-service tcp/udp Traefik ingress allocations (`<service.id>-in`).
   * Empty when no service publishes raw ports.
   */
  ingressServices: EnvironmentDeployIngressService[];
  /** Original compose service key → clone keys after multi-instance expansion. */
  composeServiceExpansion: Record<string, string[]>;
  /** Auto-registered compose named volumes (storage rows + resolved Docker names). */
  volumes: RegisteredComposeVolume[];
  /** Soft prepare issues (preview mode); empty for deploy. */
  warnings: DeployPrepareWarning[];
  /** Non-secret Compose project `.env` next to compose.yaml. */
  envFile?: string;
  /** File-only secret mounts (no plaintext). */
  secretPlan?: DeploySecretPlanEntry[];
};

export type DeployPrepareError =
  | { kind: "health_check"; required: boolean; services: string[] }
  | {
    kind: "resource_limit";
    violations: ReturnType<typeof checkResourceLimits>;
  }
  | { kind: "empty_compose" }
  | { kind: "datacenter_ip_required"; serverId: string }
  | { kind: "docker_external_network_unregistered"; names: string[] }
  | { kind: "traditional_web_principal_ambiguous"; composeServiceName: string }
  | { kind: "binding_endpoint_unavailable" }
  | {
    kind: "variable_unresolved";
    message: string;
    ref?: string;
    composeServiceName?: string;
    envKey?: string;
  }
  | {
    kind: "variable_ref_invalid";
    message: string;
    composeServiceName?: string;
    envKey?: string;
  }
  | {
    kind: "variable_secret_interpolation";
    message: string;
    composeServiceName?: string;
    envKey?: string;
  }
  | {
    kind: "storage_location_unavailable";
    storageId: string;
    storageName: string;
    accessMode: string;
    primaryServerId: string | null;
    scheduledServerId: string;
    serviceId: string;
  };

export type DeployPrepareMode = "deploy" | "preview";

/** Per-server slice of a scheduled environment deploy. */
export type DeployScheduleSlice = {
  serverId: string;
  tasks: readonly DesiredTaskInput[];
  serviceIdToName: ReadonlyMap<string, string>;
  spanningNetworks?: ReadonlyMap<string, string>;
  taskAddresses?: ReadonlyMap<string, ReadonlyMap<number, string>>;
  spanningHosts?: ReadonlyMap<string, SpanningHostsForService>;
  fabricNetworks?: readonly EnvironmentDeployFabricNetwork[];
  /** Per-service ProxySQL listener extra_hosts for non-co-resident consumers. */
  managedIngressHostsByService?: ReadonlyMap<
    string,
    ReadonlyArray<{ name: string; address: string }>
  >;
};

async function emptyPreparedCompose(
  warnings: DeployPrepareWarning[],
): Promise<PreparedDeployCompose> {
  const emptyYaml = emptyContainerComposeYaml();
  return {
    composeYaml: emptyYaml,
    composeFiles: renderRuntimeComposeFiles(emptyYaml),
    desiredHash: await sha256HexUtf8(emptyYaml),
    replicaCounts: {},
    hooks: [],
    variableMaterial: [],
    storageMaterial: [],
    principalMaterial: [],
    traditionalWebSites: [],
    dockerExternalNetworks: [],
    fabricNetworks: [],
    managedNetworkServices: [],
    containers: [],
    ingressServices: [],
    composeServiceExpansion: {},
    volumes: [],
    warnings,
  };
}

type HardDeployPrepareError =
  | { kind: "datacenter_ip_required"; serverId: string }
  | {
    kind: "variable_unresolved";
    message: string;
    ref?: string;
    composeServiceName?: string;
    envKey?: string;
  }
  | {
    kind: "variable_ref_invalid";
    message: string;
    composeServiceName?: string;
    envKey?: string;
  }
  | {
    kind: "variable_secret_interpolation";
    message: string;
    composeServiceName?: string;
    envKey?: string;
  }
  | {
    kind: "storage_location_unavailable";
    storageId: string;
    storageName: string;
    accessMode: string;
    primaryServerId: string | null;
    scheduledServerId: string;
    serviceId: string;
  };

function warningFromPrepareError(
  error: Exclude<DeployPrepareError, HardDeployPrepareError>,
): DeployPrepareWarning {
  switch (error.kind) {
    case "empty_compose":
      return {
        code: "empty_compose",
        message: "Compose has no services to deploy.",
      };
    case "resource_limit":
      return {
        code: "resource_limit_exceeded",
        message: "Requested resources exceed organization or server limits.",
        details: { violations: error.violations },
      };
    case "health_check":
      return {
        code: "health_check_missing",
        message: error.required
          ? "One or more services require a health check before deploy."
          : "One or more services are missing a health check (warn policy).",
        details: {
          required: error.required,
          services: error.services,
        },
      };
    case "docker_external_network_unregistered":
      return {
        code: "docker_external_network_unregistered",
        message:
          "Compose references external Docker network(s) that are not registered for this server.",
        details: { names: error.names },
      };
    case "traditional_web_principal_ambiguous":
      return {
        code: "traditional_web_principal_ambiguous",
        message:
          `Traditional-web service "${error.composeServiceName}" has more than one project principal assigned.`,
        details: { composeServiceName: error.composeServiceName },
      };
    case "binding_endpoint_unavailable":
      return {
        code: "binding_endpoint_unavailable",
        message:
          "A service binding could not resolve a ProxySQL listener for its managed cluster.",
      };
  }
}

async function sealVariableMaterialForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  material: DeployVariableMaterial[],
): Promise<EnvironmentDeployVariableMaterial[] | Response> {
  if (material.length === 0) return [];

  const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
  const secretsConfig = c.get("secretsConfig");
  if (!dataEncryptionSecrets || !secretsConfig) {
    return Response.json({
      error: "Encryption unavailable — no encryption key configured",
    }, { status: 503 });
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId);
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return Response.json({
      error: "No encryption-capable daemon key on target server",
    }, { status: 422 });
  }
  const keyId = daemonState.key.id;

  const sealed: EnvironmentDeployVariableMaterial[] = [];
  const recipient = { serverId, keyId };
  for (const entry of material) {
    let envelope = entry.valueEnvelope;
    if (!isDaemonSealedEnvelope(envelope)) {
      if (isSealedEnvelope(envelope)) {
        envelope = await resealSecretForDaemon(
          secretsConfig,
          dataEncryptionSecrets,
          recipient,
          envelope,
        );
      } else {
        envelope = await encryptSecretForDaemon(
          secretsConfig,
          recipient,
          envelope,
        );
      }
    }
    sealed.push({
      key: entry.key,
      composeServiceName: entry.composeServiceName,
      forBuild: entry.forBuild,
      forRuntime: entry.forRuntime,
      isLiteral: entry.isLiteral,
      valueEnvelope: envelope,
    });
  }
  return sealed;
}

function readPinnedDockerVolumeName(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) return null;
  if (typeof metadata.dockerVolumeName !== "string") return null;
  return metadata.dockerVolumeName.length > 0
    ? metadata.dockerVolumeName
    : null;
}

function readLocationFlags(options: unknown): {
  managed?: boolean;
  externalName?: string;
} {
  if (!isPlainObject(options)) return {};
  const flags: { managed?: boolean; externalName?: string } = {};
  if (options.managed === true || options.managed === false) {
    flags.managed = options.managed;
  }
  if (
    typeof options.externalName === "string" && options.externalName.length > 0
  ) {
    flags.externalName = options.externalName;
  }
  return flags;
}

function locationUsableOnServer(
  locationServerId: string | null,
  serverId: string,
): boolean {
  return locationServerId === null || locationServerId === serverId;
}

type LocationJoinRow = {
  storageId: string;
  locationId: string;
  kind: string;
  name: string;
  accessMode: string;
  principalId: string | null;
  principalUsername: string | null;
  contentEnvelope: string | null;
  locationServerId: string | null;
  provider: string;
  role: string;
  path: string | null;
  locationOptions: unknown;
  metadata: unknown;
};

type MountJoinRow = {
  storageId: string;
  serviceId: string;
  composeServiceName: string;
  destinationPath: string;
  subpath: string | null;
  readOnly: boolean;
};

function isDeployStorageKind(
  kind: string,
): kind is EnvironmentDeployStorageMaterial["kind"] {
  return kind === "volume" || kind === "directory" || kind === "file";
}

function isDeployStorageProvider(
  provider: string,
): provider is EnvironmentDeployStorageMaterial["provider"] {
  return provider === "docker" || provider === "path";
}

function resolvePathLocationSource(
  row: LocationJoinRow,
): string | undefined {
  if (row.provider !== "path") return undefined;
  if (typeof row.path === "string" && row.path.length > 0) return row.path;
  if (
    typeof row.principalId !== "string" ||
    row.principalId.length === 0 ||
    typeof row.principalUsername !== "string" ||
    row.principalUsername.length === 0
  ) {
    return undefined;
  }
  return principalVolumePath(row.principalUsername, row.storageId);
}

function expandMountsForClones(
  mounts: MountJoinRow[],
  cloneNamesByServiceId: Map<string, string[]>,
): EnvironmentDeployStorageMount[] {
  const expanded: EnvironmentDeployStorageMount[] = [];
  for (const row of mounts) {
    const clones = cloneNamesByServiceId.get(row.serviceId);
    const names = clones && clones.length > 0
      ? clones
      : [row.composeServiceName];
    for (const composeServiceName of names) {
      const mountEntry: EnvironmentDeployStorageMount = {
        serviceId: row.serviceId,
        composeServiceName,
        destinationPath: row.destinationPath,
      };
      if (typeof row.subpath === "string" && row.subpath.length > 0) {
        mountEntry.subpath = row.subpath;
      }
      if (row.readOnly) mountEntry.readOnly = true;
      expanded.push(mountEntry);
    }
  }
  return expanded;
}

function toStorageMaterialEntry(
  row: LocationJoinRow,
  serverId: string,
  mounts: EnvironmentDeployStorageMount[],
): EnvironmentDeployStorageMaterial | null {
  if (
    !isDeployStorageKind(row.kind) || !isDeployStorageProvider(row.provider)
  ) {
    return null;
  }
  const flags = readLocationFlags(row.locationOptions);
  const entry: EnvironmentDeployStorageMaterial = {
    storageId: row.storageId,
    locationId: row.locationId,
    kind: row.kind,
    name: row.name,
    provider: row.provider,
    serverId,
    mounts,
  };
  const sourcePath = resolvePathLocationSource(row);
  if (sourcePath) entry.sourcePath = sourcePath;
  if (row.principalId) entry.principalId = row.principalId;
  if (row.contentEnvelope) entry.contentEnvelope = row.contentEnvelope;
  if (row.provider === "docker") {
    entry.volumeName = resolveDockerVolumeName({
      storageId: row.storageId,
      pinnedName: readPinnedDockerVolumeName(row.metadata),
    });
  }
  if (flags.managed !== undefined) entry.managed = flags.managed;
  if (flags.externalName) entry.externalName = flags.externalName;
  return entry;
}

function appendUnseenRegisteredVolumes(
  material: EnvironmentDeployStorageMaterial[],
  seenStorageIds: ReadonlySet<string>,
  registeredVolumes: readonly RegisteredComposeVolume[],
  serverId: string,
): void {
  for (const registered of registeredVolumes) {
    if (seenStorageIds.has(registered.storageId)) continue;
    material.push({
      storageId: registered.storageId,
      locationId: registered.locationId,
      kind: "volume",
      name: registered.composeKey,
      provider: "docker",
      serverId,
      volumeName: registered.volumeName,
      managed: registered.managed,
      mounts: [],
    });
  }
}

export async function loadStorageMaterial(
  db: Db,
  params: {
    environmentId: string;
    projectId: string;
    organizationId: string;
    serverId: string;
    serviceIds: string[];
    /** Origin service id → clone compose keys (for service-scoped fan-out). */
    cloneNamesByServiceId: Map<string, string[]>;
    registeredVolumes: readonly RegisteredComposeVolume[];
  },
): Promise<EnvironmentDeployStorageMaterial[]> {
  const scopeConditions = [
    eq(storage.environmentId, params.environmentId),
    eq(storage.projectId, params.projectId),
  ];
  if (params.serviceIds.length > 0) {
    scopeConditions.push(inArray(storage.serviceId, params.serviceIds));
  }

  const locationRows = await db
    .select({
      storageId: storage.id,
      locationId: location.id,
      kind: storage.kind,
      name: storage.name,
      accessMode: storage.accessMode,
      principalId: storage.principalId,
      principalUsername: principal.username,
      contentEnvelope: storage.contentEnvelope,
      locationServerId: location.serverId,
      provider: location.provider,
      role: location.role,
      path: location.path,
      locationOptions: location.options,
      metadata: storage.metadata,
    })
    .from(storage)
    .innerJoin(location, eq(location.storageId, storage.id))
    .leftJoin(principal, eq(storage.principalId, principal.id))
    .where(or(...scopeConditions));

  const usable = locationRows.filter((row) =>
    row.role !== "scratch" &&
    locationUsableOnServer(row.locationServerId, params.serverId)
  );
  const usableStorageIds = [...new Set(usable.map((row) => row.storageId))];

  const mountRows: MountJoinRow[] = usableStorageIds.length === 0
    ? []
    : await db
      .select({
        storageId: mount.storageId,
        serviceId: mount.serviceId,
        composeServiceName: service.composeServiceName,
        destinationPath: mount.destinationPath,
        subpath: mount.subpath,
        readOnly: mount.isReadOnly,
      })
      .from(mount)
      .innerJoin(service, eq(mount.serviceId, service.id))
      .where(inArray(mount.storageId, usableStorageIds));

  const mountsByStorage = new Map<string, MountJoinRow[]>();
  for (const row of mountRows) {
    const list = mountsByStorage.get(row.storageId) ?? [];
    list.push(row);
    mountsByStorage.set(row.storageId, list);
  }

  const material: EnvironmentDeployStorageMaterial[] = [];
  const seenStorageIds = new Set<string>();

  for (const row of usable) {
    seenStorageIds.add(row.storageId);
    const mounts = expandMountsForClones(
      mountsByStorage.get(row.storageId) ?? [],
      params.cloneNamesByServiceId,
    );
    const entry = toStorageMaterialEntry(row, params.serverId, mounts);
    if (entry) material.push(entry);
  }

  appendUnseenRegisteredVolumes(
    material,
    seenStorageIds,
    params.registeredVolumes,
    params.serverId,
  );
  return material;
}

export async function findUnavailableStorageLocation(
  db: Db,
  params: {
    environmentId: string;
    scheduledServerId: string;
    serviceIds: string[];
  },
): Promise<
  Extract<DeployPrepareError, { kind: "storage_location_unavailable" }> | null
> {
  if (params.serviceIds.length === 0) return null;

  const rows = await db
    .select({
      storageId: storage.id,
      storageName: storage.name,
      accessMode: storage.accessMode,
      serviceId: mount.serviceId,
      locationServerId: location.serverId,
      locationRole: location.role,
    })
    .from(mount)
    .innerJoin(storage, eq(mount.storageId, storage.id))
    .leftJoin(location, eq(location.storageId, storage.id))
    .where(
      and(
        eq(storage.environmentId, params.environmentId),
        inArray(mount.serviceId, params.serviceIds),
      ),
    );

  type Acc = {
    storageName: string;
    accessMode: string;
    serviceId: string;
    primaryServerId: string | null;
    usable: boolean;
  };
  const byStorage = new Map<string, Acc>();
  for (const row of rows) {
    let acc = byStorage.get(row.storageId);
    if (!acc) {
      acc = {
        storageName: row.storageName,
        accessMode: row.accessMode,
        serviceId: row.serviceId,
        primaryServerId: null,
        usable: false,
      };
      byStorage.set(row.storageId, acc);
    }
    if (row.locationRole === "primary" && row.locationServerId) {
      acc.primaryServerId = row.locationServerId;
    }
    if (
      row.locationRole !== "scratch" &&
      locationUsableOnServer(row.locationServerId, params.scheduledServerId)
    ) {
      acc.usable = true;
    }
  }

  for (const [storageId, acc] of byStorage) {
    if (acc.usable) continue;
    return {
      kind: "storage_location_unavailable",
      storageId,
      storageName: acc.storageName,
      accessMode: acc.accessMode,
      primaryServerId: acc.primaryServerId,
      scheduledServerId: params.scheduledServerId,
      serviceId: acc.serviceId,
    };
  }
  return null;
}

function serviceIdsOnScheduledServer(
  schedule: DeployScheduleSlice | undefined,
  serverId: string,
  allServiceIds: string[],
): string[] {
  if (!schedule) return allServiceIds;
  const ids: string[] = [];
  for (const task of schedule.tasks) {
    if (task.serverId === serverId) ids.push(task.serviceId);
  }
  return ids;
}

async function sealStorageMaterialForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  material: EnvironmentDeployStorageMaterial[],
): Promise<EnvironmentDeployStorageMaterial[] | Response> {
  if (material.length === 0) return [];

  const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
  const secretsConfig = c.get("secretsConfig");
  const needsReseal = material.some((entry) =>
    entry.contentEnvelope?.startsWith(`${ENVELOPE_MAGIC}.`)
  );
  if (!needsReseal) return material;

  if (!dataEncryptionSecrets || !secretsConfig) {
    return Response.json({
      error: "Encryption unavailable — no encryption key configured",
    }, { status: 503 });
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId);
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return Response.json({
      error: "No encryption-capable daemon key on target server",
    }, { status: 422 });
  }
  const keyId = daemonState.key.id;

  const sealed: EnvironmentDeployStorageMaterial[] = [];
  for (const entry of material) {
    let contentEnvelope = entry.contentEnvelope;
    if (contentEnvelope?.startsWith(`${ENVELOPE_MAGIC}.`)) {
      contentEnvelope = await resealSecretForDaemon(
        secretsConfig,
        dataEncryptionSecrets,
        { serverId, keyId },
        contentEnvelope,
      );
    }
    sealed.push({
      ...entry,
      ...(contentEnvelope ? { contentEnvelope } : {}),
    });
  }
  return sealed;
}

export async function loadPrincipalMaterial(
  db: Db,
  principalIds: string[],
): Promise<EnvironmentDeployPrincipalMaterial[]> {
  if (principalIds.length === 0) return [];

  const uniqueIds = [...new Set(principalIds)];
  const rows = await db
    .select({
      id: principal.id,
      username: principal.username,
      options: principal.options,
    })
    .from(principal)
    .where(inArray(principal.id, uniqueIds));

  const material: EnvironmentDeployPrincipalMaterial[] = [];
  for (const row of rows) {
    const options = parsePrincipalOptions(row.options);
    const override = resolvePrincipalIdOverride(options);
    // naming.ts is the single source of truth for home; metadata.home is a
    // mirror for display only.
    material.push({
      principalId: row.id,
      username: row.username,
      home: principalHomeDir(row.username),
      shell: resolvePrincipalShell(options),
      ...(override ? { uid: override.uid, gid: override.gid } : {}),
    });
  }
  return material;
}

/**
 * Resolve the two raw project/environment compose layers (no prepare
 * transforms). `environmentFilename` is the overlay's wire basename.
 */
export function resolveProjectEnvironmentComposeLayers(
  projectOptions: unknown,
  environmentOptions: unknown,
  environmentFilename: string,
): ComposeLayer[] | Response {
  try {
    const baseCompose = assertComposeDocument(
      extractComposeFromOptions(projectOptions),
    );
    const overlayCompose = assertComposeDocument(
      extractComposeFromOptions(environmentOptions),
    );
    return [
      {
        role: "project",
        filename: PROJECT_COMPOSE_FILENAME,
        document: baseCompose,
      },
      {
        role: "environment",
        filename: environmentFilename,
        document: overlayCompose,
      },
    ];
  } catch {
    return Response.json({ error: "Invalid compose document" }, {
      status: 400,
    });
  }
}

export function mergeProjectEnvironmentCompose(
  projectOptions: unknown,
  environmentOptions: unknown,
): ComposeDocument | Response {
  // Filename is unused by mergeComposeLayers (document fold only); use a
  // placeholder that cannot collide with the project basename.
  const layers = resolveProjectEnvironmentComposeLayers(
    projectOptions,
    environmentOptions,
    "docker-compose.environment.yml",
  );
  if (layers instanceof Response) return layers;
  return mergeComposeLayers(layers);
}

function evaluateHealthCheckGates(
  merged: ComposeDocument,
  optionsByComposeName: ReturnType<typeof buildServiceOptionsMap>,
  acknowledgeHealthCheckWarnings: boolean | undefined,
): Extract<DeployPrepareError, { kind: "health_check" }> | null {
  const healthWarnings = collectHealthCheckWarnings(
    merged,
    optionsByComposeName,
  );
  const requiredMissing = healthWarnings.filter((w) => w.policy === "required");
  if (requiredMissing.length > 0) {
    return {
      kind: "health_check",
      required: true,
      services: requiredMissing.map((w) => w.composeServiceName),
    };
  }
  const warnMissing = healthWarnings.filter((w) => w.policy === "warn");
  if (warnMissing.length > 0 && !acknowledgeHealthCheckWarnings) {
    return {
      kind: "health_check",
      required: false,
      services: warnMissing.map((w) => w.composeServiceName),
    };
  }
  return null;
}

async function mapResolvedVariablesToDeployEntries(
  map: ResolvedVariableMap,
  dataEncryptionSecrets: Parameters<typeof decryptSecret>[0] | undefined,
): Promise<DeployVariableEntry[]> {
  const entries: DeployVariableEntry[] = [];
  for (const [key, entry] of map) {
    let value = entry.value;
    if (entry.isSecret && dataEncryptionSecrets) {
      value = await decryptSecret(dataEncryptionSecrets, entry.value);
    }
    entries.push({
      key,
      value,
      isSecret: entry.isSecret,
      isLiteral: entry.isLiteral,
      forBuild: entry.forBuild,
      forRuntime: entry.forRuntime,
      ...(entry.bindingId ? { bindingId: entry.bindingId } : {}),
    });
  }
  return entries;
}

type ServiceRow = {
  id: string;
  composeServiceName: string;
  options: unknown;
};

async function resolveDeployVariableBuckets(
  db: Db,
  params: {
    environmentId: string;
    serverId: string;
    composeServiceNames: readonly string[];
    /** Clone compose key → origin service row (same row for every clone). */
    serviceRowByComposeName: Map<string, ServiceRow>;
    dataEncryptionSecrets: Parameters<
      typeof mapResolvedVariablesToDeployEntries
    >[1];
  },
): Promise<{
  globalEntries: DeployVariableEntry[];
  perServiceEntries: Map<string, DeployVariableEntry[]>;
  perServiceScopes: Map<string, VariableScopeEntryMap>;
}> {
  const envVars = await resolveInheritedVariablesForEnvironment(
    db,
    params.environmentId,
  );
  const serverVars = await resolveServerScopedVariables(db, params.serverId);
  const fallbackGlobal = new Map([...envVars, ...serverVars]);
  const fallbackEntries = await mapResolvedVariablesToDeployEntries(
    fallbackGlobal,
    params.dataEncryptionSecrets,
  );
  const serverScopeEntries = await mapResolvedVariablesToDeployEntries(
    serverVars,
    params.dataEncryptionSecrets,
  );
  const serverScopeMap = new Map(
    serverScopeEntries.map((entry) => [entry.key, entry]),
  );

  const composeServices = params.composeServiceNames;
  const globalEntries: DeployVariableEntry[] = composeServices.length === 0
    ? fallbackEntries
    : [];
  const perServiceEntries = new Map<string, DeployVariableEntry[]>();
  const perServiceScopes = new Map<string, VariableScopeEntryMap>();

  if (composeServices.length === 0) {
    return { globalEntries, perServiceEntries, perServiceScopes };
  }
  if (params.serviceRowByComposeName.size === 0) {
    globalEntries.push(...fallbackEntries);
    return { globalEntries, perServiceEntries, perServiceScopes };
  }

  const userEntriesByServiceId = new Map<string, DeployVariableEntry[]>();
  const scopesByServiceId = new Map<string, VariableScopeEntryMap>();

  for (const composeServiceName of composeServices) {
    const row = params.serviceRowByComposeName.get(composeServiceName);
    let userEntries: DeployVariableEntry[];
    let scopes: VariableScopeEntryMap;
    if (row) {
      let cached = userEntriesByServiceId.get(row.id);
      let cachedScopes = scopesByServiceId.get(row.id);
      if (!cached || !cachedScopes) {
        const bundle = await resolveInheritedVariableBundleForService(
          db,
          row.id,
        );
        const hostingMap = await mergeHostingVariablesForService(
          db,
          row.id,
          bundle.inherited,
        );
        await reapplyBindingOwnedVariables(db, row.id, bundle.inherited);
        const mergedServer = new Map([...bundle.inherited, ...serverVars]);
        cached = await mapResolvedVariablesToDeployEntries(
          mergedServer,
          params.dataEncryptionSecrets,
        );
        const scopeMaps: ResolvedVariableScopes = {
          ...bundle.scopes,
          hosting: hostingMap,
          server: serverVars,
        };
        cachedScopes = await mapResolvedScopesToDeployEntries(
          scopeMaps,
          params.dataEncryptionSecrets,
        );
        cachedScopes.server = serverScopeMap;
        userEntriesByServiceId.set(row.id, cached);
        scopesByServiceId.set(row.id, cachedScopes);
      }
      userEntries = cached;
      scopes = cachedScopes;
    } else {
      userEntries = fallbackEntries;
      scopes = { server: serverScopeMap };
    }
    perServiceEntries.set(composeServiceName, userEntries);
    perServiceScopes.set(composeServiceName, scopes);
  }
  return { globalEntries, perServiceEntries, perServiceScopes };
}

async function mapResolvedScopesToDeployEntries(
  scopes: ResolvedVariableScopes,
  dataEncryptionSecrets: Parameters<
    typeof mapResolvedVariablesToDeployEntries
  >[1],
): Promise<VariableScopeEntryMap> {
  const out: VariableScopeEntryMap = {};
  for (const [scope, map] of Object.entries(scopes)) {
    if (!map) continue;
    const entries = await mapResolvedVariablesToDeployEntries(
      map,
      dataEncryptionSecrets,
    );
    out[scope as keyof VariableScopeEntryMap] = new Map(
      entries.map((entry) => [entry.key, entry]),
    );
  }
  return out;
}

function listContainerComposeNames(document: ComposeDocument): Set<string> {
  const services = isPlainObject(document.data.services)
    ? (document.data.services as Record<string, unknown>)
    : {};
  const names = new Set<string>();
  for (const [name, raw] of Object.entries(services)) {
    if (isPlainObject(raw) && isTraditionalWebComposeService(raw)) continue;
    names.add(name);
  }
  return names;
}

function buildExpandedServiceOptionsMap(
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>,
): ServiceOptionsByComposeName {
  const originOptions = buildServiceOptionsMap(serviceRows);
  const map: ServiceOptionsByComposeName = new Map();

  for (const [originName, clones] of expansion) {
    const origin = originOptions.get(originName) ?? {};
    for (const cloneName of clones) {
      map.set(cloneName, { ...origin });
    }
  }
  return map;
}

/** Build clone compose name → allocated container_name map for apply-service-options. */
function buildContainerNameByComposeName(
  allocations: readonly ContainerAllocation[],
  localCounts: ReadonlyMap<string, number> | undefined,
  localServerId: string | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of allocations) {
    const count = localCounts?.get(row.composeServiceName) ?? row.instances;
    if (count > 1) continue;
    if (localServerId && row.serverId !== localServerId) continue;
    map.set(row.cloneComposeServiceName, row.containerName);
  }
  return map;
}

function appendPlatformVariablesToEntries(
  perServiceEntries: Map<string, DeployVariableEntry[]>,
  params: {
    projectId: string;
    environmentId: string;
    serviceRowByCloneName: Map<string, ServiceRow>;
    allocationByClone: Map<string, ContainerAllocation>;
  },
): Map<string, DeployVariableEntry[]> {
  const next = new Map<string, DeployVariableEntry[]>();
  for (const [cloneName, userEntries] of perServiceEntries) {
    const stripped = stripReservedDeployVariableKeys(userEntries);
    const row = params.serviceRowByCloneName.get(cloneName);
    const allocation = params.allocationByClone.get(cloneName);
    const platform = row
      ? buildPlatformDeployVariables({
        projectId: params.projectId,
        environmentId: params.environmentId,
        serviceId: row.id,
        ...(allocation
          ? {
            containerId: allocation.containerRowId,
            containerName: allocation.containerName,
          }
          : {}),
      })
      : [];
    next.set(cloneName, [...stripped, ...platform]);
  }
  return next;
}

function expansionToRecord(
  expansion: Map<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of expansion) {
    out[key] = value;
  }
  return out;
}

function buildCloneNamesByServiceId(
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of serviceRows) {
    map.set(
      row.id,
      expansion.get(row.composeServiceName) ?? [row.composeServiceName],
    );
  }
  return map;
}

/** Soft prepare errors that preview can absorb into `warnings`. */
type SoftDeployPrepareError = Exclude<
  DeployPrepareError,
  HardDeployPrepareError
>;

function absorbSoftPrepareError(
  mode: DeployPrepareMode,
  warnings: DeployPrepareWarning[],
  error: SoftDeployPrepareError | null | undefined,
): SoftDeployPrepareError | null {
  if (!error) return null;
  if (mode === "preview") {
    warnings.push(warningFromPrepareError(error));
    return null;
  }
  return error;
}

function listComposeServiceKeys(document: ComposeDocument): string[] {
  if (!isPlainObject(document.data.services)) return [];
  return Object.keys(document.data.services as Record<string, unknown>);
}

async function emptyComposePrepareResult(
  mode: DeployPrepareMode,
): Promise<PreparedDeployCompose | DeployPrepareError> {
  if (mode === "preview") {
    return await emptyPreparedCompose([
      warningFromPrepareError({ kind: "empty_compose" }),
    ]);
  }
  return { kind: "empty_compose" };
}

function buildInstancesByComposeName(
  composeServiceNames: readonly string[],
  containerServices: ReturnType<typeof buildContainerServiceSpecs>,
  serviceRows: ServiceRow[],
): Map<string, number> {
  const instancesByComposeName = new Map<string, number>();
  for (const spec of containerServices) {
    instancesByComposeName.set(spec.composeServiceName, spec.instances);
  }
  // Traditional-web keeps count 1 (expansion skips them regardless).
  for (const name of composeServiceNames) {
    if (instancesByComposeName.has(name)) continue;
    const row = serviceRows.find((serviceRow) =>
      serviceRow.composeServiceName === name
    );
    instancesByComposeName.set(
      name,
      resolveServiceInstances(parseServiceOptions(row?.options) ?? {}),
    );
  }
  return instancesByComposeName;
}

function buildServiceRowByCloneName(
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>,
): Map<string, ServiceRow> {
  const serviceRowByCloneName = new Map<string, ServiceRow>();
  for (const row of serviceRows) {
    for (
      const cloneName of expansion.get(row.composeServiceName) ??
        [row.composeServiceName]
    ) {
      serviceRowByCloneName.set(cloneName, row);
    }
  }
  return serviceRowByCloneName;
}

/** Service ids (within this environment) that own at least one active binding. */
async function loadServiceIdsWithBindings(
  db: Db,
  serviceIds: readonly string[],
): Promise<Set<string>> {
  if (serviceIds.length === 0) return new Set();
  const rows = await db
    .select({ serviceId: binding.serviceId })
    .from(binding)
    .where(inArray(binding.serviceId, [...serviceIds]));
  return new Set(rows.map((row) => row.serviceId));
}

/**
 * Compose service names (post multi-instance expansion) that consume a
 * managed-database binding and therefore must join the daemon's shared
 * managed-ingress Docker network (`turbopanel-managed`) so their resolved
 * binding endpoint (a ProxySQL container name) is dial-able — see
 * `resolveBindingEndpoint` in `../bindings/resolve-endpoint.ts`.
 */
async function resolveManagedNetworkComposeServiceNames(
  db: Db,
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>,
): Promise<string[]> {
  const boundServiceIds = await loadServiceIdsWithBindings(
    db,
    serviceRows.map((row) => row.id),
  );
  if (boundServiceIds.size === 0) return [];

  const names = new Set<string>();
  for (const row of serviceRows) {
    if (!boundServiceIds.has(row.id)) continue;
    for (
      const cloneName of expansion.get(row.composeServiceName) ??
        [row.composeServiceName]
    ) {
      names.add(cloneName);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Bound compose services that should join this server's local ProxySQL
 * network. Remote extra_hosts on one service must not drop that attachment
 * for co-resident bindings on the same server.
 */
function localManagedNetworkServiceNames(
  boundLogicalNames: readonly string[],
  remoteHostsByService: ReadonlyMap<string, unknown> | undefined,
): string[] {
  if (!remoteHostsByService || remoteHostsByService.size === 0) {
    return [...boundLogicalNames];
  }
  return boundLogicalNames.filter((name) => !remoteHostsByService.has(name));
}

function resourceLimitPrepareError(
  optionsByComposeName: ServiceOptionsByComposeName,
  serviceCount: number,
  orgOptions: unknown,
  serverOptions: unknown,
): SoftDeployPrepareError | null {
  const orgLimits = parseResourceLimits(
    isPlainObject(orgOptions) ? orgOptions.resourceLimits : null,
  ) ?? {};
  const serverLimits = parseResourceLimits(
    isPlainObject(serverOptions) ? serverOptions.resourceLimits : null,
  ) ?? {};
  const usage = sumServiceResourceUsage(optionsByComposeName, serviceCount);
  const violations = checkResourceLimits(usage, orgLimits, serverLimits);
  if (violations.length === 0) return null;
  return { kind: "resource_limit", violations };
}

async function loadDeployEnvAndProject(
  db: Db,
  environmentId: string,
): Promise<
  | {
    envRow: {
      id: string;
      projectId: string;
      options: unknown;
      name: string | null;
    };
    projectRow: { id: string; options: unknown };
  }
  | Response
> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      options: environment.options,
      name: environment.name,
    })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1);
  if (!envRow) return Response.json({ error: "Not found" }, { status: 404 });

  const [projectRow] = await db
    .select({
      id: project.id,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1);
  if (!projectRow) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return { envRow, projectRow };
}

type DeployExpandPipeline = {
  containers: ContainerAllocation[];
  ingressServices: EnvironmentDeployIngressService[];
  registeredVolumes: RegisteredComposeVolume[];
  /** composeKey → Docker volume name applied by the merged pipeline. */
  volumeRenames: Map<string, string>;
  expandedDocument: ComposeDocument;
  expansion: Map<string, string[]>;
  expandedServiceNames: string[];
  optionsByComposeName: ServiceOptionsByComposeName;
  localReplicaCounts: Map<string, number>;
  localServiceNames?: Set<string>;
};

async function allocateExpandDeployPipeline(
  db: Db,
  params: {
    environmentId: string;
    serverId: string;
    organizationId: string;
    projectOptions: unknown;
    merged: ComposeDocument;
    composeServiceNames: readonly string[];
    serviceRows: ServiceRow[];
    schedule?: DeployScheduleSlice;
  },
): Promise<DeployExpandPipeline> {
  const containerNaming = resolveContainerNaming(
    parseProjectOptions(params.projectOptions),
  );
  const containerComposeNames = listContainerComposeNames(params.merged);
  const containerServices = applyScheduleToContainerSpecs(
    buildContainerServiceSpecs(
      params.serviceRows,
      containerComposeNames,
      readComposeContainerNames(params.merged),
    ),
    params.schedule,
  );

  const tcpUdpServices = await resolveTcpUdpIngressServices(
    db,
    params.environmentId,
  );
  const ingressServices: EnvironmentDeployIngressService[] = [];
  const ingressKeepIds = new Set<string>();
  for (const svc of tcpUdpServices) {
    if (
      !ownsIngressForService(params.schedule, svc.serviceId, params.serverId)
    ) {
      continue;
    }
    const alloc = await ensureServiceIngressContainerAllocation(db, {
      serviceId: svc.serviceId,
      serverId: params.serverId,
      composeServiceName: svc.composeServiceName,
    });
    ingressKeepIds.add(alloc.containerRowId);
    ingressServices.push({
      serviceId: alloc.serviceId,
      composeServiceName: alloc.composeServiceName,
      containerName: alloc.containerName,
    });
  }

  const containers = await allocateEnvironmentContainers(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    containerServices,
    containerNaming,
    environmentServiceIds: params.serviceRows.map((row) => row.id),
    extraKeepIds: ingressKeepIds,
  });

  const registeredVolumes = await registerComposeVolumes(db, {
    document: params.merged,
    organizationId: params.organizationId,
    environmentId: params.environmentId,
    serverId: params.serverId,
  });
  await registerComposeMounts(db, {
    document: params.merged,
    environmentId: params.environmentId,
  });
  const volumeRenames = new Map(
    registeredVolumes.map((row) => [row.composeKey, row.volumeName]),
  );
  const withRenamedVolumes = renameComposeVolumes(params.merged, volumeRenames);
  const expansion = identityComposeExpansion(params.composeServiceNames);
  const localCounts = params.schedule
    ? localReplicaCounts(
      params.schedule.tasks,
      params.schedule.serviceIdToName,
      params.serverId,
    )
    : new Map(
      containerServices.map((
        spec,
      ) => [spec.composeServiceName, spec.instances]),
    );
  const localNames = params.schedule
    ? localServiceNames(
      params.schedule.tasks,
      params.schedule.serviceIdToName,
      params.serverId,
    )
    : undefined;

  return {
    containers,
    ingressServices,
    registeredVolumes,
    volumeRenames,
    expandedDocument: withRenamedVolumes,
    expansion,
    expandedServiceNames: listComposeServiceKeys(withRenamedVolumes),
    optionsByComposeName: buildExpandedServiceOptionsMap(
      params.serviceRows,
      expansion,
    ),
    localReplicaCounts: localCounts,
    ...(localNames ? { localServiceNames: localNames } : {}),
  };
}

function documentForServiceOptions(
  _mode: DeployPrepareMode,
  withVariables: { document: ComposeDocument },
): ComposeDocument {
  return withVariables.document;
}

async function maybeSealDeployMaterials(
  mode: DeployPrepareMode,
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  secretMaterial: DeployVariableMaterial[],
  storageMaterialRaw: EnvironmentDeployStorageMaterial[],
): Promise<
  | {
    variableMaterial: EnvironmentDeployVariableMaterial[];
    storageMaterial: EnvironmentDeployStorageMaterial[];
  }
  | Response
> {
  // Preview must not require an online daemon — skip sealing / daemon-key steps.
  if (mode === "preview") {
    return { variableMaterial: [], storageMaterial: storageMaterialRaw };
  }
  const variableMaterial = await sealVariableMaterialForDaemon(
    c,
    db,
    serverId,
    secretMaterial,
  );
  if (variableMaterial instanceof Response) return variableMaterial;
  const storageMaterial = await sealStorageMaterialForDaemon(
    c,
    db,
    serverId,
    storageMaterialRaw,
  );
  if (storageMaterial instanceof Response) return storageMaterial;
  return { variableMaterial, storageMaterial };
}

type BindingMaterializationOutcome =
  | { kind: "ok" }
  | { kind: "warn"; warning: DeployPrepareWarning }
  | { kind: "error"; error: DeployPrepareError };

/**
 * Re-materialize service bindings and classify the outcome so the caller
 * stays a flat sequence of early returns / warning pushes.
 */
async function resolveBindingMaterializationOutcome(
  db: Db,
  dataEncryptionSecrets: Parameters<typeof decryptSecret>[0] | undefined,
  serviceIds: string[],
  mode: DeployPrepareMode,
): Promise<BindingMaterializationOutcome> {
  if (!dataEncryptionSecrets) return { kind: "ok" };

  const bindResult = await materializeBindingsForServices(
    db,
    dataEncryptionSecrets,
    serviceIds,
  );
  if ("ok" in bindResult) return { kind: "ok" };

  const isSoftBindingError =
    bindResult.kind === "binding_endpoint_unavailable" ||
    bindResult.kind === "datacenter_ip_required" ||
    bindResult.kind === "private_path_unavailable";

  const error: DeployPrepareError = { kind: "binding_endpoint_unavailable" };
  if (isSoftBindingError) {
    return mode === "preview"
      ? { kind: "warn", warning: warningFromPrepareError(error) }
      : { kind: "error", error };
  }

  if (mode !== "preview") return { kind: "error", error };

  return {
    kind: "warn",
    warning: {
      code: "binding_endpoint_unavailable",
      message: `Binding materialization failed: ${bindResult.kind}`,
    },
  };
}

function resolveTraditionalWebSitesForMode(
  mode: DeployPrepareMode,
  warnings: DeployPrepareWarning[],
  sitesOrError:
    | EnvironmentDeployTraditionalWebSite[]
    | {
      kind: "traditional_web_principal_ambiguous";
      composeServiceName: string;
    },
  fallbackSites: readonly TraditionalWebSiteSpec[],
): EnvironmentDeployTraditionalWebSite[] | SoftDeployPrepareError {
  if (!("kind" in sitesOrError)) return sitesOrError;
  if (mode === "preview") {
    warnings.push(warningFromPrepareError(sitesOrError));
    return fallbackSites.map((site) => ({ ...site }));
  }
  return sitesOrError;
}

async function externalNetworkPrepareError(
  db: Db,
  organizationId: string,
  serverId: string,
  dockerExternalNetworks: string[],
): Promise<SoftDeployPrepareError | null> {
  const unregistered = await validateRegisteredExternalDockerNetworks(
    db,
    organizationId,
    serverId,
    dockerExternalNetworks,
  );
  if (!unregistered) return null;
  return {
    kind: "docker_external_network_unregistered",
    names: unregistered,
  };
}

function replicaCountsFromMap(
  counts: ReadonlyMap<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function identityComposeExpansion(
  names: readonly string[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const name of names) map.set(name, [name]);
  return map;
}

function overlayCompiledExpansion(
  identity: ReadonlyMap<string, string[]>,
  compiled: ReadonlyMap<string, string[]>,
): Map<string, string[]> {
  const next = new Map(identity);
  for (const [name, clones] of compiled) next.set(name, clones);
  return next;
}

function applyExpansionToNames(
  names: readonly string[],
  expansion: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const clones = expansion.get(name);
    if (!clones || clones.length === 0) {
      out.add(name);
      continue;
    }
    for (const clone of clones) out.add(clone);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function applyScheduleToContainerSpecs(
  specs: ContainerServiceSpec[],
  schedule: DeployScheduleSlice | undefined,
): ContainerServiceSpec[] {
  if (!schedule) return specs;
  const tasksByService = new Map<string, DesiredTaskInput[]>();
  for (const task of schedule.tasks) {
    const list = tasksByService.get(task.serviceId) ?? [];
    list.push(task);
    tasksByService.set(task.serviceId, list);
  }
  const next: ContainerServiceSpec[] = [];
  for (const spec of specs) {
    const tasks = tasksByService.get(spec.serviceId);
    if (!tasks || tasks.length === 0) continue;
    const serverIdByOrdinal = new Map<number, string>();
    for (const task of tasks) {
      serverIdByOrdinal.set(task.slot + 1, task.serverId);
    }
    next.push({
      ...spec,
      instances: tasks.length,
      serverIdByOrdinal,
    });
  }
  return next;
}

function ownsIngressForService(
  schedule: DeployScheduleSlice | undefined,
  serviceId: string,
  serverId: string,
): boolean {
  if (!schedule) return true;
  const slots = schedule.tasks.filter((task) => task.serviceId === serviceId);
  if (slots.length === 0) return false;
  let minSlot = slots[0]!.slot;
  for (const task of slots) {
    if (task.slot < minSlot) minSlot = task.slot;
  }
  return slots.some((task) =>
    task.slot === minSlot && task.serverId === serverId
  );
}

async function toPreparedDeployResult(
  mode: DeployPrepareMode,
  parts: {
    composeYaml: string;
    composeFiles: EnvironmentDeployComposeFile[];
    hooks: ServiceDeployHook[];
    variableMaterial: EnvironmentDeployVariableMaterial[];
    storageMaterial: EnvironmentDeployStorageMaterial[];
    principalMaterial: EnvironmentDeployPrincipalMaterial[];
    traditionalWebSites: EnvironmentDeployTraditionalWebSite[];
    dockerExternalNetworks: string[];
    fabricNetworks?: readonly EnvironmentDeployFabricNetwork[];
    managedNetworkServices: string[];
    containers: ContainerAllocation[];
    ingressServices: EnvironmentDeployIngressService[];
    expansion: Map<string, string[]>;
    registeredVolumes: RegisteredComposeVolume[];
    warnings: DeployPrepareWarning[];
    replicaCounts: Record<string, number>;
    envFile?: string;
    secretPlan?: DeploySecretPlanEntry[];
  },
): Promise<PreparedDeployCompose> {
  const omitSecrets = mode === "preview";
  return {
    composeYaml: parts.composeYaml,
    composeFiles: parts.composeFiles,
    desiredHash: await sha256HexUtf8(parts.composeYaml),
    replicaCounts: parts.replicaCounts,
    hooks: parts.hooks,
    variableMaterial: omitSecrets ? [] : parts.variableMaterial,
    storageMaterial: omitSecrets ? [] : parts.storageMaterial,
    principalMaterial: parts.principalMaterial,
    traditionalWebSites: parts.traditionalWebSites,
    dockerExternalNetworks: parts.dockerExternalNetworks,
    fabricNetworks: parts.fabricNetworks ? [...parts.fabricNetworks] : [],
    managedNetworkServices: parts.managedNetworkServices,
    containers: parts.containers,
    ingressServices: parts.ingressServices,
    composeServiceExpansion: expansionToRecord(parts.expansion),
    volumes: parts.registeredVolumes,
    warnings: parts.warnings,
    ...(parts.envFile !== undefined ? { envFile: parts.envFile } : {}),
    ...(parts.secretPlan !== undefined ? { secretPlan: parts.secretPlan } : {}),
  };
}

function toApplyVariablesPrepareError(
  error: ApplyVariablesError,
): DeployPrepareError {
  const { kind, message, ref, composeServiceName, envKey } = error;
  if (kind === "variable_unresolved") {
    return {
      kind,
      message,
      ...(ref === undefined ? {} : { ref }),
      ...(composeServiceName === undefined ? {} : { composeServiceName }),
      ...(envKey === undefined ? {} : { envKey }),
    };
  }
  return {
    kind,
    message,
    ...(composeServiceName === undefined ? {} : { composeServiceName }),
    ...(envKey === undefined ? {} : { envKey }),
  };
}

function compileRuntimeOptionsForServer(
  environmentId: string,
  pipeline: Pick<
    DeployExpandPipeline,
    "localReplicaCounts" | "localServiceNames"
  >,
  schedule?: DeployScheduleSlice,
): CompileRuntimeOptions {
  const options: CompileRuntimeOptions = {
    environmentId,
    localReplicaCounts: pipeline.localReplicaCounts,
  };
  if (pipeline.localServiceNames) {
    options.localServiceNames = pipeline.localServiceNames;
  }
  if (!schedule) return options;
  if (schedule.spanningNetworks) {
    options.spanningNetworks = schedule.spanningNetworks;
  }
  if (schedule.taskAddresses) {
    options.taskAddressesByService = schedule.taskAddresses;
  }
  if (schedule.spanningHosts) {
    options.spanningHostsByService = schedule.spanningHosts;
  }
  if (
    schedule.managedIngressHostsByService &&
    schedule.managedIngressHostsByService.size > 0
  ) {
    options.managedIngressHostsByService =
      schedule.managedIngressHostsByService;
  }
  return options;
}

function sitesOnScheduledServer<T extends { composeServiceName: string }>(
  sites: readonly T[],
  localNames?: ReadonlySet<string>,
): T[] {
  if (!localNames) return [...sites];
  return sites.filter((site) => localNames.has(site.composeServiceName));
}

function healthCheckAcknowledge(
  mode: DeployPrepareMode,
  acknowledge?: boolean,
): boolean | undefined {
  if (mode === "preview") return false;
  return acknowledge;
}

function fabricNetworksFromSchedule(
  schedule?: DeployScheduleSlice,
): readonly EnvironmentDeployFabricNetwork[] {
  return schedule?.fabricNetworks ?? [];
}

export async function prepareDeployCompose(
  c: Context<AppEnv>,
  db: Db,
  params: {
    environmentId: string;
    serverId: string;
    organizationId: string;
    acknowledgeHealthCheckWarnings?: boolean;
    /**
     * `preview` skips daemon sealing, softens prepare gates into `warnings`,
     * and redacts secret values in the returned YAML. Allocation + volume
     * registration still run (idempotent) so previewed UUIDs match deploy.
     */
    mode?: DeployPrepareMode;
    /** When set, compile and allocate from the scheduler plan instead of YAML expansion. */
    schedule?: DeployScheduleSlice;
  },
): Promise<PreparedDeployCompose | DeployPrepareError | Response> {
  const mode = params.mode ?? "deploy";
  const warnings: DeployPrepareWarning[] = [];

  const loaded = await loadDeployEnvAndProject(db, params.environmentId);
  if (loaded instanceof Response) return loaded;
  const { envRow, projectRow } = loaded;

  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, params.organizationId))
    .limit(1);

  const [serverRow] = await db
    .select({ options: server.options })
    .from(server)
    .where(eq(server.id, params.serverId))
    .limit(1);

  const environmentFilename = environmentComposeFilename({
    id: envRow.id,
    name: envRow.name,
  });
  const rawComposeLayers = resolveProjectEnvironmentComposeLayers(
    projectRow.options,
    envRow.options,
    environmentFilename,
  );
  if (rawComposeLayers instanceof Response) return rawComposeLayers;
  const merged = mergeComposeLayers(rawComposeLayers);

  const composeServiceNames = listComposeServiceKeys(merged);
  if (composeServiceNames.length === 0) {
    return await emptyComposePrepareResult(mode);
  }

  await reconcileServicesFromCompose(db, params.environmentId, merged);

  const serviceRows = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
      options: service.options,
    })
    .from(service)
    .where(eq(service.environmentId, params.environmentId));

  // Re-materialize bindings so endpoint / CA / topology drift is picked up.
  const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
  const bindingOutcome = await resolveBindingMaterializationOutcome(
    db,
    dataEncryptionSecrets,
    serviceRows.map((r) => r.id),
    mode,
  );
  if (bindingOutcome.kind === "error") return bindingOutcome.error;
  if (bindingOutcome.kind === "warn") warnings.push(bindingOutcome.warning);

  const pipeline = await allocateExpandDeployPipeline(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    organizationId: params.organizationId,
    projectOptions: projectRow.options,
    merged,
    composeServiceNames,
    serviceRows,
    schedule: params.schedule,
  });

  const locationErr = await findUnavailableStorageLocation(db, {
    environmentId: params.environmentId,
    scheduledServerId: params.serverId,
    serviceIds: serviceIdsOnScheduledServer(
      params.schedule,
      params.serverId,
      serviceRows.map((row) => row.id),
    ),
  });
  if (locationErr) return locationErr;

  const limitErr = absorbSoftPrepareError(
    mode,
    warnings,
    resourceLimitPrepareError(
      pipeline.optionsByComposeName,
      pipeline.expandedServiceNames.length,
      orgRow?.options,
      serverRow?.options,
    ),
  );
  if (limitErr) return limitErr;

  const healthErr = absorbSoftPrepareError(
    mode,
    warnings,
    evaluateHealthCheckGates(
      pipeline.expandedDocument,
      pipeline.optionsByComposeName,
      healthCheckAcknowledge(mode, params.acknowledgeHealthCheckWarnings),
    ),
  );
  if (healthErr) return healthErr;

  const serviceRowByCloneName = buildServiceRowByCloneName(
    serviceRows,
    pipeline.expansion,
  );
  const { globalEntries, perServiceEntries: userPerService, perServiceScopes } =
    await resolveDeployVariableBuckets(db, {
      environmentId: params.environmentId,
      serverId: params.serverId,
      composeServiceNames: pipeline.expandedServiceNames,
      serviceRowByComposeName: serviceRowByCloneName,
      dataEncryptionSecrets: c.get("dataEncryptionSecrets"),
    });

  const allocationByClone = new Map(
    pipeline.containers.map((row) => [row.cloneComposeServiceName, row]),
  );
  const perServiceEntries = appendPlatformVariablesToEntries(userPerService, {
    projectId: envRow.projectId,
    environmentId: params.environmentId,
    serviceRowByCloneName,
    allocationByClone,
  });

  const withVariables = applyVariablesToComposeDocument(
    pipeline.expandedDocument,
    {
      globalEntries,
      perServiceEntries,
      perServiceScopes,
      projectId: envRow.projectId,
      environmentId: params.environmentId,
    },
  );
  if (isApplyVariablesError(withVariables)) {
    return toApplyVariablesPrepareError(withVariables);
  }
  const withServiceOptions = applyServiceOptionsToComposeDocument(
    documentForServiceOptions(mode, withVariables),
    pipeline.optionsByComposeName,
    buildContainerNameByComposeName(
      pipeline.containers,
      pipeline.localReplicaCounts,
      params.serverId,
    ),
  );

  const storageMaterialRaw = await loadStorageMaterial(db, {
    environmentId: params.environmentId,
    projectId: envRow.projectId,
    organizationId: params.organizationId,
    serverId: params.serverId,
    serviceIds: serviceRows.map((row) => row.id),
    cloneNamesByServiceId: buildCloneNamesByServiceId(
      serviceRows,
      pipeline.expansion,
    ),
    registeredVolumes: pipeline.registeredVolumes,
  });
  const sealed = await maybeSealDeployMaterials(
    mode,
    c,
    db,
    params.serverId,
    withVariables.secretMaterial,
    storageMaterialRaw,
  );
  if (sealed instanceof Response) return sealed;
  const { variableMaterial, storageMaterial } = sealed;

  const stewardPrincipalIds = await loadStewardPrincipalIdsForEnvironment(
    db,
    params.environmentId,
  );
  const storagePrincipalIds = storageMaterial
    .map((entry) => entry.principalId)
    .filter((id): id is string => typeof id === "string");
  const principalMaterial = await loadPrincipalMaterial(db, [
    ...stewardPrincipalIds,
    ...storagePrincipalIds,
  ]);

  const split = splitTraditionalWebFromDocument(withServiceOptions.document);
  // Drop traditional-web hooks — they are not Docker compose services.
  const traditionalNames = new Set(
    split.sites.map((site) => site.composeServiceName),
  );
  const hooks = withServiceOptions.hooks.filter(
    (hook) => !traditionalNames.has(hook.composeServiceName),
  );

  const traditionalResolved = resolveTraditionalWebSitesForMode(
    mode,
    warnings,
    await attachPrincipalsToTraditionalWebSites(
      db,
      params.environmentId,
      serviceRows,
      principalMaterial,
      split.sites,
    ),
    split.sites,
  );
  if ("kind" in traditionalResolved) return traditionalResolved;
  const localTraditional = sitesOnScheduledServer(
    traditionalResolved,
    pipeline.localServiceNames,
  );

  const dockerExternalNetworks = collectComposeExternalDockerNetworkNames(
    split.composeYaml,
  );
  const networkErr = absorbSoftPrepareError(
    mode,
    warnings,
    await externalNetworkPrepareError(
      db,
      params.organizationId,
      params.serverId,
      dockerExternalNetworks,
    ),
  );
  if (networkErr) return networkErr;

  // Traditional-web sites are host-native (stripped from `composeYaml` above)
  // and never join a Docker network — exclude them even if a binding was
  // somehow attached to one.
  const boundNames = (
    await resolveManagedNetworkComposeServiceNames(
      db,
      serviceRows,
      pipeline.expansion,
    )
  ).filter((name) => !traditionalNames.has(name));
  const managedLogicalNames = localManagedNetworkServiceNames(
    boundNames,
    params.schedule?.managedIngressHostsByService,
  );

  // Effective document = the same post-split container document serialized as
  // composeYaml today. Compile one runtime snapshot; daemons never see
  // project/environment/platform layers.
  const effective = split.containerDocument;
  const compiled = compileRuntimeCompose(
    effective,
    compileRuntimeOptionsForServer(
      params.environmentId,
      pipeline,
      params.schedule,
    ),
  );
  const expansion = overlayCompiledExpansion(
    pipeline.expansion,
    compiled.expansion,
  );
  const managedNetworkServices = applyExpansionToNames(
    managedLogicalNames,
    expansion,
  );
  const composeYaml = composeDocumentToRuntimeYaml(compiled.document) ||
    emptyContainerComposeYaml();
  const composeFiles = renderRuntimeComposeFiles(composeYaml);

  return await toPreparedDeployResult(mode, {
    composeYaml,
    composeFiles,
    hooks,
    variableMaterial,
    storageMaterial,
    principalMaterial,
    traditionalWebSites: localTraditional,
    dockerExternalNetworks,
    fabricNetworks: fabricNetworksFromSchedule(params.schedule),
    managedNetworkServices,
    containers: pipeline.containers,
    ingressServices: pipeline.ingressServices,
    expansion,
    registeredVolumes: pipeline.registeredVolumes,
    warnings,
    replicaCounts: replicaCountsFromMap(pipeline.localReplicaCounts),
    envFile: withVariables.envFileContent,
    secretPlan: withVariables.secretPlan,
  });
}

/**
 * Pin each traditional-web site to at most one assigned project principal.
 * Multiple principals on the same service is ambiguous ownership → prepare error.
 */
export async function attachPrincipalsToTraditionalWebSites(
  db: Db,
  environmentId: string,
  serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>,
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[],
  sites: readonly TraditionalWebSiteSpec[],
): Promise<
  | EnvironmentDeployTraditionalWebSite[]
  | { kind: "traditional_web_principal_ambiguous"; composeServiceName: string }
> {
  if (sites.length === 0) return [];

  const principalById = new Map(
    principalMaterial.map((entry) => [entry.principalId, entry]),
  );
  const principalIdsByServiceId =
    await loadPrincipalIdsByServiceIdForEnvironment(
      db,
      environmentId,
    );
  const serviceIdByComposeName = new Map<string, string>();
  for (const row of serviceRows) {
    serviceIdByComposeName.set(row.composeServiceName, row.id);
  }

  const out: EnvironmentDeployTraditionalWebSite[] = [];
  for (const site of sites) {
    const serviceId = serviceIdByComposeName.get(site.composeServiceName);
    const assignedIds = serviceId
      ? (principalIdsByServiceId.get(serviceId) ?? [])
      : [];
    const sole = pickSolePrincipalId(assignedIds);
    if (sole.status === "ambiguous") {
      return {
        kind: "traditional_web_principal_ambiguous",
        composeServiceName: site.composeServiceName,
      };
    }
    const material = sole.status === "one"
      ? principalById.get(sole.principalId)
      : undefined;
    const principalPin = material
      ? toTraditionalWebPrincipal(material)
      : undefined;
    out.push({
      ...site,
      ...(principalPin ? { principal: principalPin } : {}),
    });
  }
  return out;
}

function toTraditionalWebPrincipal(
  material: EnvironmentDeployPrincipalMaterial,
): EnvironmentDeployTraditionalWebPrincipal {
  return {
    principalId: material.principalId,
    username: material.username,
    ...(material.uid !== undefined ? { uid: material.uid } : {}),
    ...(material.gid !== undefined ? { gid: material.gid } : {}),
  };
}

function splitTraditionalWebFromDocument(document: ComposeDocument): {
  composeYaml: string;
  /** Post-split / pruned container document (same body as `composeYaml`). */
  containerDocument: ComposeDocument;
  sites: TraditionalWebSiteSpec[];
} {
  const services = isPlainObject(document.data.services)
    ? (document.data.services as Record<string, unknown>)
    : {};
  const { containerServices, sites } = splitTraditionalWebServices(services);

  if (Object.keys(containerServices).length === 0) {
    const emptyDocument: ComposeDocument = {
      version: 1,
      data: { services: {} },
      presentation: { keyOrder: ["services"], comments: {} },
    };
    return {
      composeYaml: emptyContainerComposeYaml(),
      containerDocument: emptyDocument,
      sites,
    };
  }

  const existingNetworks = isPlainObject(document.data.networks)
    ? (document.data.networks as Record<string, unknown>)
    : undefined;
  const prunedNetworks = pruneUnreferencedComposeNetworks(
    containerServices,
    existingNetworks,
  );

  const nextData: Record<string, unknown> = {
    ...document.data,
    services: containerServices,
  };
  if (prunedNetworks) {
    nextData.networks = prunedNetworks;
  } else {
    delete nextData.networks;
  }

  const containerDocument: ComposeDocument = {
    ...document,
    data: nextData,
  };
  return {
    composeYaml: composeDocumentToRuntimeYaml(containerDocument),
    containerDocument,
    sites,
  };
}

export function readHostingProxyFromOptions(
  options: unknown,
): EnvironmentDeployHosting["proxy"] {
  if (!isPlainObject(options)) return undefined;
  const proxy = resolveHostingProxy({
    proxy: isPlainObject(options.proxy) ? options.proxy : undefined,
  });
  return {
    forceHttps: proxy.forceHttps,
    gzip: proxy.gzip,
    brotli: proxy.brotli,
    ...(proxy.stripPrefix ? { stripPrefix: proxy.stripPrefix } : {}),
  };
}

/**
 * Resolve the Caddy `bind` address for one hosting entry at deploy-prepare time
 * so the daemon stays DB-free. Returns `undefined` when no bind directive should
 * be emitted (public bind with no pinned IP).
 */
export async function resolveHostingBindAddress(
  db: Db,
  params: Readonly<{
    serverId: string;
    options: unknown;
    ipId: string | null;
  }>,
): Promise<
  | string
  | undefined
  | Extract<DeployPrepareError, { kind: "datacenter_ip_required" }>
> {
  const bind = resolveHostingBind(parseHostingOptions(params.options));

  if (bind === "local") return "127.0.0.1";

  if (bind === "datacenter") {
    const address = await loadServerDatacenterAddress(db, params.serverId);
    if (!address) {
      return { kind: "datacenter_ip_required", serverId: params.serverId };
    }
    return address;
  }

  // public (default)
  if (!params.ipId) return undefined;

  const [row] = await db
    .select({ address: ip.address, serverId: ip.serverId })
    .from(ip)
    .where(eq(ip.id, params.ipId))
    .limit(1);
  if (!row) {
    throw new Error("hosting ip pin not found");
  }
  if (row.serverId !== null && row.serverId !== params.serverId) {
    throw new Error("hosting ip pin server mismatch");
  }
  const address = inetAddressToString(row.address);
  if (!address) {
    throw new Error("hosting ip pin address invalid");
  }
  return address;
}

export { extractComposeFromOptions };

/** Pure helpers exported for host-free unit coverage of prepare gates. */
export {
  absorbSoftPrepareError,
  appendPlatformVariablesToEntries,
  buildCloneNamesByServiceId,
  buildExpandedServiceOptionsMap,
  buildInstancesByComposeName,
  buildServiceRowByCloneName,
  compileRuntimeOptionsForServer,
  documentForServiceOptions,
  emptyComposePrepareResult,
  emptyPreparedCompose,
  evaluateHealthCheckGates,
  expansionToRecord,
  fabricNetworksFromSchedule,
  healthCheckAcknowledge,
  listComposeServiceKeys,
  listContainerComposeNames,
  localManagedNetworkServiceNames,
  resolveTraditionalWebSitesForMode,
  resourceLimitPrepareError,
  sitesOnScheduledServer,
  splitTraditionalWebFromDocument,
  toApplyVariablesPrepareError,
  toPreparedDeployResult,
  warningFromPrepareError,
};

// Re-export layer builders used by prepare for host-free coverage imports.
export {
  environmentComposeFilename,
  PROJECT_COMPOSE_FILENAME,
  renderRuntimeComposeFiles,
  RUNTIME_COMPOSE_FILENAME,
} from "./deploy-layers.ts";
