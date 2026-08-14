import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import type { AuthRouteOpts } from "../authn/http.ts";
import {
  ENVELOPE_MAGIC,
  resealSecretForDaemon,
} from "../authn/data-encryption.ts";
import { createSessionMiddleware } from "../authn/middleware.ts";
import { resolveEntityOrganizationId } from "../authz/create-access-grant.ts";
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from "../../daemon/authn/server-identity-db.ts";
import {
  type DeployPrepareError,
  type DeployScheduleSlice,
  type PreparedDeployCompose,
  prepareDeployCompose,
  readHostingProxyFromOptions,
  resolveHostingBindAddress,
} from "./deploy-prepare.ts";
import { resolveHostingDeployWeb } from "../../lib/hosting-web-env.ts";
import type { DerivedSecretsConfig } from "../authn/secrets.ts";
import type { CommandEnvelope } from "../../lib/commands/envelope.ts";
import type {
  EnvironmentDeployComposeFile,
  EnvironmentDeployFabricNetwork,
  EnvironmentDeployHosting,
  EnvironmentDeployIngressService,
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeployServiceHook,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeployTlsMaterial,
  EnvironmentDeployTraditionalWebSite,
  EnvironmentDeployVariableMaterial,
  EnvironmentLifecycleAction,
} from "../../lib/commands/schemas.ts";
import {
  buildDeployPreviewContainers,
  buildTraditionalWebSitesForDeploy,
  composeProjectName,
  deployMaterialsErrorResponse,
  expandHostingsForComposeInstances,
  fabricGateErrorResponse,
  mapPrepareErrorResponse,
  parseDeployRequestFlags,
  parseLifecycleAction,
  queuedCommandsResponseBody,
  type QueuedCommandRef,
  readHostingPorts,
  readHostingProtocol,
  readHostnames,
  readPathPrefix,
  readTargetPort,
  scheduleErrorResponse,
  tlsPinErrorCode,
} from "./deploy-routes-helpers.ts";
import { resolveTcpUdpIngressServices } from "./tcp-udp-ingress.ts";
import { isNoopCommandQueue } from "../../lib/commands/noop-command-queue.ts";
import {
  type CommandQueue,
  getCommandQueue,
} from "../../lib/commands/queue.ts";
import {
  createCommandRecord,
  transitionCommand,
} from "../../lib/db/command-records.ts";
import { bumpEnvironmentGeneration } from "../../lib/db/environment-generation.ts";
import {
  type DeploymentTargetInput,
  listEnvironmentDeploymentTargets,
  markDeploymentFailed,
  pruneDrainedDeployments,
  upsertDeploymentTargets,
} from "../../lib/db/deployment-records.ts";
import {
  type DesiredTaskInput,
  listEnvironmentTasks,
  replaceEnvironmentTasksInTx,
} from "../../lib/db/task-records.ts";
import {
  composeNetworkNamesByServer,
  type FabricSegmentMaterial,
  getOrganizationFabric,
  listEnvironmentComposeNetworks,
  listSegmentsForServers,
  materializeSpanningNetworks,
  purgeComposeNetworksCreatedAfter,
  purgeEnvironmentComposeNetworks,
  releaseSegmentsForServer,
} from "../../lib/db/fabric-records.ts";
import {
  awaitParticipatingFabricConvergence,
  isFabricEnqueueTypedError,
} from "../../lib/fabric/enqueue.ts";
import type { FabricGateOutcome } from "../../lib/fabric/gate.ts";
import {
  assignTaskAddresses,
  buildCompileAddressMaps,
  planEnvironmentDeploy,
  type PlannedDeploy,
} from "../../lib/schedule/index.ts";
import { enqueueManagedIngressReconcile } from "../managed/ingress-desired.ts";
import {
  loadManagedIngressPlatformAttachments,
  type ManagedIngressConsumer,
  reservedIngressHostsForServer,
} from "../managed/ingress-attachments.ts";
import { ensureManagedIngressHierarchy } from "../system/hierarchy.ts";
import {
  composeServiceNetworkKeys,
  type PlatformAttachment,
} from "../../lib/fabric/spanning.ts";
import {
  environment,
  hosting,
  project,
  server,
  service,
  tls,
} from "../../lib/db/schema.ts";
import {
  assembleTlsMetadata,
  parseTlsOptions,
  resolveTlsForHosting,
  type TlsCandidate,
} from "../../lib/tls/index.ts";
import { type Db, getDaemonCellRegistry, getDb } from "../../db.ts";
import {
  assertCanManageOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
} from "../shared.ts";
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from "../../lib/project-options.ts";

type DeployHostingPayload = EnvironmentDeployHosting;

function responseForScheduleError(
  c: Context<AppEnv>,
  error: Parameters<typeof scheduleErrorResponse>[0],
  message: string,
): Response {
  const mapped = scheduleErrorResponse(error, message);
  return c.json(mapped.body, { status: mapped.status as 409 | 422 });
}

function serviceIdToNameMap(
  rows: ReadonlyArray<{ id: string; composeServiceName: string }>,
): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.composeServiceName]));
}

function scheduleSliceForServer(
  planned: PlannedDeploy,
  serverId: string,
  spanning: ReadonlyMap<string, string> | undefined,
  tasks: readonly DesiredTaskInput[],
  compileMaps: ReturnType<typeof buildCompileAddressMaps> | undefined,
  fabricNetworks: readonly EnvironmentDeployFabricNetwork[] | undefined,
  managedIngressHostsByService?: ReadonlyMap<
    string,
    ReadonlyArray<{ name: string; address: string }>
  >,
): DeployScheduleSlice {
  return {
    serverId,
    tasks,
    serviceIdToName: serviceIdToNameMap(planned.serviceRows),
    ...(spanning && spanning.size > 0 ? { spanningNetworks: spanning } : {}),
    ...(compileMaps && compileMaps.taskAddressesByService.size > 0
      ? { taskAddresses: compileMaps.taskAddressesByService }
      : {}),
    ...(compileMaps && compileMaps.spanningHostsByService.size > 0
      ? { spanningHosts: compileMaps.spanningHostsByService }
      : {}),
    ...(fabricNetworks && fabricNetworks.length > 0 ? { fabricNetworks } : {}),
    ...(managedIngressHostsByService && managedIngressHostsByService.size > 0
      ? { managedIngressHostsByService }
      : {}),
  };
}

async function loadSpanningNetworks(
  db: Db,
  planned: PlannedDeploy,
  organizationId: string,
  environmentId: string,
): Promise<{
  spanning: Map<string, string>;
  attachments: PlatformAttachment[];
  consumers: ManagedIngressConsumer[];
}> {
  const empty = {
    spanning: new Map<string, string>(),
    attachments: [],
    consumers: [],
  };
  if (!planned.plan.ok || !planned.fabricEnabled) {
    return empty;
  }
  const fabricRow = await getOrganizationFabric(db, organizationId);
  if (!fabricRow) return empty;
  const { attachments, consumers } =
    await loadManagedIngressPlatformAttachments(
      db,
      {
        environmentId,
        document: planned.merged,
        tasks: planned.plan.tasks,
        serviceRows: planned.serviceRows,
      },
    );
  const spanning = await materializeSpanningNetworks(db, {
    organizationId,
    environmentId,
    fabric: fabricRow,
    document: planned.merged,
    tasks: planned.plan.tasks,
    serviceRows: planned.serviceRows,
    platformAttachments: attachments,
  });
  return { spanning, attachments, consumers };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function networkServiceIdsForSpanning(
  planned: PlannedDeploy,
  spanningKeys: readonly string[],
): Map<string, Set<string>> {
  const nameToId = new Map(
    planned.serviceRows.map((row) => [row.composeServiceName, row.id]),
  );
  const services = isPlainObject(planned.merged.data.services)
    ? planned.merged.data.services
    : {};
  const out = new Map<string, Set<string>>();
  for (const composeKey of spanningKeys) {
    const ids = new Set<string>();
    for (const [name, body] of Object.entries(services)) {
      if (!composeServiceNetworkKeys(body).includes(composeKey)) continue;
      const serviceId = nameToId.get(name);
      if (serviceId) ids.add(serviceId);
    }
    out.set(composeKey, ids);
  }
  return out;
}

function networkSegmentsFromMaterial(
  spanning: ReadonlyMap<string, string>,
  segmentsByServer: Map<string, FabricSegmentMaterial[]>,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [composeKey, hostName] of spanning) {
    const byServer = new Map<string, string>();
    for (const [serverId, segments] of segmentsByServer) {
      const match = segments.find((segment) => segment.name === hostName);
      if (match) byServer.set(serverId, match.subnet);
    }
    out.set(composeKey, byServer);
  }
  return out;
}

