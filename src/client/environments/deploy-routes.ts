import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  ENVELOPE_MAGIC,
  resealSecretForDaemon,
} from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import {
  prepareDeployCompose,
  readHostingProxyFromOptions,
  resolveHostingBindAddress,
  type DeployPrepareError,
  type DeployScheduleSlice,
  type PreparedDeployCompose,
} from './deploy-prepare.ts'
import {
  resolveHostingDeployWeb,
} from '../../lib/hosting-web-env.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type {
  EnvironmentDeployComposeFile,
  EnvironmentDeployHosting,
  EnvironmentDeployIngressService,
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeployServiceHook,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeployTlsMaterial,
  EnvironmentDeployTraditionalWebSite,
  EnvironmentDeployVariableMaterial,
  EnvironmentLifecycleAction,
} from '../../lib/commands/schemas.ts'
import {
  buildDeployPreviewContainers,
  buildTraditionalWebSitesForDeploy,
  composeProjectName,
  expandHostingsForComposeInstances,
  mapPrepareErrorResponse,
  parseDeployRequestFlags,
  parseLifecycleAction,
  readHostnames,
  readHostingPorts,
  readHostingProtocol,
  readPathPrefix,
  readTargetPort,
  tlsPinErrorCode,
  validateDeployMaterials,
} from './deploy-routes-helpers.ts'
import { resolveTcpUdpIngressServices } from './tcp-udp-ingress.ts'
import { isNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
import { getCommandQueue, type CommandQueue } from '../../lib/commands/queue.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import { bumpEnvironmentGeneration } from '../../lib/db/environment-generation.ts'
import {
  listEnvironmentDeploymentTargets,
  markDeploymentFailed,
  pruneDrainedDeployments,
  upsertDeploymentTargets,
} from '../../lib/db/deployment-records.ts'
import { replaceEnvironmentTasks } from '../../lib/db/task-records.ts'
import {
  getOrganizationFabric,
  materializeSpanningNetworks,
} from '../../lib/db/fabric-records.ts'
import { enqueueFabricReconcileForServers } from '../../lib/fabric/enqueue.ts'
import {
  planEnvironmentDeploy,
  type PlannedDeploy,
  type ScheduleErrorCode,
} from '../../lib/schedule/index.ts'
import {
  environment,
  hosting,
  project,
  server,
  service,
  tls,
} from '../../lib/db/schema.ts'
import {
  assembleTlsMetadata,
  parseTlsOptions,
  resolveTlsForHosting,
  type TlsCandidate,
} from '../../lib/tls/index.ts'
import { getDaemonCellRegistry, getDb, type Db } from '../../db.ts'
import {
  assertCanManageOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from '../../lib/project-options.ts'

type DeployHostingPayload = EnvironmentDeployHosting

type QueuedCommandRef = {
  commandId: string
  serverId: string
  status: 'queued'
}

function responseForScheduleError(
  c: Context<AppEnv>,
  error: ScheduleErrorCode,
  message: string,
): Response {
  if (error === 'no_eligible_server') {
    return c.json({ error: 'server_placement_required' }, 409)
  }
  return c.json({ error, message }, 422)
}

function serviceIdToNameMap(
  rows: ReadonlyArray<{ id: string; composeServiceName: string }>,
): Map<string, string> {
  return new Map(rows.map((row) => [row.id, row.composeServiceName]))
}

function scheduleSliceForServer(
  planned: PlannedDeploy,
  serverId: string,
  spanning: ReadonlyMap<string, string> | undefined,
): DeployScheduleSlice {
  const tasks = planned.plan.ok ? planned.plan.tasks : []
  return {
    serverId,
    tasks,
    serviceIdToName: serviceIdToNameMap(planned.serviceRows),
    ...(spanning && spanning.size > 0 ? { spanningNetworks: spanning } : {}),
  }
}

function queuedCommandsJson(commands: readonly QueuedCommandRef[]): Record<string, unknown> {
  const first = commands[0]
  return {
    ok: true as const,
    commandId: first?.commandId ?? '',
    status: 'queued' as const,
    ...(first ? { serverId: first.serverId } : {}),
    commands: commands.map((row) => ({
      commandId: row.commandId,
      serverId: row.serverId,
      status: row.status,
    })),
  }
}

async function loadSpanningNetworks(
  db: Db,
  planned: PlannedDeploy,
  organizationId: string,
  environmentId: string,
): Promise<Map<string, string>> {
  if (!planned.plan.ok || planned.plan.serverIds.length <= 1 || !planned.fabricEnabled) {
    return new Map()
  }
  const fabricRow = await getOrganizationFabric(db, organizationId)
  if (!fabricRow) return new Map()
  return await materializeSpanningNetworks(db, {
    organizationId,
    environmentId,
    fabric: fabricRow,
    document: planned.merged,
    tasks: planned.plan.tasks,
    serviceRows: planned.serviceRows,
  })
}

function assertDispatchInfrastructure(c: Context<AppEnv>): CommandQueue | Response {
  const registry = getDaemonCellRegistry(c)
  if (!registry) {
    return c.json({ error: 'Daemon cell registry unavailable' }, 503)
  }

  const commandQueue = getCommandQueue(c)
  if (!commandQueue || isNoopCommandQueue(commandQueue)) {
    return c.json({ error: 'Command queue unavailable' }, 503)
  }

  return commandQueue
}

function responseForPrepareError(
  c: Context<AppEnv>,
  prepared: DeployPrepareError,
): Response {
  const mapped = mapPrepareErrorResponse(prepared)
  return c.json(mapped.body, { status: mapped.status as 400 | 409 | 422 })
}

function validateDeployMaterialsResponse(
  hostings: DeployHostingPayload[],
  storageMaterial: EnvironmentDeployStorageMaterial[],
): Response | null {
  const validationError = validateDeployMaterials(hostings, storageMaterial)
  if (!validationError) return null
  return Response.json(
    { error: validationError.error, message: validationError.message },
    { status: 400 },
  )
}

type BuildHostingResult =
  | {
    hostings: DeployHostingPayload[]
    resolvedTlsIds: string[]
  }
  | { error: Response }
  | { prepareError: DeployPrepareError }

type OrgTlsCandidate = TlsCandidate & {
  certificatePem: string | null
  privateKeyPem: string | null
}

type ServiceRow = {
  id: string
  composeServiceName: string
}

type HostingRow = {
  id: string
  options: unknown
  tlsId: string | null
  ipId: string | null
}

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
  const hostnames = readHostnames(h.options)
  if (hostnames.length === 0) return { skip: true }

  const resolved = resolveTlsForHosting({
    pinId: h.tlsId,
    hostnames,
    candidates,
  })
  if (!resolved.ok) {
    return {
      error: Response.json(
        { error: tlsPinErrorCode(resolved.error), hostingId: h.id },
        { status: 400 },
      ),
    }
  }

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId,
    options: h.options,
    ipId: h.ipId,
  })
  if (typeof bindResolved === 'object' && bindResolved !== null && 'kind' in bindResolved) {
    return { prepareError: bindResolved }
  }

  const web = await resolveHostingDeployWeb(db, dataEncryptionSecrets, h.id, h.options)

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
  }
}

