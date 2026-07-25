import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { resealSecretForDaemon } from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../daemon/authn/server-identity-db.ts'
import {
  prepareDeployCompose,
  readComposePlacementServerId,
  readHostingProxyFromOptions,
  resolveHostingBindAddress,
  extractComposeFromOptions,
  verifyServerInOrg,
  type DeployPrepareError,
} from './deploy-prepare.ts'
import { assignTraditionalWebListenPorts } from '../../lib/compose/traditional-web.ts'
import {
  attachWebMetadataToTraditionalSites,
  resolveHostingDeployWeb,
} from '../../lib/hosting-web-env.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type {
  EnvironmentDeployHosting,
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeployServiceHook,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeployTlsMaterial,
  EnvironmentDeployTraditionalWebSite,
  EnvironmentDeployVariableMaterial,
} from '../../lib/commands/schemas.ts'
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
  parseTlsMetadata,
  parseTlsOptions,
  resolveTlsForHosting,
  type TlsCandidate,
} from '../../lib/tls/index.ts'
import { getDaemonCellRegistry, getDb, type Db } from '../../db.ts'
import {
  assertCanManageOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'

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
  if (prepared.kind === 'health_check') {
    return c.json({
      error: 'health_check_missing',
      required: prepared.required,
      services: prepared.services,
    }, { status: 409 })
  }
  if (prepared.kind === 'empty_compose') {
    return c.json({ error: 'compose_empty' }, { status: 400 })
  }
  if (prepared.kind === 'datacenter_ip_required') {
    return c.json({
      error: 'datacenter_ip_required',
      serverId: prepared.serverId,
    }, { status: 422 })
  }
  if (prepared.kind === 'docker_external_network_unregistered') {
    return c.json({
      error: 'docker_external_network_unregistered',
      names: prepared.names,
      message:
        'Compose references external Docker network(s) that are not registered for this server. Add a Docker network under Servers → Networks with matching options.dockerNetworkName.',
    }, { status: 422 })
  }
  return c.json({
    error: 'resource_limit_exceeded',
    violations: prepared.violations,
  }, { status: 409 })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readComposeServiceName(metadata: unknown, fallback: string): string {
  if (isPlainObject(metadata) && typeof metadata.composeServiceName === 'string') {
    return metadata.composeServiceName
  }
  return fallback
}

function readHostnames(options: unknown): string[] {
  if (!isPlainObject(options)) return []
  const hostnames = options.hostnames
  if (!Array.isArray(hostnames)) return []
  return hostnames.filter((h): h is string => typeof h === 'string' && h.length > 0)
}

function readPathPrefix(options: unknown): string | undefined {
  if (!isPlainObject(options)) return undefined
  return typeof options.pathPrefix === 'string' ? options.pathPrefix : undefined
}

function readTargetPort(options: unknown): number | undefined {
  if (!isPlainObject(options)) return undefined
  return typeof options.targetPort === 'number' && Number.isFinite(options.targetPort)
    ? options.targetPort
    : undefined
}

function readHostingProtocol(options: unknown): 'http' | 'tcp' | 'udp' {
  if (!isPlainObject(options)) return 'http'
  return options.protocol === 'tcp' || options.protocol === 'udp' ? options.protocol : 'http'
}

function isValidHostingPortValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function readHostingPorts(options: unknown): { published: number; target: number }[] {
  if (!isPlainObject(options) || !Array.isArray(options.ports)) return []
  const ports: { published: number; target: number }[] = []
  for (const entry of options.ports) {
    if (
      isPlainObject(entry) &&
      isValidHostingPortValue(entry.published) &&
      isValidHostingPortValue(entry.target)
    ) {
      ports.push({ published: entry.published, target: entry.target })
    }
  }
  return ports
}

import {
  validateDeployHostings,
  validateDeployStorageMaterialList,
} from '../../lib/commands/deploy-validation.ts'
import { assertComposeDocument } from '../../lib/compose/index.ts'

function trimEdgeDashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '-') start++
  while (end > start && value[end - 1] === '-') end--
  return value.slice(start, end)
}

function projectComposeName(displayName: string | null, projectId: string): string {
  const raw = (displayName ?? projectId).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')
  const trimmed = trimEdgeDashes(raw).slice(0, 40)
  return trimmed.length > 0 ? trimmed : `project-${projectId.slice(0, 8)}`
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
  displayName: string | null
  metadata: unknown
}

type HostingRow = {
  id: string
  options: unknown
  tlsId: string | null
  ipId: string | null
}