function fabricNetworksForServer(
  segments: readonly FabricSegmentMaterial[] | undefined,
  spanningHostNames: ReadonlySet<string>,
): EnvironmentDeployFabricNetwork[] {
  if (!segments || spanningHostNames.size === 0) return [];
  return segments
    .filter((segment) => spanningHostNames.has(segment.name))
    .map((segment) => ({
      name: segment.name,
      subnet: segment.subnet,
      ...(segment.mtu !== undefined ? { mtu: segment.mtu } : {}),
      ...(segment.gateway !== undefined ? { gateway: segment.gateway } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function enrichPlannedTaskAddresses(
  db: Db,
  planned: PlannedDeploy,
  spanning: ReadonlyMap<string, string>,
  environmentId: string,
  extraServerIds: readonly string[] = [],
): Promise<{
  tasks: DesiredTaskInput[];
  segmentsByServer: Map<string, FabricSegmentMaterial[]>;
  networkServiceIds: Map<string, Set<string>>;
}> {
  const baseTasks = planned.plan.ok ? planned.plan.tasks : [];
  if (!planned.plan.ok) {
    return {
      tasks: baseTasks,
      segmentsByServer: new Map(),
      networkServiceIds: new Map(),
    };
  }
  const networkServiceIds = spanning.size === 0
    ? new Map<string, Set<string>>()
    : networkServiceIdsForSpanning(planned, [...spanning.keys()]);
  if (spanning.size === 0) {
    return {
      tasks: assignTaskAddresses({
        tasks: baseTasks,
        existing: [],
        networkSegments: new Map(),
        networkServiceIds: new Map(),
      }),
      segmentsByServer: new Map(),
      networkServiceIds,
    };
  }
  const existing = await listEnvironmentTasks(db, environmentId);
  const segmentServerIds = [
    ...new Set([...planned.plan.serverIds, ...extraServerIds]),
  ];
  const segmentsByServer = await listSegmentsForServers(
    db,
    segmentServerIds,
  );
  const tasks = assignTaskAddresses({
    tasks: baseTasks,
    existing,
    networkSegments: networkSegmentsFromMaterial(spanning, segmentsByServer),
    networkServiceIds,
  });
  return { tasks, segmentsByServer, networkServiceIds };
}

async function listenerNamesForAttachments(
  db: Db,
  organizationId: string,
  attachments: readonly PlatformAttachment[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const uniqueIds = [...new Set(attachments.map((row) => row.serverId))];
  for (const serverId of uniqueIds) {
    const hierarchy = await ensureManagedIngressHierarchy(db, {
      organizationId,
      serverId,
    });
    names.set(serverId, hierarchy.containerName);
  }
  return names;
}

function assertDispatchInfrastructure(
  c: Context<AppEnv>,
): CommandQueue | Response {
  const registry = getDaemonCellRegistry(c);
  if (!registry) {
    return c.json({ error: "Daemon cell registry unavailable" }, 503);
  }

  const commandQueue = getCommandQueue(c);
  if (!commandQueue || isNoopCommandQueue(commandQueue)) {
    return c.json({ error: "Command queue unavailable" }, 503);
  }

  return commandQueue;
}

function responseForPrepareError(
  c: Context<AppEnv>,
  prepared: DeployPrepareError,
): Response {
  const mapped = mapPrepareErrorResponse(prepared);
  return c.json(mapped.body, { status: mapped.status as 400 | 409 | 422 });
}

function responseForFabricGate(
  c: Context<AppEnv>,
  outcome: Exclude<FabricGateOutcome, { kind: "ready" }>,
): Response {
  const mapped = fabricGateErrorResponse(outcome);
  return c.json(mapped.body, { status: mapped.status as 409 | 422 });
}

type BuildHostingResult =
  | {
    hostings: DeployHostingPayload[];
    resolvedTlsIds: string[];
  }
  | { error: Response }
  | { prepareError: DeployPrepareError };

type OrgTlsCandidate = TlsCandidate & {
  certificatePem: string | null;
  privateKeyPem: string | null;
};

type ServiceRow = {
  id: string;
  composeServiceName: string;
};

type HostingRow = {
  id: string;
  options: unknown;
  tlsId: string | null;
  ipId: string | null;
};

async function resolveHttpHostingEntry(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  h: HostingRow,
  svc: Readonly<{ id: string; composeServiceName: string }>,
  candidates: OrgTlsCandidate[],
  serverId: string,
): Promise<
  | { entry: DeployHostingPayload }
  | { skip: true }
  | { error: Response }
  | { prepareError: DeployPrepareError }
> {
  const hostnames = readHostnames(h.options);
  if (hostnames.length === 0) return { skip: true };

  const resolved = resolveTlsForHosting({
    pinId: h.tlsId,
    hostnames,
    candidates,
  });
  if (!resolved.ok) {
    return {
      error: Response.json(
        { error: tlsPinErrorCode(resolved.error), hostingId: h.id },
        { status: 400 },
      ),
    };
  }

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId,
    options: h.options,
    ipId: h.ipId,
  });
  if (
    typeof bindResolved === "object" && bindResolved !== null &&
    "kind" in bindResolved
  ) {
    return { prepareError: bindResolved };
  }

  const web = await resolveHostingDeployWeb(
    db,
    dataEncryptionSecrets,
    h.id,
    h.options,
  );

  return {
    entry: {
      hostingId: h.id,
      serviceId: svc.id,
      composeServiceName: svc.composeServiceName,
      hostnames,
      pathPrefix: readPathPrefix(h.options),
      targetPort: readTargetPort(h.options),
      tlsId: resolved.tlsId,
      proxy: readHostingProxyFromOptions(h.options),
      ...(bindResolved === undefined ? {} : { bindAddress: bindResolved }),
      ...(web === undefined ? {} : { web }),
    },
  };
}

/**
 * `tcp` / `udp` hosting publishes raw port(s) straight through Traefik — no
 * hostname/TLS routing, used for non-HTTP docker services (e.g. Postgres).
 */
async function resolveTcpUdpHostingEntry(
  db: Db,
  h: HostingRow,
  svc: Readonly<{ id: string; composeServiceName: string }>,
  protocol: "tcp" | "udp",
  serverId: string,
): Promise<
  | { entry: DeployHostingPayload }
  | { skip: true }
  | { prepareError: DeployPrepareError }
> {
  const ports = readHostingPorts(h.options);
  if (ports.length === 0) return { skip: true };

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId,
    options: h.options,
    ipId: h.ipId,
  });
  if (
    typeof bindResolved === "object" && bindResolved !== null &&
    "kind" in bindResolved
  ) {
    return { prepareError: bindResolved };
  }

  return {
    entry: {
      hostingId: h.id,
      serviceId: svc.id,
      composeServiceName: svc.composeServiceName,
      hostnames: [],
      protocol,
      ports,
      ...(bindResolved === undefined ? {} : { bindAddress: bindResolved }),
    },
  };
}

async function resolveHostingEntry(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  h: HostingRow,
  svc: Readonly<{ id: string; composeServiceName: string }>,
  candidates: OrgTlsCandidate[],
  serverId: string,
): Promise<
  | { entry: DeployHostingPayload }
  | { skip: true }
  | { error: Response }
  | { prepareError: DeployPrepareError }
> {
  const protocol = readHostingProtocol(h.options);
  if (protocol === "http") {
    return resolveHttpHostingEntry(
      db,
      dataEncryptionSecrets,
      h,
      svc,
      candidates,
      serverId,
    );
  }
  return resolveTcpUdpHostingEntry(db, h, svc, protocol, serverId);
}

async function loadOrgTlsCandidates(
  db: Db,
  organizationId: string,
): Promise<OrgTlsCandidate[]> {
  const rows = await db
    .select({
      id: tls.id,
      status: tls.status,
      notAfter: tls.notAfter,
      fingerprintSha256: tls.fingerprintSha256,
      metadata: tls.metadata,
      options: tls.options,
      certificatePem: tls.certificatePem,
      privateKeyPem: tls.privateKeyPem,
    })
    .from(tls)
    .where(eq(tls.organizationId, organizationId));

  const out: OrgTlsCandidate[] = [];
  for (const row of rows) {
    const metadata = assembleTlsMetadata(
      {
        status: row.status,
        notAfter: row.notAfter,
        fingerprintSha256: row.fingerprintSha256,
      },
      row.metadata,
    );
    if (!metadata) continue;
    out.push({
      id: row.id,
      metadata,
      options: parseTlsOptions(row.options),
      certificatePem: row.certificatePem,
      privateKeyPem: row.privateKeyPem,
    });
  }
  return out;
}

async function buildHostingsForService(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  svc: ServiceRow,
  candidates: OrgTlsCandidate[],
  serverId: string,
): Promise<
  | { hostings: DeployHostingPayload[]; tlsIds: string[] }
  | { error: Response }
  | { prepareError: DeployPrepareError }
> {
  const composeServiceName = svc.composeServiceName;
  const hostingRows = await db
    .select({
      id: hosting.id,
      options: hosting.options,
      tlsId: hosting.tlsId,
      ipId: hosting.ipId,
    })
    .from(hosting)
    .where(eq(hosting.serviceId, svc.id));

  const hostings: DeployHostingPayload[] = [];
  const tlsIds: string[] = [];
  for (const h of hostingRows) {
    const result = await resolveHostingEntry(
      db,
      dataEncryptionSecrets,
      h,
      { id: svc.id, composeServiceName },
      candidates,
      serverId,
    );
    if ("skip" in result) continue;
    if ("error" in result) return result;
    if ("prepareError" in result) return result;
    hostings.push(result.entry);
    if (result.entry.tlsId) tlsIds.push(result.entry.tlsId);
  }
  return { hostings, tlsIds };
}

async function buildHostingPayload(
  db: Db,
  environmentId: string,
  organizationId: string,
  serverId: string,
  dataEncryptionSecrets: DerivedSecretsConfig,
): Promise<BuildHostingResult> {
  const serviceRows = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
    })
    .from(service)
    .where(eq(service.environmentId, environmentId));

  const candidates = await loadOrgTlsCandidates(db, organizationId);
  const hostingPayload: DeployHostingPayload[] = [];
  const resolvedTlsIds = new Set<string>();

  for (const svc of serviceRows) {
    const built = await buildHostingsForService(
      db,
      dataEncryptionSecrets,
      svc,
      candidates,
      serverId,
    );
    if ("error" in built) return built;
    if ("prepareError" in built) return built;
    hostingPayload.push(...built.hostings);
    for (const tlsId of built.tlsIds) resolvedTlsIds.add(tlsId);
  }

  return { hostings: hostingPayload, resolvedTlsIds: [...resolvedTlsIds] };
}