/**
 * `tcp` / `udp` hosting publishes raw port(s) straight through Traefik — no
 * hostname/TLS routing, used for non-HTTP docker services (e.g. Postgres).
 */
async function resolveTcpUdpHostingEntry(
  db: Db,
  h: HostingRow,
  svc: Readonly<{ id: string; composeServiceName: string }>,
  protocol: 'tcp' | 'udp',
  serverId: string,
): Promise<
  | { entry: DeployHostingPayload }
  | { skip: true }
  | { prepareError: DeployPrepareError }
> {
  const ports = readHostingPorts(h.options)
  if (ports.length === 0) return { skip: true }

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId,
    options: h.options,
    ipId: h.ipId,
  })
  if (typeof bindResolved === 'object' && bindResolved !== null && 'kind' in bindResolved) {
    return { prepareError: bindResolved }
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
  }
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
  const protocol = readHostingProtocol(h.options)
  if (protocol === 'http') {
    return resolveHttpHostingEntry(db, dataEncryptionSecrets, h, svc, candidates, serverId)
  }
  return resolveTcpUdpHostingEntry(db, h, svc, protocol, serverId)
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
    .where(eq(tls.organizationId, organizationId))

  const out: OrgTlsCandidate[] = []
  for (const row of rows) {
    const metadata = assembleTlsMetadata(
      {
        status: row.status,
        notAfter: row.notAfter,
        fingerprintSha256: row.fingerprintSha256,
      },
      row.metadata,
    )
    if (!metadata) continue
    out.push({
      id: row.id,
      metadata,
      options: parseTlsOptions(row.options),
      certificatePem: row.certificatePem,
      privateKeyPem: row.privateKeyPem,
    })
  }
  return out
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
  const composeServiceName = svc.composeServiceName
  const hostingRows = await db
    .select({
      id: hosting.id,
      options: hosting.options,
      tlsId: hosting.tlsId,
      ipId: hosting.ipId,
    })
    .from(hosting)
    .where(eq(hosting.serviceId, svc.id))

  const hostings: DeployHostingPayload[] = []
  const tlsIds: string[] = []
  for (const h of hostingRows) {
    const result = await resolveHostingEntry(
      db,
      dataEncryptionSecrets,
      h,
      { id: svc.id, composeServiceName },
      candidates,
      serverId,
    )
    if ('skip' in result) continue
    if ('error' in result) return result
    if ('prepareError' in result) return result
    hostings.push(result.entry)
    if (result.entry.tlsId) tlsIds.push(result.entry.tlsId)
  }
  return { hostings, tlsIds }
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
    .where(eq(service.environmentId, environmentId))

  const candidates = await loadOrgTlsCandidates(db, organizationId)
  const hostingPayload: DeployHostingPayload[] = []
  const resolvedTlsIds = new Set<string>()

  for (const svc of serviceRows) {
    const built = await buildHostingsForService(
      db,
      dataEncryptionSecrets,
      svc,
      candidates,
      serverId,
    )
    if ('error' in built) return built
    if ('prepareError' in built) return built
    hostingPayload.push(...built.hostings)
    for (const tlsId of built.tlsIds) resolvedTlsIds.add(tlsId)
  }

  return { hostings: hostingPayload, resolvedTlsIds: [...resolvedTlsIds] }
}