function tlsPinErrorCode(
  error: 'pin_not_found' | 'pin_mismatch' | 'pin_not_ready',
): string {
  switch (error) {
    case 'pin_mismatch':
      return 'tls_pin_mismatch'
    case 'pin_not_ready':
      return 'tls_pin_not_ready'
    case 'pin_not_found':
      return 'tls_pin_not_found'
  }
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
      metadata: tls.metadata,
      options: tls.options,
      certificatePem: tls.certificatePem,
      privateKeyPem: tls.privateKeyPem,
    })
    .from(tls)
    .where(eq(tls.organizationId, organizationId))

  const out: OrgTlsCandidate[] = []
  for (const row of rows) {
    const metadata = parseTlsMetadata(row.metadata)
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
  const composeServiceName = readComposeServiceName(
    svc.metadata,
    svc.displayName ?? svc.id,
  )
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
      displayName: service.displayName,
      metadata: service.metadata,
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
      !row.privateKeyPem.startsWith('tpsecret.') ||
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
  projectRow: { id: string; displayName: string | null; options: unknown }
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
      displayName: project.displayName,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return Response.json({ error: 'Not found' }, { status: 404 })

  try {
    const overlayCompose = assertComposeDocument(extractComposeFromOptions(envRow.options))
    const placementServerId = readComposePlacementServerId(overlayCompose)
    return {
      envRow,
      projectRow,
      placementServerId,
    }
  } catch {
    return Response.json({ error: 'Invalid compose document' }, { status: 400 })
  }
}