async function sealTlsMaterialForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  organizationId: string,
  tlsIds: string[],
): Promise<EnvironmentDeployTlsMaterial[] | Response> {
  if (tlsIds.length === 0) return [];

  const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
  const secretsConfig = c.get("secretsConfig");
  if (!dataEncryptionSecrets || !secretsConfig) {
    return c.json({
      error: "Encryption unavailable — no encryption key configured",
    }, 503);
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId);
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return c.json({
      error: "No encryption-capable daemon key on target server",
    }, 422);
  }
  const keyId = daemonState.key.id;

  const rows = await db
    .select({
      id: tls.id,
      certificatePem: tls.certificatePem,
      privateKeyPem: tls.privateKeyPem,
      organizationId: tls.organizationId,
    })
    .from(tls)
    .where(and(eq(tls.organizationId, organizationId)));

  const byId = new Map(rows.map((row) => [row.id, row]));
  const material: EnvironmentDeployTlsMaterial[] = [];

  for (const tlsId of tlsIds) {
    const row = byId.get(tlsId);
    if (!row?.certificatePem || !row.privateKeyPem) {
      return c.json({ error: "tls_material_missing", tlsId }, 400);
    }
    // Refuse plaintext / non-tpsecret rows — keys must be sealed at rest.
    if (
      !row.privateKeyPem.startsWith(`${ENVELOPE_MAGIC}.`) ||
      row.privateKeyPem.includes("BEGIN")
    ) {
      return c.json({ error: "tls_key_not_sealed", tlsId }, 500);
    }
    let privateKeyEnvelope: string;
    try {
      privateKeyEnvelope = await resealSecretForDaemon(
        secretsConfig,
        dataEncryptionSecrets,
        { serverId, keyId },
        row.privateKeyPem,
      );
    } catch {
      return c.json({ error: "tls_decrypt_failed", tlsId }, 500);
    }
    material.push({
      tlsId,
      certificatePem: row.certificatePem,
      privateKeyEnvelope,
    });
  }

  return material;
}

/**
 * Shared manage-gate for deploy-preview / stop / lifecycle (no deploy body flags).
 * Exported for host-free unit coverage of thin authz branches.
 */
export async function authorizeEnvironmentManage(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
): Promise<{ userId: string; organizationId: string } | Response> {
  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const orgResult = await getOrgId(c, session.userId);
  if (orgResult instanceof Response) return orgResult;

  const entityOrgId = await resolveEntityOrganizationId(
    db,
    "environment",
    environmentId,
  );
  if (!entityOrgId || entityOrgId !== orgResult) {
    return c.json({ error: "Not found" }, 404);
  }

  const denied = await assertCanManageOr403(c, "environment", environmentId);
  if (denied) return denied;

  const immutable = await assertNotSystemOwnedOr403(
    c,
    "environment",
    environmentId,
  );
  if (immutable) return immutable;

  return {
    userId: session.userId,
    organizationId: orgResult,
  };
}

/**
 * Deploy-only authz: {@link authorizeEnvironmentManage} plus deploy request flags.
 * Exported for host-free unit coverage without full orchestration.
 */
export async function authorizeDeployRequest(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
): Promise<
  {
    userId: string;
    organizationId: string;
    acknowledgeHealthCheckWarnings: boolean;
    noCache: boolean;
  } | Response