async function sealTlsMaterialForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  organizationId: string,
  tlsIds: string[],
): Promise<EnvironmentDeployTlsMaterial[] | Response> {
  if (tlsIds.length === 0) return []

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const secretsConfig = c.get('secretsConfig')
  if (!dataEncryptionSecrets || !secretsConfig) {
    return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return c.json({ error: 'No encryption-capable daemon key on target server' }, 422)
  }
  const keyId = daemonState.key.id

  const rows = await db
    .select({
      id: tls.id,
      certificatePem: tls.certificatePem,
      privateKeyPem: tls.privateKeyPem,
      organizationId: tls.organizationId,
    })
    .from(tls)
    .where(and(eq(tls.organizationId, organizationId)))

  const byId = new Map(rows.map((row) => [row.id, row]))
  const material: EnvironmentDeployTlsMaterial[] = []

  for (const tlsId of tlsIds) {
    const row = byId.get(tlsId)
    if (!row?.certificatePem || !row.privateKeyPem) {
      return c.json({ error: 'tls_material_missing', tlsId }, 400)
    }
    // Refuse plaintext / non-tpsecret rows — keys must be sealed at rest.
    if (
      !row.privateKeyPem.startsWith(`${ENVELOPE_MAGIC}.`) ||
      row.privateKeyPem.includes('BEGIN')
    ) {
      return c.json({ error: 'tls_key_not_sealed', tlsId }, 500)
    }
    let privateKeyEnvelope: string
    try {
      privateKeyEnvelope = await resealSecretForDaemon(
        secretsConfig,
        dataEncryptionSecrets,
        { serverId, keyId },
        row.privateKeyPem,
      )
    } catch {
      return c.json({ error: 'tls_decrypt_failed', tlsId }, 500)
    }
    material.push({
      tlsId,
      certificatePem: row.certificatePem,
      privateKeyEnvelope,
    })
  }

  return material
}

