import { and, eq } from 'drizzle-orm'
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
  verifyServerInOrg,
  type DeployPrepareError,
} from './deploy-prepare.ts'
import {
  resolveHostingDeployWeb,
} from '../../lib/hosting-web-env.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type {
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
  preferredListenPortsFromHostings,
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
import {
  environment,
  hosting,
  project,
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
    // Refuse plaintext / non-enc rows — keys must be sealed at rest.
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

type LoadedDeployCompose = {
  envRow: { id: string; projectId: string; options: unknown; metadata: unknown }
  projectRow: { id: string; options: unknown }
  placementServerId: string | null
}

async function loadDeployContext(
  db: Db,
  environmentId: string,
): Promise<LoadedDeployCompose | Response> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      serverId: environment.serverId,
      options: environment.options,
      metadata: environment.metadata,
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

  return {
    envRow,
    projectRow,
    placementServerId: resolveEffectivePlacementServerId(
      envRow.serverId,
      parseProjectOptions(projectRow.options),
    ),
  }
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

/**
 * Resolve deploy/stop target from `environment.server_id`, falling back to
 * `project.options.defaultServerId`. Body/compose placement is never a
 * fallback.
 */
async function resolveDeployTargetServer(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  placementServerId: string | null,
): Promise<{ serverId: string } | Response> {
  if (!placementServerId) {
    return c.json({ error: 'server_placement_required' }, 409)
  }

  if (!(await verifyServerInOrg(db, placementServerId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }

  return { serverId: placementServerId }
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
  },
): Promise<Response> {
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
    return Response.json({ error: 'Command queue unavailable' }, { status: 503 })
  }

  return Response.json({
    ok: true as const,
    commandId: record.id,
    status: 'queued' as const,
  })
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

    const loaded = await loadDeployContext(db, environmentId)
    if (loaded instanceof Response) return loaded

    const target = await resolveDeployTargetServer(
      c,
      db,
      auth.organizationId,
      loaded.placementServerId,
    )
    if (target instanceof Response) return target

    const prepared = await prepareDeployCompose(c, db, {
      environmentId,
      serverId: target.serverId,
      organizationId: auth.organizationId,
      mode: 'preview',
    })
    if (prepared instanceof Response) return prepared
    // Preview mode softens prepare gates into warnings; hard errors are Responses.
    if ('kind' in prepared) {
      return c.json({ error: 'Unexpected prepare error' }, 500)
    }

    const projectName = composeProjectName(loaded.projectRow.id)

    return c.json({
      ok: true as const,
      composeYaml: prepared.composeYaml,
      projectName,
      containers: buildDeployPreviewContainers({
        appContainers: prepared.containers,
        ingressServices: prepared.ingressServices,
      }),
      volumes: prepared.volumes.map((row) => ({
        storageId: row.storageId,
        composeKey: row.composeKey,
        volumeName: row.volumeName,
      })),
      warnings: prepared.warnings,
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

    const loaded = await loadDeployContext(db, environmentId)
    if (loaded instanceof Response) return loaded

    const target = await resolveDeployTargetServer(
      c,
      db,
      auth.organizationId,
      loaded.placementServerId,
    )
    if (target instanceof Response) return target

    const prepared = await prepareDeployCompose(c, db, {
      environmentId,
      serverId: target.serverId,
      organizationId: auth.organizationId,
      acknowledgeHealthCheckWarnings: auth.acknowledgeHealthCheckWarnings,
    })
    if (prepared instanceof Response) return prepared
    if ('kind' in prepared) return responseForPrepareError(c, prepared)

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const hostingBuilt = await buildHostingPayload(
      db,
      environmentId,
      auth.organizationId,
      target.serverId,
      dataEncryptionSecrets,
    )
    if ('prepareError' in hostingBuilt) {
      return responseForPrepareError(c, hostingBuilt.prepareError)
    }
    if ('error' in hostingBuilt) return hostingBuilt.error

    // Fan hostings out to multi-instance clone keys so injectHostingLabels
    // finds every compose service. Same hostingId/serviceId → Traefik merges
    // identical router/service labels into one load balancer.
    const hostings = expandHostingsForComposeInstances(
      hostingBuilt.hostings,
      prepared.composeServiceExpansion,
    )

    const tlsMaterial = await sealTlsMaterialForDaemon(
      c,
      db,
      target.serverId,
      auth.organizationId,
      hostingBuilt.resolvedTlsIds,
    )
    if (tlsMaterial instanceof Response) return tlsMaterial

    const projectName = composeProjectName(loaded.projectRow.id)

    const materialsError = validateDeployMaterialsResponse(
      hostings,
      prepared.storageMaterial,
    )
    if (materialsError) return materialsError

    const traditionalWebSites = buildTraditionalWebSitesForDeploy(
      prepared.traditionalWebSites,
      hostings,
    )

    return enqueueDeployCommand(db, commandQueue, {
      serverId: target.serverId,
      userId: auth.userId,
      environmentId,
      projectId: loaded.projectRow.id,
      organizationId: auth.organizationId,
      projectName,
      composeYaml: prepared.composeYaml,
      hostings,
      traditionalWebSites,
      ingressServices: prepared.ingressServices,
      tlsMaterial,
      variableMaterial: prepared.variableMaterial,
      storageMaterial: prepared.storageMaterial,
      principalMaterial: prepared.principalMaterial,
      serviceHooks: prepared.hooks,
      dockerExternalNetworks: prepared.dockerExternalNetworks,
      managedNetworkServices: prepared.managedNetworkServices,
      noCache: auth.noCache,
    })
  })
}

async function loadStopTarget(
  db: Db,
  environmentId: string,
): Promise<
  | {
    projectId: string
    projectName: string
    placementServerId: string | null
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

  return {
    projectId: projectRow.id,
    projectName: composeProjectName(projectRow.id),
    placementServerId: resolveEffectivePlacementServerId(
      envRow.serverId,
      parseProjectOptions(projectRow.options),
    ),
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
): Promise<Response> {
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

  return Response.json({
    ok: true as const,
    commandId: record.id,
    status: 'queued' as const,
    serverId: params.serverId,
  })
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

    const loaded = await loadStopTarget(db, environmentId)
    if (loaded instanceof Response) return loaded

    const target = await resolveDeployTargetServer(
      c,
      db,
      auth.organizationId,
      loaded.placementServerId,
    )
    if (target instanceof Response) return target

    const tcpUdpServices = await resolveTcpUdpIngressServices(db, environmentId)
    return enqueueStopCommand(db, commandQueue, {
      serverId: target.serverId,
      userId: auth.userId,
      environmentId,
      projectId: loaded.projectId,
      projectName: loaded.projectName,
      ingressServices: tcpUdpServices.map((svc) => ({ serviceId: svc.serviceId })),
    })
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
): Promise<Response> {
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

  return Response.json({
    ok: true as const,
    commandId: record.id,
    status: 'queued' as const,
    serverId: params.serverId,
  })
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

    const loaded = await loadStopTarget(db, environmentId)
    if (loaded instanceof Response) return loaded

    const target = await resolveDeployTargetServer(
      c,
      db,
      auth.organizationId,
      loaded.placementServerId,
    )
    if (target instanceof Response) return target

    return enqueueLifecycleCommand(db, commandQueue, {
      serverId: target.serverId,
      userId: auth.userId,
      environmentId,
      projectId: loaded.projectId,
      projectName: loaded.projectName,
      action,
    })
  })
}