> {
  const auth = await authorizeEnvironmentManage(c, db, environmentId);
  if (auth instanceof Response) return auth;

  const body = await parseJsonBody(c);
  if (body instanceof Response) return body;

  const flags = parseDeployRequestFlags(body);
  if (flags === "invalid") {
    return c.json({ error: "Invalid request" }, 400);
  }

  return {
    ...auth,
    acknowledgeHealthCheckWarnings: flags.acknowledgeHealthCheckWarnings,
    noCache: flags.noCache,
  };
}

type DeployCommandCreateParams = {
  serverId: string;
  userId: string;
  environmentId: string;
  projectId: string;
  organizationId: string;
  projectName: string;
  composeYaml: string;
  composeFiles: EnvironmentDeployComposeFile[];
  hostings: DeployHostingPayload[];
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[];
  ingressServices: EnvironmentDeployIngressService[];
  tlsMaterial: EnvironmentDeployTlsMaterial[];
  variableMaterial: EnvironmentDeployVariableMaterial[];
  storageMaterial: EnvironmentDeployStorageMaterial[];
  principalMaterial: EnvironmentDeployPrincipalMaterial[];
  serviceHooks: EnvironmentDeployServiceHook[];
  dockerExternalNetworks: string[];
  fabricNetworks: EnvironmentDeployFabricNetwork[];
  managedNetworkServices: string[];
  noCache: boolean;
  generation: number;
  desiredHash: string;
  replicaCounts: Record<string, number>;
};

type CreatedDeployCommand = QueuedCommandRef & { queuedAt: string };

type PreparedServerDeploy = {
  serverId: string;
  prepared: PreparedDeployCompose;
  hostings: DeployHostingPayload[];
  tlsMaterial: EnvironmentDeployTlsMaterial[];
};

async function createDeployCommand(
  db: Db,
  params: DeployCommandCreateParams,
): Promise<CreatedDeployCommand> {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: "user",
    actorId: params.userId,
    type: "environment.deploy",
    payload: {
      environmentId: params.environmentId,
      projectId: params.projectId,
      organizationId: params.organizationId,
      projectName: params.projectName,
      composeYaml: params.composeYaml,
      composeFiles: params.composeFiles,
      generation: params.generation,
      desiredHash: params.desiredHash,
      serverId: params.serverId,
      replicaCounts: params.replicaCounts,
      hostings: params.hostings,
      ...(params.traditionalWebSites.length > 0
        ? { traditionalWebSites: params.traditionalWebSites }
        : {}),
      ...(params.ingressServices.length > 0
        ? { ingressServices: params.ingressServices }
        : {}),
      ...(params.tlsMaterial.length > 0
        ? { tlsMaterial: params.tlsMaterial }
        : {}),
      ...(params.variableMaterial.length > 0
        ? { variableMaterial: params.variableMaterial }
        : {}),
      ...(params.storageMaterial.length > 0
        ? { storageMaterial: params.storageMaterial }
        : {}),
      ...(params.principalMaterial.length > 0
        ? { principalMaterial: params.principalMaterial }
        : {}),
      ...(params.serviceHooks.length > 0
        ? { serviceHooks: params.serviceHooks }
        : {}),
      ...(params.dockerExternalNetworks.length > 0
        ? { dockerExternalNetworks: params.dockerExternalNetworks }
        : {}),
      ...(params.fabricNetworks.length > 0
        ? { fabricNetworks: params.fabricNetworks }
        : {}),
      ...(params.managedNetworkServices.length > 0
        ? { managedNetworkServices: params.managedNetworkServices }
        : {}),
      ...(params.noCache ? { noCache: true } : {}),
    },
    expiresAt,
  });

  return {
    commandId: record.id,
    serverId: params.serverId,
    status: "queued",
    queuedAt: record.queuedAt ?? record.createdAt,
  };
}

async function deliverDeployCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    commandId: string;
    serverId: string;
    environmentId: string;
    queuedAt: string;
  },
): Promise<QueuedCommandRef | Response> {
  const envelope: CommandEnvelope = {
    commandId: params.commandId,
    serverId: params.serverId,
    type: "environment.deploy",
    attempt: 1,
    queuedAt: params.queuedAt,
  };

  try {
    await commandQueue.enqueue(envelope);
  } catch {
    await transitionCommand(db, params.commandId, {
      status: "failed",
      error: "Command queue unavailable",
    });
    await markDeploymentFailed(db, {
      environmentId: params.environmentId,
      serverId: params.serverId,
      error: "Command queue unavailable",
      commandId: params.commandId,
    });
    return Response.json({ error: "Command queue unavailable" }, {
      status: 503,
    });
  }

  return {
    commandId: params.commandId,
    serverId: params.serverId,
    status: "queued",
  };
}

function createParamsForPreparedServer(
  row: PreparedServerDeploy,
  params: {
    userId: string;
    environmentId: string;
    projectId: string;
    organizationId: string;
    projectName: string;
    generation: number;
    noCache: boolean;
  },
): DeployCommandCreateParams {
  return {
    serverId: row.serverId,
    userId: params.userId,
    environmentId: params.environmentId,
    projectId: params.projectId,
    organizationId: params.organizationId,
    projectName: params.projectName,
    composeYaml: row.prepared.composeYaml,
    composeFiles: row.prepared.composeFiles,
    hostings: row.hostings,
    traditionalWebSites: buildTraditionalWebSitesForDeploy(
      row.prepared.traditionalWebSites,
      row.hostings,
    ),
    ingressServices: row.prepared.ingressServices,
    tlsMaterial: row.tlsMaterial,
    variableMaterial: row.prepared.variableMaterial,
    storageMaterial: row.prepared.storageMaterial,
    principalMaterial: row.prepared.principalMaterial,
    serviceHooks: row.prepared.hooks,
    dockerExternalNetworks: row.prepared.dockerExternalNetworks,
    fabricNetworks: row.prepared.fabricNetworks,
    managedNetworkServices: row.prepared.managedNetworkServices,
    noCache: params.noCache,
    generation: params.generation,
    desiredHash: row.prepared.desiredHash,
    replicaCounts: row.prepared.replicaCounts,
  };
}

function deploymentTargetsForFanOut(
  params: {
    preparedByServer: readonly PreparedServerDeploy[];
    planServerIds: readonly string[];
    drainedIds: readonly string[];
    generation: number;
    created: readonly CreatedDeployCommand[];
  },
): DeploymentTargetInput[] {
  const preparedByServerId = new Map(
    params.preparedByServer.map((row) => [row.serverId, row]),
  );
  const commandByServer = new Map(
    params.created.map((row) => [row.serverId, row.commandId]),
  );
  return [
    ...params.planServerIds.map((serverId) => {
      const prepared = preparedByServerId.get(serverId)?.prepared;
      return {
        serverId,
        desiredGeneration: params.generation,
        desiredHash: prepared?.desiredHash ?? null,
        status: "applying" as const,
        lastCommandId: commandByServer.get(serverId) ?? null,
        options: {
          secretPlan: prepared?.secretPlan ?? [],
        },
      };
    }),
    ...params.drainedIds.map((serverId) => ({
      serverId,
      desiredGeneration: params.generation,
      status: "draining" as const,
    })),
  ];
}

/**
 * Atomically bump generation, replace tasks, create deploy commands, and
 * persist deployment targets. Returns command refs only after commit.
 * Queue delivery stays outside. Callers must treat spanning networks as
 * committed once this returns.
 */