async function authorizeDeployRequest(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
): Promise<{
  userId: string
  organizationId: string
  acknowledgeHealthCheckWarnings: boolean
  noCache: boolean
} | Response> {
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  const entityOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
  if (!entityOrgId || entityOrgId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied = await assertCanManageOr403(c, 'environment', environmentId)
  if (denied) return denied

  const immutable = await assertNotSystemOwnedOr403(c, 'environment', environmentId)
  if (immutable) return immutable

  const body = await parseJsonBody(c)
  if (body instanceof Response) return body

  const flags = parseDeployRequestFlags(body)
  if (flags === 'invalid') {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return {
    userId: session.userId,
    organizationId: orgResult,
    acknowledgeHealthCheckWarnings: flags.acknowledgeHealthCheckWarnings,
    noCache: flags.noCache,
  }
}

async function enqueueDeployCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    serverId: string
    userId: string
    environmentId: string
    projectId: string
    organizationId: string
    projectName: string
    composeYaml: string
    composeFiles: EnvironmentDeployComposeFile[]
    hostings: DeployHostingPayload[]
    traditionalWebSites: EnvironmentDeployTraditionalWebSite[]
    ingressServices: EnvironmentDeployIngressService[]
    tlsMaterial: EnvironmentDeployTlsMaterial[]
    variableMaterial: EnvironmentDeployVariableMaterial[]
    storageMaterial: EnvironmentDeployStorageMaterial[]
    principalMaterial: EnvironmentDeployPrincipalMaterial[]
    serviceHooks: EnvironmentDeployServiceHook[]
    dockerExternalNetworks: string[]
    managedNetworkServices: string[]
    noCache: boolean
    generation: number
    desiredHash: string
    replicaCounts: Record<string, number>
  },
): Promise<QueuedCommandRef | Response> {
  const expiresAt = new Date(Date.now() + 600_000).toISOString()
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: 'user',
    actorId: params.userId,
    type: 'environment.deploy',
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
      ...(params.tlsMaterial.length > 0 ? { tlsMaterial: params.tlsMaterial } : {}),
      ...(params.variableMaterial.length > 0 ? { variableMaterial: params.variableMaterial } : {}),
      ...(params.storageMaterial.length > 0 ? { storageMaterial: params.storageMaterial } : {}),
      ...(params.principalMaterial.length > 0 ? { principalMaterial: params.principalMaterial } : {}),
      ...(params.serviceHooks.length > 0 ? { serviceHooks: params.serviceHooks } : {}),
      ...(params.dockerExternalNetworks.length > 0
        ? { dockerExternalNetworks: params.dockerExternalNetworks }
        : {}),
      ...(params.managedNetworkServices.length > 0
        ? { managedNetworkServices: params.managedNetworkServices }
        : {}),
      ...(params.noCache ? { noCache: true } : {}),
    },
    expiresAt,
  })

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: 'environment.deploy',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }

  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    await markDeploymentFailed(db, {
      environmentId: params.environmentId,
      serverId: params.serverId,
      error: 'Command queue unavailable',
      commandId: record.id,
    })
    return Response.json({ error: 'Command queue unavailable' }, { status: 503 })
  }

  return {
    commandId: record.id,
    serverId: params.serverId,
    status: 'queued',
  }
}

export {
  buildTraditionalWebSitesForDeploy,
  expandHostingsForComposeInstances,
  preferredListenPortsFromHostings,
  readHostnames,
  readHostingPorts,
  readHostingProtocol,
  readPathPrefix,
  readTargetPort,
  validateDeployMaterials,
} from './deploy-routes-helpers.ts'