async function authorizeDeployRequest(
  c: Context<AppEnv>,
  db: Db,
  environmentId: string,
): Promise<{
  userId: string
  organizationId: string
  requestedServerId: string | null
  acknowledgeHealthCheckWarnings: boolean
} | Response> {
  const denied = await assertCanManageOr403(c, 'environment', environmentId)
  if (denied) return denied

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  const entityOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
  if (!entityOrgId || entityOrgId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  const body = await parseJsonBody(c)
  if (body instanceof Response) return body

  let requestedServerId: string | null = null
  if ('serverId' in body) {
    const value = body.serverId
    if (typeof value !== 'string' || !value) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    requestedServerId = value
  }

  const acknowledgeHealthCheckWarnings = body.acknowledgeHealthCheckWarnings === true

  return {
    userId: session.userId,
    organizationId: orgResult,
    requestedServerId,
    acknowledgeHealthCheckWarnings,
  }
}

async function resolveDeployTargetServer(
  c: Context<AppEnv>,
  db: Db,
  organizationId: string,
  requestedServerId: string | null,
  placementServerId: string | null,
): Promise<{ serverId: string } | Response> {
  let serverId: string

  if (placementServerId) {
    if (requestedServerId && requestedServerId !== placementServerId) {
      return c.json({ error: 'server_placement_mismatch' }, 400)
    }
    serverId = placementServerId
  } else if (requestedServerId) {
    serverId = requestedServerId
  } else {
    return c.json({ error: 'Invalid request' }, 400)
  }

  if (!(await verifyServerInOrg(db, serverId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }

  return { serverId }
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
    tlsMaterial: EnvironmentDeployTlsMaterial[]
    variableMaterial: EnvironmentDeployVariableMaterial[]
    storageMaterial: EnvironmentDeployStorageMaterial[]
    principalMaterial: EnvironmentDeployPrincipalMaterial[]
    serviceHooks: EnvironmentDeployServiceHook[]
    dockerExternalNetworks: string[]
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
      ...(params.tlsMaterial.length > 0 ? { tlsMaterial: params.tlsMaterial } : {}),
      ...(params.variableMaterial.length > 0 ? { variableMaterial: params.variableMaterial } : {}),
      ...(params.storageMaterial.length > 0 ? { storageMaterial: params.storageMaterial } : {}),
      ...(params.principalMaterial.length > 0 ? { principalMaterial: params.principalMaterial } : {}),
      ...(params.serviceHooks.length > 0 ? { serviceHooks: params.serviceHooks } : {}),
      ...(params.dockerExternalNetworks.length > 0
        ? { dockerExternalNetworks: params.dockerExternalNetworks }
        : {}),
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

function preferredListenPortsFromHostings(
  hostings: readonly DeployHostingPayload[],
): Map<string, number> {
  const preferredListenPorts = new Map<string, number>()
  for (const entry of hostings) {
    if (typeof entry.targetPort === 'number') {
      preferredListenPorts.set(entry.composeServiceName, entry.targetPort)
    }
  }
  return preferredListenPorts
}

function buildTraditionalWebSitesForDeploy(
  traditionalWebSites: EnvironmentDeployTraditionalWebSite[],
  hostings: DeployHostingPayload[],
): EnvironmentDeployTraditionalWebSite[] {
  return attachWebMetadataToTraditionalSites(
    assignTraditionalWebListenPorts(
      traditionalWebSites,
      preferredListenPortsFromHostings(hostings),
    ),
    hostings,
  )
}

function validateDeployMaterials(
  hostings: DeployHostingPayload[],
  storageMaterial: EnvironmentDeployStorageMaterial[],
): Response | null {
  const hostingValidationError = validateDeployHostings(hostings)
  if (hostingValidationError) {
    return Response.json(
      { error: 'invalid_deploy_hosting', message: hostingValidationError },
      { status: 400 },
    )
  }

  const storageValidationError = validateDeployStorageMaterialList(storageMaterial)
  if (storageValidationError) {
    return Response.json(
      { error: 'invalid_deploy_storage', message: storageValidationError },
      { status: 400 },
    )
  }

  return null
}

/**
 * Register `POST /environments/:id/deploy` — single-server compose deploy.
 * Status is polled via existing `GET /servers/:serverId/commands/:commandId`.
 */
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
      auth.requestedServerId,
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

    const tlsMaterial = await sealTlsMaterialForDaemon(
      c,
      db,
      target.serverId,
      auth.organizationId,
      hostingBuilt.resolvedTlsIds,
    )
    if (tlsMaterial instanceof Response) return tlsMaterial

    const prevMeta = isPlainObject(loaded.envRow.metadata) ? loaded.envRow.metadata : {}
    await db
      .update(environment)
      .set({
        metadata: { ...prevMeta, serverId: target.serverId },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId))

    const projectName = `tp-${projectComposeName(loaded.projectRow.displayName, loaded.projectRow.id)}-${environmentId.slice(0, 8)}`

    const materialsError = validateDeployMaterials(
      hostingBuilt.hostings,
      prepared.storageMaterial,
    )
    if (materialsError) return materialsError

    const traditionalWebSites = buildTraditionalWebSitesForDeploy(
      prepared.traditionalWebSites,
      hostingBuilt.hostings,
    )

    return enqueueDeployCommand(db, commandQueue, {
      serverId: target.serverId,
      userId: auth.userId,
      environmentId,
      projectId: loaded.projectRow.id,
      organizationId: auth.organizationId,
      projectName,
      composeYaml: prepared.composeYaml,
      hostings: hostingBuilt.hostings,
      traditionalWebSites,
      tlsMaterial,
      variableMaterial: prepared.variableMaterial,
      storageMaterial: prepared.storageMaterial,
      principalMaterial: prepared.principalMaterial,
      serviceHooks: prepared.hooks,
      dockerExternalNetworks: prepared.dockerExternalNetworks,
    })
  })
}

function readMetadataServerId(metadata: unknown): string | null {
  if (isPlainObject(metadata) && typeof metadata.serverId === 'string' && metadata.serverId) {
    return metadata.serverId
  }
  return null
}

async function loadStopTarget(
  db: Db,
  environmentId: string,
): Promise<
  | {
    projectId: string
    projectName: string
    placementServerId: string | null
    metadataServerId: string | null
  }
  | Response
> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
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
      displayName: project.displayName,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return Response.json({ error: 'Not found' }, { status: 404 })

  let placementServerId: string | null = null
  try {
    const overlayCompose = assertComposeDocument(extractComposeFromOptions(envRow.options))
    placementServerId = readComposePlacementServerId(overlayCompose)
  } catch {
    // Placement may be absent or compose invalid — fall back to metadata.serverId.
  }

  return {
    projectId: projectRow.id,
    projectName:
      `tp-${projectComposeName(projectRow.displayName, projectRow.id)}-${environmentId.slice(0, 8)}`,
    placementServerId,
    metadataServerId: readMetadataServerId(envRow.metadata),
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
    const denied = await assertCanManageOr403(c, 'environment', environmentId)
    if (denied) return denied

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
    if (!entityOrgId || entityOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const loaded = await loadStopTarget(db, environmentId)
    if (loaded instanceof Response) return loaded

    const target = await resolveDeployTargetServer(
      c,
      db,
      orgResult,
      null,
      loaded.placementServerId ?? loaded.metadataServerId,
    )
    if (target instanceof Response) return target

    return enqueueStopCommand(db, commandQueue, {
      serverId: target.serverId,
      userId: session.userId,
      environmentId,
      projectId: loaded.projectId,
      projectName: loaded.projectName,
    })
  })
}