async function persistDeployFanOut(
  db: Db,
  params: {
    preparedByServer: readonly PreparedServerDeploy[];
    planServerIds: readonly string[];
    drainedIds: readonly string[];
    userId: string;
    environmentId: string;
    projectId: string;
    organizationId: string;
    projectName: string;
    tasks: readonly DesiredTaskInput[];
    noCache: boolean;
  },
): Promise<CreatedDeployCommand[]> {
  return await db.transaction(async (tx) => {
    const generation = await bumpEnvironmentGeneration(tx, params.environmentId);
    await replaceEnvironmentTasksInTx(tx, {
      environmentId: params.environmentId,
      generation,
      tasks: params.tasks,
    });

    const created: CreatedDeployCommand[] = [];
    for (const row of params.preparedByServer) {
      created.push(
        await createDeployCommand(
          tx,
          createParamsForPreparedServer(row, {
            userId: params.userId,
            environmentId: params.environmentId,
            projectId: params.projectId,
            organizationId: params.organizationId,
            projectName: params.projectName,
            generation,
            noCache: params.noCache,
          }),
        ),
      );
    }

    await upsertDeploymentTargets(tx, {
      environmentId: params.environmentId,
      targets: deploymentTargetsForFanOut({
        preparedByServer: params.preparedByServer,
        planServerIds: params.planServerIds,
        drainedIds: params.drainedIds,
        generation,
        created,
      }),
    });
    return created;
  });
}

/**
 * Deliver persisted deploy commands. Queue failures mark that server's
 * command/target failed and continue so a partial fan-out stays consistent
 * with rows already written.
 */
async function deliverDeployFanOut(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    created: readonly CreatedDeployCommand[];
    environmentId: string;
  },
): Promise<{ queued: QueuedCommandRef[]; enqueueError: Response | null }> {
  const queued: QueuedCommandRef[] = [];
  let enqueueError: Response | null = null;
  for (const ref of params.created) {
    const delivered = await deliverDeployCommand(db, commandQueue, {
      commandId: ref.commandId,
      serverId: ref.serverId,
      environmentId: params.environmentId,
      queuedAt: ref.queuedAt,
    });
    if (delivered instanceof Response) {
      enqueueError ??= delivered;
      continue;
    }
    queued.push(delivered);
  }
  return { queued, enqueueError };
}

export {
  buildTraditionalWebSitesForDeploy,
  deployMaterialsErrorResponse,
  expandHostingsForComposeInstances,
  preferredListenPortsFromHostings,
  queuedCommandsResponseBody,
  readHostingPorts,
  readHostingProtocol,
  readHostnames,
  readPathPrefix,
  readTargetPort,
  scheduleErrorResponse,
  validateDeployMaterials,
} from "./deploy-routes-helpers.ts";

/**
 * GET /environments/:id/deploy-preview — exact compose YAML the daemon would
 * receive (same `prepareDeployCompose` path), with secrets redacted.
 *
 * Allocation (`(service, ordinal)`) and volume registration
 * (`(environment, composeVolumeKey)`) are idempotent, so preview may perform
 * them; deploy reuses the same rows and the previewed UUIDs stay truthful.
 * Sealing / daemon-key steps are skipped so an online daemon is not required.
 */
export function registerEnvironmentDeployPreviewRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError(
      "session secrets are required for environment deploy-preview routes",
    );
  }
  router.use(
    "/environments/:id/deploy-preview",
    createSessionMiddleware(opts.secrets),
  );

  router.get("/environments/:id/deploy-preview", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const environmentId = c.req.param("id");
    const auth = await authorizeEnvironmentManage(c, db, environmentId);
    if (auth instanceof Response) return auth;

    const planned = await planEnvironmentDeploy(db, {
      environmentId,
      organizationId: auth.organizationId,
    });
    if ("kind" in planned) {
      if (planned.kind === "not_found") {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ error: "Invalid compose document" }, 400);
    }
    if (!planned.plan.ok) {
      return responseForScheduleError(
        c,
        planned.plan.error,
        planned.plan.message,
      );
    }

    const { spanning, attachments, consumers } = await loadSpanningNetworks(
      db,
      planned,
      auth.organizationId,
      environmentId,
    );
    const enriched = await enrichPlannedTaskAddresses(
      db,
      planned,
      spanning,
      environmentId,
      attachments.map((row) => row.serverId),
    );
    const spanningHostNames = new Set(spanning.values());
    const serviceIdToName = serviceIdToNameMap(planned.serviceRows);
    const listenerNames = await listenerNamesForAttachments(
      db,
      auth.organizationId,
      attachments,
    );
    const preparedByServer: Array<{
      serverId: string;
      prepared: PreparedDeployCompose;
    }> = [];
    for (const serverId of planned.plan.serverIds) {
      const prepared = await prepareDeployCompose(c, db, {
        environmentId,
        serverId,
        organizationId: auth.organizationId,
        mode: "preview",
        schedule: scheduleSliceForServer(
          planned,
          serverId,
          spanning,
          enriched.tasks,
          buildCompileAddressMaps({
            tasks: enriched.tasks,
            serviceIdToName,
            serverId,
            networkServiceIds: enriched.networkServiceIds,
          }),
          fabricNetworksForServer(
            enriched.segmentsByServer.get(serverId),
            spanningHostNames,
          ),
          reservedIngressHostsForServer({
            thisServerId: serverId,
            attachments,
            consumers,
            spanning,
            segmentsByServer: enriched.segmentsByServer,
            listenerNameByServer: listenerNames,
          }),
        ),
      });
      if (prepared instanceof Response) return prepared;
      if ("kind" in prepared) {
        return responseForPrepareError(c, prepared);
      }
      preparedByServer.push({ serverId, prepared });
    }

    const first = preparedByServer[0];
    const serverRows = planned.plan.serverIds.length === 0 ? [] : await db
      .select({ id: server.id, name: server.name })
      .from(server)
      .where(inArray(server.id, planned.plan.serverIds));
    const nameById = new Map(serverRows.map((row) => [row.id, row.name]));
    const projectName = composeProjectName(planned.projectId);
    const ingress = preparedByServer.flatMap((row) =>
      row.prepared.ingressServices
    );
    const appContainers = first?.prepared.containers ?? [];

    return c.json({
      ok: true as const,
      composeYaml: first?.prepared.composeYaml ?? "",
      composeFiles: first?.prepared.composeFiles ?? [],
      projectName,
      servers: preparedByServer.map((row) => ({
        serverId: row.serverId,
        displayName: nameById.get(row.serverId) ?? row.serverId,
        composeYaml: row.prepared.composeYaml,
        services: Object.keys(row.prepared.replicaCounts).sort((a, b) =>
          a.localeCompare(b)
        ),
      })),
      containers: buildDeployPreviewContainers({
        appContainers,
        ingressServices: ingress,
      }),
      volumes: (first?.prepared.volumes ?? []).map((row) => ({
        storageId: row.storageId,
        composeKey: row.composeKey,
        volumeName: row.volumeName,
      })),
      warnings: preparedByServer.flatMap((row) => row.prepared.warnings),
      envFile: first?.prepared.envFile ?? "",
      secretPlan: first?.prepared.secretPlan ?? [],
    });
  });
}

type SuccessfulPlannedDeploy = PlannedDeploy & {
  plan: Extract<PlannedDeploy["plan"], { ok: true }>;
};

type DeployRequestAuth = Exclude<
  Awaited<ReturnType<typeof authorizeDeployRequest>>,
  Response
>;

type EnrichedTaskAddresses = Awaited<
  ReturnType<typeof enrichPlannedTaskAddresses>
>;

type DeploySpanningContext = {
  spanning: Map<string, string>;
  attachments: PlatformAttachment[];
  consumers: ManagedIngressConsumer[];
  enriched: EnrichedTaskAddresses;
  listenerNames: Map<string, string>;
};