async function authorizeEnvironmentManage(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
): Promise<{ userId: string; organizationId: string } | Response> {
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  const entityOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
  if (!entityOrgId || entityOrgId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied = await assertCanManageOr403(c, 'environment', environmentId)
  if (denied) return denied

  const immutable = await assertNotSystemOwnedOr403(c, 'environment', environmentId)
  if (immutable) return immutable

  return {
    userId: session.userId,
    organizationId: orgResult,
  }
}

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
    throw new TypeError('session secrets are required for environment deploy-preview routes')
  }
  router.use('/environments/:id/deploy-preview', createSessionMiddleware(opts.secrets))

  router.get('/environments/:id/deploy-preview', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeEnvironmentManage(c, db, environmentId)
    if (auth instanceof Response) return auth

    const planned = await planEnvironmentDeploy(db, {
      environmentId,
      organizationId: auth.organizationId,
    })
    if ('kind' in planned) {
      if (planned.kind === 'not_found') return c.json({ error: 'Not found' }, 404)
      return c.json({ error: 'Invalid compose document' }, 400)
    }
    if (!planned.plan.ok) {
      return responseForScheduleError(c, planned.plan.error, planned.plan.message)
    }

    const spanning = await loadSpanningNetworks(
      db,
      planned,
      auth.organizationId,
      environmentId,
    )
    const preparedByServer: Array<{
      serverId: string
      prepared: PreparedDeployCompose
    }> = []
    for (const serverId of planned.plan.serverIds) {
      const prepared = await prepareDeployCompose(c, db, {
        environmentId,
        serverId,
        organizationId: auth.organizationId,
        mode: 'preview',
        schedule: scheduleSliceForServer(planned, serverId, spanning),
      })
      if (prepared instanceof Response) return prepared
      if ('kind' in prepared) {
        return responseForPrepareError(c, prepared)
      }
      preparedByServer.push({ serverId, prepared })
    }

    const first = preparedByServer[0]
    const serverRows = planned.plan.serverIds.length === 0
      ? []
      : await db
        .select({ id: server.id, name: server.name })
        .from(server)
        .where(inArray(server.id, planned.plan.serverIds))
    const nameById = new Map(serverRows.map((row) => [row.id, row.name]))
    const projectName = composeProjectName(planned.projectId)
    const ingress = preparedByServer.flatMap((row) => row.prepared.ingressServices)
    const appContainers = first?.prepared.containers ?? []

    return c.json({
      ok: true as const,
      composeYaml: first?.prepared.composeYaml ?? '',
      composeFiles: first?.prepared.composeFiles ?? [],
      projectName,
      servers: preparedByServer.map((row) => ({
        serverId: row.serverId,
        displayName: nameById.get(row.serverId) ?? row.serverId,
        composeYaml: row.prepared.composeYaml,
        services: Object.keys(row.prepared.replicaCounts).sort((a, b) =>
          a.localeCompare(b),
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
      envFile: first?.prepared.envFile ?? '',
      secretPlan: first?.prepared.secretPlan ?? [],
    })
  })
}

export function registerEnvironmentDeployRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment deploy routes')
  }
  router.use('/environments/:id/deploy', createSessionMiddleware(opts.secrets))

  router.post('/environments/:id/deploy', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeDeployRequest(c, db, environmentId)
    if (auth instanceof Response) return auth

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const planned = await planEnvironmentDeploy(db, {
      environmentId,
      organizationId: auth.organizationId,
    })
    if ('kind' in planned) {
      if (planned.kind === 'not_found') return c.json({ error: 'Not found' }, 404)
      return c.json({ error: 'Invalid compose document' }, 400)
    }
    if (!planned.plan.ok) {
      return responseForScheduleError(c, planned.plan.error, planned.plan.message)
    }

    const spanning = await loadSpanningNetworks(
      db,
      planned,
      auth.organizationId,
      environmentId,
    )
    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const preparedByServer: Array<{
      serverId: string
      prepared: PreparedDeployCompose
      hostings: DeployHostingPayload[]
      tlsMaterial: EnvironmentDeployTlsMaterial[]
    }> = []
    for (const serverId of planned.plan.serverIds) {
      const prepared = await prepareDeployCompose(c, db, {
        environmentId,
        serverId,
        organizationId: auth.organizationId,
        acknowledgeHealthCheckWarnings: auth.acknowledgeHealthCheckWarnings,
        schedule: scheduleSliceForServer(planned, serverId, spanning),
      })
      if (prepared instanceof Response) return prepared
      if ('kind' in prepared) return responseForPrepareError(c, prepared)

      const hostingBuilt = await buildHostingPayload(
        db,
        environmentId,
        auth.organizationId,
        serverId,
        dataEncryptionSecrets,
      )
      if ('prepareError' in hostingBuilt) {
        return responseForPrepareError(c, hostingBuilt.prepareError)
      }
      if ('error' in hostingBuilt) return hostingBuilt.error

      const hostings = expandHostingsForComposeInstances(
        hostingBuilt.hostings,
        prepared.composeServiceExpansion,
      )
      const tlsMaterial = await sealTlsMaterialForDaemon(
        c,
        db,
        serverId,
        auth.organizationId,
        hostingBuilt.resolvedTlsIds,
      )
      if (tlsMaterial instanceof Response) return tlsMaterial

      const materialsError = validateDeployMaterialsResponse(
        hostings,
        prepared.storageMaterial,
      )
      if (materialsError) return materialsError

      preparedByServer.push({ serverId, prepared, hostings, tlsMaterial })
    }

    const previous = await listEnvironmentDeploymentTargets(db, environmentId)
    const activeIds = new Set(planned.plan.serverIds)
    const drainedIds = previous
      .map((row) => row.serverId)
      .filter((serverId) => !activeIds.has(serverId))

    const generation = await bumpEnvironmentGeneration(db, environmentId)
    await replaceEnvironmentTasks(db, {
      environmentId,
      generation,
      tasks: planned.plan.tasks,
    })

    if (planned.fabricEnabled && planned.plan.serverIds.length > 1) {
      const fabricRow = await getOrganizationFabric(db, auth.organizationId)
      if (fabricRow) {
        await enqueueFabricReconcileForServers({
          db,
          commandQueue,
          actorType: 'user',
          actorId: auth.userId,
          fabric: fabricRow,
          serverIds: planned.plan.serverIds,
          enabled: true,
        })
      }
    }

    const projectName = composeProjectName(planned.projectId)
    const queued: QueuedCommandRef[] = []
    for (const row of preparedByServer) {
      const enqueued = await enqueueDeployCommand(db, commandQueue, {
        serverId: row.serverId,
        userId: auth.userId,
        environmentId,
        projectId: planned.projectId,
        organizationId: auth.organizationId,
        projectName,
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
        envFile: row.prepared.envFile,
        secretPlan: row.prepared.secretPlan,
        storageMaterial: row.prepared.storageMaterial,
        principalMaterial: row.prepared.principalMaterial,
        serviceHooks: row.prepared.hooks,
        dockerExternalNetworks: row.prepared.dockerExternalNetworks,
        managedNetworkServices: row.prepared.managedNetworkServices,
        noCache: auth.noCache,
        generation,
        desiredHash: row.prepared.desiredHash,
        replicaCounts: row.prepared.replicaCounts,
      })
      if (enqueued instanceof Response) return enqueued
      queued.push(enqueued)
    }

    const hashByServer = new Map(
      preparedByServer.map((row) => [row.serverId, row.prepared.desiredHash]),
    )
    const commandByServer = new Map(queued.map((row) => [row.serverId, row.commandId]))
    await upsertDeploymentTargets(db, {
      environmentId,
      targets: [
        ...planned.plan.serverIds.map((serverId) => ({
          serverId,
          desiredGeneration: generation,
          desiredHash: hashByServer.get(serverId) ?? null,
          status: 'applying' as const,
          lastCommandId: commandByServer.get(serverId) ?? null,
          options: {
            secretPlan: preparedByServer.find((row) => row.serverId === serverId)
              ?.prepared.secretPlan ?? [],
          },
        })),
        ...drainedIds.map((serverId) => ({
          serverId,
          desiredGeneration: generation,
          status: 'draining' as const,
        })),
      ],
    })

    if (drainedIds.length > 0) {
      const tcpUdpServices = await resolveTcpUdpIngressServices(db, environmentId)
      for (const serverId of drainedIds) {
        const stopped = await enqueueStopCommand(db, commandQueue, {
          serverId,
          userId: auth.userId,
          environmentId,
          projectId: planned.projectId,
          projectName,
          ingressServices: tcpUdpServices.map((svc) => ({ serviceId: svc.serviceId })),
        })
        if (stopped instanceof Response) return stopped
      }
      await pruneDrainedDeployments(db, { environmentId, serverIds: drainedIds })
    }

    return Response.json(queuedCommandsJson(queued))
  })
}