async function resolveSuccessfulPlan(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
  organizationId: string,
): Promise<SuccessfulPlannedDeploy | Response> {
  const planned = await planEnvironmentDeploy(db, {
    environmentId,
    organizationId,
  });
  if ("kind" in planned) {
    if (planned.kind === "not_found") {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ error: "Invalid compose document" }, 400);
  }
  const { plan } = planned;
  if (!plan.ok) {
    return responseForScheduleError(c, plan.error, plan.message);
  }
  return { ...planned, plan };
}

export function attachmentServerIds(
  attachments: readonly PlatformAttachment[],
): string[] {
  return attachments.map((row) => row.serverId);
}

export function tcpUdpIngressServiceRefs(
  services: ReadonlyArray<{ serviceId: string }>,
): Array<{ serviceId: string }> {
  return services.map((svc) => ({ serviceId: svc.serviceId }));
}

export function deployParticipation(params: {
  planServerIds: readonly string[];
  attachments: readonly PlatformAttachment[];
  previous: ReadonlyArray<{ serverId: string }>;
}): {
  attachmentServers: Set<string>;
  participating: Set<string>;
  drainedIds: string[];
} {
  const attachmentServers = new Set(attachmentServerIds(params.attachments));
  const participating = new Set([
    ...params.planServerIds,
    ...attachmentServers,
  ]);
  const activeDeployIds = new Set(params.planServerIds);
  const drainedIds: string[] = [];
  for (const row of params.previous) {
    if (!activeDeployIds.has(row.serverId)) drainedIds.push(row.serverId);
  }
  return { attachmentServers, participating, drainedIds };
}

async function awaitDeployFabricGate(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    planned: SuccessfulPlannedDeploy;
    auth: DeployRequestAuth;
    attachments: readonly PlatformAttachment[];
    dataEncryptionSecrets: DerivedSecretsConfig;
  },
): Promise<Response | null> {
  const fabricServerIds = [
    ...new Set([
      ...params.planned.plan.serverIds,
      ...attachmentServerIds(params.attachments),
    ]),
  ];
  if (!params.planned.fabricEnabled || fabricServerIds.length <= 1) {
    return null;
  }
  const fabricRow = await getOrganizationFabric(db, params.auth.organizationId);
  if (!fabricRow) return null;

  const secretsConfig = c.get("secretsConfig");
  const fabricGate = await awaitParticipatingFabricConvergence({
    db,
    commandQueue,
    actorType: "user",
    actorId: params.auth.userId,
    fabric: fabricRow,
    serverIds: fabricServerIds,
    ...(secretsConfig ? { secretsConfig } : {}),
    dataEncryptionSecrets: params.dataEncryptionSecrets,
  });
  if (fabricGate.kind === "ready") return null;
  if (
    fabricGate.kind === "failed" &&
    fabricGate.error &&
    isFabricEnqueueTypedError(fabricGate.error)
  ) {
    return c.json({ error: fabricGate.error }, 422);
  }
  return responseForFabricGate(c, fabricGate);
}

function scheduleSliceForPreparedServer(
  params: {
    planned: SuccessfulPlannedDeploy;
    spanning: Map<string, string>;
    enriched: EnrichedTaskAddresses;
    attachments: PlatformAttachment[];
    consumers: ManagedIngressConsumer[];
    listenerNames: Map<string, string>;
    spanningHostNames: Set<string>;
    serverId: string;
  },
): ReturnType<typeof scheduleSliceForServer> {
  return scheduleSliceForServer(
    params.planned,
    params.serverId,
    params.spanning,
    params.enriched.tasks,
    buildCompileAddressMaps({
      tasks: params.enriched.tasks,
      serviceIdToName: serviceIdToNameMap(params.planned.serviceRows),
      serverId: params.serverId,
      networkServiceIds: params.enriched.networkServiceIds,
    }),
    fabricNetworksForServer(
      params.enriched.segmentsByServer.get(params.serverId),
      params.spanningHostNames,
    ),
    reservedIngressHostsForServer({
      thisServerId: params.serverId,
      attachments: params.attachments,
      consumers: params.consumers,
      spanning: params.spanning,
      segmentsByServer: params.enriched.segmentsByServer,
      listenerNameByServer: params.listenerNames,
    }),
  );
}

async function prepareOneServerDeploy(
  c: Context<AppEnv>,
  db: Db,
  params: {
    planned: SuccessfulPlannedDeploy;
    environmentId: string;
    auth: DeployRequestAuth;
    dataEncryptionSecrets: DerivedSecretsConfig;
    spanning: Map<string, string>;
    attachments: PlatformAttachment[];
    consumers: ManagedIngressConsumer[];
    enriched: EnrichedTaskAddresses;
    listenerNames: Map<string, string>;
    spanningHostNames: Set<string>;
    serverId: string;
  },
): Promise<PreparedServerDeploy | Response> {
  const prepared = await prepareDeployCompose(c, db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    organizationId: params.auth.organizationId,
    acknowledgeHealthCheckWarnings: params.auth.acknowledgeHealthCheckWarnings,
    schedule: scheduleSliceForPreparedServer(params),
  });
  if (prepared instanceof Response) return prepared;
  if ("kind" in prepared) return responseForPrepareError(c, prepared);

  const hostingBuilt = await buildHostingPayload(
    db,
    params.environmentId,
    params.auth.organizationId,
    params.serverId,
    params.dataEncryptionSecrets,
  );
  if ("prepareError" in hostingBuilt) {
    return responseForPrepareError(c, hostingBuilt.prepareError);
  }
  if ("error" in hostingBuilt) return hostingBuilt.error;

  const hostings = expandHostingsForComposeInstances(
    hostingBuilt.hostings,
    prepared.composeServiceExpansion,
  );
  const tlsMaterial = await sealTlsMaterialForDaemon(
    c,
    db,
    params.serverId,
    params.auth.organizationId,
    hostingBuilt.resolvedTlsIds,
  );
  if (tlsMaterial instanceof Response) return tlsMaterial;

  const materialsError = deployMaterialsErrorResponse(
    hostings,
    prepared.storageMaterial,
  );
  if (materialsError) return materialsError;

  return {
    serverId: params.serverId,
    prepared,
    hostings,
    tlsMaterial,
  };
}

async function prepareAllServerDeploys(
  c: Context<AppEnv>,
  db: Db,
  params: {
    planned: SuccessfulPlannedDeploy;
    environmentId: string;
    auth: DeployRequestAuth;
    dataEncryptionSecrets: DerivedSecretsConfig;
  } & DeploySpanningContext,
): Promise<PreparedServerDeploy[] | Response> {
  const spanningHostNames = new Set(params.spanning.values());
  const preparedByServer: PreparedServerDeploy[] = [];
  for (const serverId of params.planned.plan.serverIds) {
    const row = await prepareOneServerDeploy(c, db, {
      ...params,
      spanningHostNames,
      serverId,
    });
    if (row instanceof Response) return row;
    preparedByServer.push(row);
  }
  return preparedByServer;
}

async function stopDrainedDeployments(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    drainedIds: readonly string[];
    attachmentServers: ReadonlySet<string>;
    userId: string;
    environmentId: string;
    projectId: string;
    projectName: string;
  },
): Promise<Response | null> {
  if (params.drainedIds.length === 0) return null;

  const tcpUdpServices = await resolveTcpUdpIngressServices(
    db,
    params.environmentId,
  );
  const composeNetworks = await listEnvironmentComposeNetworks(
    db,
    params.environmentId,
  );
  const namesByServer = composeNetworkNamesByServer(composeNetworks);
  const ingressServices = tcpUdpIngressServiceRefs(tcpUdpServices);
  for (const serverId of params.drainedIds) {
    const stopped = await enqueueStopCommand(db, commandQueue, {
      serverId,
      userId: params.userId,
      environmentId: params.environmentId,
      projectId: params.projectId,
      projectName: params.projectName,
      ingressServices,
      fabricNetworks: namesByServer.get(serverId) ?? [],
    });
    if (stopped instanceof Response) return stopped;
    if (!params.attachmentServers.has(serverId)) {
      await releaseSegmentsForServer(db, {
        environmentId: params.environmentId,
        serverId,
      });
    }
  }
  await pruneDrainedDeployments(db, {
    environmentId: params.environmentId,
    serverIds: params.drainedIds,
  });
  return null;
}