async function loadLifecycleTargets(
  db: Db,
  environmentId: string,
): Promise<
  | {
    projectId: string
    projectName: string
    serverIds: string[]
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
    .limit(1)
  if (!envRow) return Response.json({ error: 'Not found' }, { status: 404 })

  const [projectRow] = await db
    .select({
      id: project.id,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return Response.json({ error: 'Not found' }, { status: 404 })

  const deployments = await listEnvironmentDeploymentTargets(db, environmentId)
  const fromDeployments = [...new Set(
    deployments
      .filter((row) => row.status !== 'draining')
      .map((row) => row.serverId),
  )].sort((a, b) => a.localeCompare(b))
  if (fromDeployments.length > 0) {
    return {
      projectId: projectRow.id,
      projectName: composeProjectName(projectRow.id),
      serverIds: fromDeployments,
    }
  }

  const pin = resolveEffectivePlacementServerId(
    envRow.serverId,
    parseProjectOptions(projectRow.options),
  )
  if (!pin) {
    return Response.json({ error: 'server_placement_required' }, { status: 409 })
  }
  return {
    projectId: projectRow.id,
    projectName: composeProjectName(projectRow.id),
    serverIds: [pin],
  }
}

async function enqueueStopCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    serverId: string
    userId: string
    environmentId: string
    projectId: string
    projectName: string
    ingressServices: Array<{ serviceId: string }>
  },
): Promise<QueuedCommandRef | Response> {
  const expiresAt = new Date(Date.now() + 120_000).toISOString()
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: 'user',
    actorId: params.userId,
    type: 'environment.stop',
    payload: {
      environmentId: params.environmentId,
      projectId: params.projectId,
      projectName: params.projectName,
      ...(params.ingressServices.length > 0
        ? { ingressServices: params.ingressServices }
        : {}),
    },
    expiresAt,
  })

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: 'environment.stop',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }

  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return Response.json({ error: 'Command queue unavailable' }, { status: 503 })
  }

  return {
    commandId: record.id,
    serverId: params.serverId,
    status: 'queued',
  }
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
    throw new TypeError('session secrets are required for environment stop routes')
  }
  router.use('/environments/:id/stop', createSessionMiddleware(opts.secrets))

  router.post('/environments/:id/stop', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeEnvironmentManage(c, db, environmentId)
    if (auth instanceof Response) return auth

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const loaded = await loadLifecycleTargets(db, environmentId)
    if (loaded instanceof Response) return loaded

    const tcpUdpServices = await resolveTcpUdpIngressServices(db, environmentId)
    const queued: QueuedCommandRef[] = []
    for (const serverId of loaded.serverIds) {
      const enqueued = await enqueueStopCommand(db, commandQueue, {
        serverId,
        userId: auth.userId,
        environmentId,
        projectId: loaded.projectId,
        projectName: loaded.projectName,
        ingressServices: tcpUdpServices.map((svc) => ({ serviceId: svc.serviceId })),
      })
      if (enqueued instanceof Response) return enqueued
      queued.push(enqueued)
    }
    return Response.json(queuedCommandsJson(queued))
  })
}