async function releaseOrphanedComposeNetworks(
  db: Db,
  environmentId: string,
  participating: ReadonlySet<string>,
): Promise<string[]> {
  const leftoverNetworks = await listEnvironmentComposeNetworks(
    db,
    environmentId,
  );
  const leftoverByServer = composeNetworkNamesByServer(leftoverNetworks);
  const releasedListeners: string[] = [];
  for (const serverId of leftoverByServer.keys()) {
    if (!participating.has(serverId)) {
      await releaseSegmentsForServer(db, { environmentId, serverId });
      releasedListeners.push(serverId);
    }
  }
  return releasedListeners;
}

function serverNeedsIngressReconcile(
  serverId: string,
  params: {
    preparedByServer: readonly PreparedServerDeploy[];
    attachments: readonly PlatformAttachment[];
    consumers: readonly ManagedIngressConsumer[];
    spanning: ReadonlyMap<string, string>;
    segmentsByServer: Map<string, FabricSegmentMaterial[]>;
    listenerNames: Map<string, string>;
  },
): boolean {
  const prepared = params.preparedByServer.find((row) =>
    row.serverId === serverId
  );
  const hosts = reservedIngressHostsForServer({
    thisServerId: serverId,
    attachments: params.attachments,
    consumers: params.consumers,
    spanning: params.spanning,
    segmentsByServer: params.segmentsByServer,
    listenerNameByServer: params.listenerNames,
  });
  const managedCount = prepared?.prepared.managedNetworkServices.length ?? 0;
  return managedCount > 0 || hosts.size > 0;
}

export function ingressServerIdsForDeploy(params: {
  planServerIds: readonly string[];
  preparedByServer: readonly PreparedServerDeploy[];
  attachments: readonly PlatformAttachment[];
  consumers: readonly ManagedIngressConsumer[];
  spanning: ReadonlyMap<string, string>;
  segmentsByServer: Map<string, FabricSegmentMaterial[]>;
  listenerNames: Map<string, string>;
  releasedListeners: readonly string[];
}): Set<string> {
  const ingressServerIds = new Set<string>([
    ...attachmentServerIds(params.attachments),
    ...params.releasedListeners,
  ]);
  for (const serverId of params.planServerIds) {
    if (serverNeedsIngressReconcile(serverId, params)) {
      ingressServerIds.add(serverId);
    }
  }
  return ingressServerIds;
}

async function enqueueIngressReconcileAfterDeploy(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  params: {
    auth: DeployRequestAuth;
    dataEncryptionSecrets: DerivedSecretsConfig;
    planServerIds: readonly string[];
    preparedByServer: readonly PreparedServerDeploy[];
    releasedListeners: readonly string[];
  } & DeploySpanningContext,
): Promise<void> {
  const secretsConfig = c.get("secretsConfig");
  if (!secretsConfig) return;

  const ingressServerIds = ingressServerIdsForDeploy({
    planServerIds: params.planServerIds,
    preparedByServer: params.preparedByServer,
    attachments: params.attachments,
    consumers: params.consumers,
    spanning: params.spanning,
    segmentsByServer: params.enriched.segmentsByServer,
    listenerNames: params.listenerNames,
    releasedListeners: params.releasedListeners,
  });
  for (const serverId of ingressServerIds) {
    await enqueueManagedIngressReconcile(db, commandQueue, {
      serverId,
      actorType: "user",
      actorId: params.auth.userId,
      secretsConfig,
      dataEncryptionSecrets: params.dataEncryptionSecrets,
    });
  }
}

async function loadDeploySpanningContext(
  db: Db,
  planned: SuccessfulPlannedDeploy,
  organizationId: string,
  environmentId: string,
): Promise<DeploySpanningContext> {
  const { spanning, attachments, consumers } = await loadSpanningNetworks(
    db,
    planned,
    organizationId,
    environmentId,
  );
  const enriched = await enrichPlannedTaskAddresses(
    db,
    planned,
    spanning,
    environmentId,
    attachmentServerIds(attachments),
  );
  const listenerNames = await listenerNamesForAttachments(
    db,
    organizationId,
    attachments,
  );
  return { spanning, attachments, consumers, enriched, listenerNames };
}

async function runEnvironmentDeploy(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  environmentId: string,
  auth: DeployRequestAuth,
): Promise<Response> {
  const planned = await resolveSuccessfulPlan(
    c,
    db,
    environmentId,
    auth.organizationId,
  );
  if (planned instanceof Response) return planned;

  const priorNetworks = await listEnvironmentComposeNetworks(
    db,
    environmentId,
  );
  let spanningCommitted = false;
  try {
    const spanningCtx = await loadDeploySpanningContext(
      db,
      planned,
      auth.organizationId,
      environmentId,
    );
    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (!dataEncryptionSecrets) {
      return c.json({ error: "Encryption unavailable" }, 503);
    }

    const fabricGateError = await awaitDeployFabricGate(c, db, commandQueue, {
      planned,
      auth,
      attachments: spanningCtx.attachments,
      dataEncryptionSecrets,
    });
    if (fabricGateError) return fabricGateError;

    const preparedByServer = await prepareAllServerDeploys(c, db, {
      planned,
      environmentId,
      auth,
      dataEncryptionSecrets,
      ...spanningCtx,
    });
    if (preparedByServer instanceof Response) return preparedByServer;

    const previous = await listEnvironmentDeploymentTargets(
      db,
      environmentId,
    );
    const { attachmentServers, participating, drainedIds } = deployParticipation(
      {
        planServerIds: planned.plan.serverIds,
        attachments: spanningCtx.attachments,
        previous,
      },
    );
    const projectName = composeProjectName(planned.projectId);
    const created = await persistDeployFanOut(db, {
      preparedByServer,
      planServerIds: planned.plan.serverIds,
      drainedIds,
      userId: auth.userId,
      environmentId,
      projectId: planned.projectId,
      organizationId: auth.organizationId,
      projectName,
      tasks: spanningCtx.enriched.tasks,
      noCache: auth.noCache,
    });
    spanningCommitted = true;
    const { queued, enqueueError } = await deliverDeployFanOut(
      db,
      commandQueue,
      { created, environmentId },
    );
    if (queued.length === 0 && enqueueError) return enqueueError;

    const drainedError = await stopDrainedDeployments(db, commandQueue, {
      drainedIds,
      attachmentServers,
      userId: auth.userId,
      environmentId,
      projectId: planned.projectId,
      projectName,
    });
    if (drainedError) return drainedError;

    const releasedListeners = await releaseOrphanedComposeNetworks(
      db,
      environmentId,
      participating,
    );
    await enqueueIngressReconcileAfterDeploy(c, db, commandQueue, {
      auth,
      dataEncryptionSecrets,
      planServerIds: planned.plan.serverIds,
      preparedByServer,
      releasedListeners,
      ...spanningCtx,
    });

    return Response.json(queuedCommandsResponseBody(queued));
  } finally {
    if (!spanningCommitted) {
      await purgeComposeNetworksCreatedAfter(
        db,
        environmentId,
        priorNetworks,
      );
    }
  }
}