async function enqueueLifecycleCommand(
  db: Db,
  commandQueue: CommandQueue,
  params: {
    serverId: string
    userId: string
    environmentId: string
    projectId: string
    projectName: string
    action: EnvironmentLifecycleAction
  },
): Promise<QueuedCommandRef | Response> {
  const expiresAt = new Date(Date.now() + 120_000).toISOString()
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: 'user',
    actorId: params.userId,
    type: 'environment.lifecycle',
    payload: {
      environmentId: params.environmentId,
      projectId: params.projectId,
      projectName: params.projectName,
      action: params.action,
    },
    expiresAt,
  })

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId: params.serverId,
    type: 'environment.lifecycle',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }

  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return Response.json({ error: 'Command queue unavailable' }, { status: 503 })
  }

  return {
    commandId: record.id,
    serverId: params.serverId,
    status: 'queued',
  }
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
    throw new TypeError('session secrets are required for environment lifecycle routes')
  }
  router.use('/environments/:id/lifecycle', createSessionMiddleware(opts.secrets))

  router.post('/environments/:id/lifecycle', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeEnvironmentManage(c, db, environmentId)
    if (auth instanceof Response) return auth

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const action = parseLifecycleAction(body)
    if (action === 'invalid') {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const loaded = await loadLifecycleTargets(db, environmentId)
    if (loaded instanceof Response) return loaded

    const queued: QueuedCommandRef[] = []
    for (const serverId of loaded.serverIds) {
      const enqueued = await enqueueLifecycleCommand(db, commandQueue, {
        serverId,
        userId: auth.userId,
        environmentId,
        projectId: loaded.projectId,
        projectName: loaded.projectName,
        action,
      })
      if (enqueued instanceof Response) return enqueued
      queued.push(enqueued)
    }
    return Response.json(queuedCommandsJson(queued))
  })
}