export function registerEnvironmentDeployRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError(
      "session secrets are required for environment deploy routes",
    );
  }
  router.use("/environments/:id/deploy", createSessionMiddleware(opts.secrets));

  router.post("/environments/:id/deploy", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const environmentId = c.req.param("id");
    const auth = await authorizeDeployRequest(c, db, environmentId);
    if (auth instanceof Response) return auth;

    const commandQueue = assertDispatchInfrastructure(c);
    if (commandQueue instanceof Response) return commandQueue;

    return runEnvironmentDeploy(c, db, commandQueue, environmentId, auth);
  });
}

async function loadLifecycleTargets(
  db: Db,
  environmentId: string,
): Promise<
  | {
    projectId: string;
    projectName: string;
    serverIds: string[];
  }
  | Response
> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      serverId: environment.serverId,
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

  const deployments = await listEnvironmentDeploymentTargets(db, environmentId);
  const fromDeployments = [
    ...new Set(
      deployments
        .filter((row) => row.status !== "draining")
        .map((row) => row.serverId),
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (fromDeployments.length > 0) {
    return {
      projectId: projectRow.id,
      projectName: composeProjectName(projectRow.id),
      serverIds: fromDeployments,
    };
  }

  const pin = resolveEffectivePlacementServerId(
    envRow.serverId,
    parseProjectOptions(projectRow.options),
  );
  if (!pin) {
    return Response.json({ error: "server_placement_required" }, {
      status: 409,
    });
  }
  return {
    projectId: projectRow.id,
    projectName: composeProjectName(projectRow.id),
    serverIds: [pin],
  };
}

async function enqueueStopCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    serverId: string;
    userId: string;
    environmentId: string;
    projectId: string;
    projectName: string;
    ingressServices: Array<{ serviceId: string }>;
    fabricNetworks: string[];
  },
): Promise<QueuedCommandRef | Response> {
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: "user",
    actorId: params.userId,
    type: "environment.stop",
    payload: {
      environmentId: params.environmentId,
      projectId: params.projectId,
      projectName: params.projectName,
      ...(params.ingressServices.length > 0
        ? { ingressServices: params.ingressServices }
        : {}),
      ...(params.fabricNetworks.length > 0
        ? { fabricNetworks: params.fabricNetworks }
        : {}),
    },
    expiresAt,
  });

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: "environment.stop",
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  };

  try {
    await commandQueue.enqueue(envelope);
  } catch {
    await transitionCommand(db, record.id, {
      status: "failed",
      error: "Command queue unavailable",
    });
    return Response.json({ error: "Command queue unavailable" }, {
      status: 503,
    });
  }

  return {
    commandId: record.id,
    serverId: params.serverId,
    status: "queued",
  };
}

/**
 * Register `POST /environments/:id/stop` — compose down (+ volumes) teardown.
 * Status is polled via existing `GET /servers/:serverId/commands/:commandId`.
 */
export function registerEnvironmentStopRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError(
      "session secrets are required for environment stop routes",
    );
  }
  router.use("/environments/:id/stop", createSessionMiddleware(opts.secrets));

  router.post("/environments/:id/stop", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const environmentId = c.req.param("id");
    const auth = await authorizeEnvironmentManage(c, db, environmentId);
    if (auth instanceof Response) return auth;

    const commandQueue = assertDispatchInfrastructure(c);
    if (commandQueue instanceof Response) return commandQueue;

    const loaded = await loadLifecycleTargets(db, environmentId);
    if (loaded instanceof Response) return loaded;

    const tcpUdpServices = await resolveTcpUdpIngressServices(
      db,
      environmentId,
    );
    const composeNetworks = await listEnvironmentComposeNetworks(
      db,
      environmentId,
    );
    const namesByServer = composeNetworkNamesByServer(composeNetworks);
    const queued: QueuedCommandRef[] = [];
    for (const serverId of loaded.serverIds) {
      const enqueued = await enqueueStopCommand(db, commandQueue, {
        serverId,
        userId: auth.userId,
        environmentId,
        projectId: loaded.projectId,
        projectName: loaded.projectName,
        ingressServices: tcpUdpServices.map((svc) => ({
          serviceId: svc.serviceId,
        })),
        fabricNetworks: namesByServer.get(serverId) ?? [],
      });
      if (enqueued instanceof Response) return enqueued;
      queued.push(enqueued);
    }
    await purgeEnvironmentComposeNetworks(db, environmentId);
    const secretsConfig = c.get("secretsConfig");
    const dataEncryptionSecrets = c.get("dataEncryptionSecrets");
    if (secretsConfig && dataEncryptionSecrets) {
      const ingressServerIds = new Set<string>([
        ...loaded.serverIds,
        ...namesByServer.keys(),
      ]);
      for (const serverId of ingressServerIds) {
        await enqueueManagedIngressReconcile(db, commandQueue, {
          serverId,
          actorType: "user",
          actorId: auth.userId,
          secretsConfig,
          dataEncryptionSecrets,
        });
      }
    }
    return Response.json(queuedCommandsResponseBody(queued));
  });
}

async function enqueueLifecycleCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    serverId: string;
    userId: string;
    environmentId: string;
    projectId: string;
    projectName: string;
    action: EnvironmentLifecycleAction;
  },
): Promise<QueuedCommandRef | Response> {
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: "user",
    actorId: params.userId,
    type: "environment.lifecycle",
    payload: {
      environmentId: params.environmentId,
      projectId: params.projectId,
      projectName: params.projectName,
      action: params.action,
    },
    expiresAt,
  });

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: "environment.lifecycle",
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  };

  try {
    await commandQueue.enqueue(envelope);
  } catch {
    await transitionCommand(db, record.id, {
      status: "failed",
      error: "Command queue unavailable",
    });
    return Response.json({ error: "Command queue unavailable" }, {
      status: 503,
    });
  }

  return {
    commandId: record.id,
    serverId: params.serverId,
    status: "queued",
  };
}

/**
 * Register `POST /environments/:id/lifecycle` — non-destructive compose
 * start|stop|restart. Status is polled via existing command GET.
 */
export function registerEnvironmentLifecycleRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError(
      "session secrets are required for environment lifecycle routes",
    );
  }
  router.use(
    "/environments/:id/lifecycle",
    createSessionMiddleware(opts.secrets),
  );

  router.post("/environments/:id/lifecycle", async (c) => {
    const db = getDb(c);
    if (!db) return c.json({ error: "Database unavailable" }, 503);

    const environmentId = c.req.param("id");
    const auth = await authorizeEnvironmentManage(c, db, environmentId);
    if (auth instanceof Response) return auth;

    const body = await parseJsonBody(c);
    if (body instanceof Response) return body;

    const action = parseLifecycleAction(body);
    if (action === "invalid") {
      return c.json({ error: "Invalid request" }, 400);
    }

    const commandQueue = assertDispatchInfrastructure(c);
    if (commandQueue instanceof Response) return commandQueue;

    const loaded = await loadLifecycleTargets(db, environmentId);
    if (loaded instanceof Response) return loaded;

    const queued: QueuedCommandRef[] = [];
    for (const serverId of loaded.serverIds) {
      const enqueued = await enqueueLifecycleCommand(db, commandQueue, {
        serverId,
        userId: auth.userId,
        environmentId,
        projectId: loaded.projectId,
        projectName: loaded.projectName,
        action,
      });
      if (enqueued instanceof Response) return enqueued;
      queued.push(enqueued);
    }
    return Response.json(queuedCommandsResponseBody(queued));
  });
}
