import { skipWithoutDatabase } from '../../test-fixtures/require-service.ts'
import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import type { DaemonCell, DaemonCellRegistry } from '../../contracts/cell.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../../lib/secrets/secrets.ts'
import { emptyComposeDocument } from '../../features/compose/index.ts'
import { DEFAULT_MANAGED_INGRESS_PORTS } from '../../features/managed/ingress-ports.ts'
import type { ComposeDocument } from '../../features/compose/types.ts'
import type { PreparedDeployCompose } from './deploy-prepare.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  command,
  container,
  deployment,
  dispatch,
  environment,
  fabric,
  grant,
  hosting,
  network,
  organization,
  project,
  server,
  service,
  slot,
  subnet,
  tls,
  user,
  variable,
  workspace,
} from '../../db/schema.ts'
import { getCommandMetadata, transitionCommand } from '../../features/commands/command-records.ts'
import {
  enableOrganizationFabric,
  getOrganizationFabric,
  listEnvironmentComposeNetworks,
  listFabricRelays,
  stampRelayPublicKey,
  stampRelayReconcileSuccess,
  updateFabricRelay,
} from '../../features/fabric/fabric-records.ts'
import { setFabricConvergenceTimeoutMsForTests } from '../../features/fabric/enqueue.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import {
  attachmentServerIds,
  deployParticipation,
  expandHostingsForComposeInstances,
  ingressServerIdsForDeploy,
  preferredListenPortsFromHostings,
  readHostingPorts,
  readHostingProtocol,
  readHostnames,
  readPathPrefix,
  readTargetPort,
  registerEnvironmentDeployPreviewRoutes,
  registerEnvironmentDeployRoutes,
  registerEnvironmentLifecycleRoutes,
  registerEnvironmentStopRoutes,
  runEnvironmentDeployForActor,
  tcpUdpIngressServiceRefs,
  validateDeployMaterials,
} from './deploy-routes.ts'
import { planEnvironmentDeploy } from '../../features/schedule/index.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { systemHierarchyProvision } from '../../features/system/hierarchy.ts'
import { registerTlsRoutes } from '../tls/routes.ts'
import { registerOrganizationRoutes } from '../organizations/routes.ts'
import { reconcileServicesForEnvironment } from './reconcile-after-compose-save.ts'
import { forEachSequential, mapSequential } from '../../lib/sequential.ts'
import { registerEnvironmentDeploymentHistoryRoutes } from './deployment-history-routes.ts'
import { registerEnvironmentReleaseRoutes } from './release-routes.ts'
import { mintSelfSignedCertificate } from '../../lib/tls/index.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('expandHostingsForComposeInstances fans hostings onto clone keys', () => {
  const expanded = expandHostingsForComposeInstances(
    [
      {
        hostingId: 'h1',
        serviceId: 'svc-web',
        composeServiceName: 'web',
        hostnames: ['app.example.com'],
      },
      {
        hostingId: 'h2',
        serviceId: 'svc-api',
        composeServiceName: 'api',
        hostnames: ['api.example.com'],
      },
    ],
    {
      web: ['web-1', 'web-2'],
      api: ['api'],
    }
  )
  assertEquals(expanded.length, 3)
  assertEquals(
    expanded.map((entry) => entry.composeServiceName).sort((a, b) => a.localeCompare(b)),
    ['api', 'web-1', 'web-2']
  )
  const webClones = expanded.filter((entry) => entry.hostingId === 'h1')
  assertEquals(webClones.length, 2)
  assertEquals(
    webClones.every((entry) => entry.serviceId === 'svc-web'),
    true
  )
})

test('expandHostingsForComposeInstances passes through when expansion is missing', () => {
  const hostings = [
    {
      hostingId: 'h1',
      serviceId: 'svc-api',
      composeServiceName: 'api',
      hostnames: ['api.example.com'],
    },
  ]
  const expanded = expandHostingsForComposeInstances(hostings, {})
  assertEquals(expanded.length, 1)
  assertEquals(expanded[0]?.composeServiceName, 'api')
})

test('deployParticipation marks previous hosts not in the plan as drained', () => {
  const attachments = [{ serverId: 'srv-attach', networkKeys: ['default'] }]
  const result = deployParticipation({
    planServerIds: ['srv-a'],
    attachments,
    previous: [{ serverId: 'srv-a' }, { serverId: 'srv-old' }],
  })
  assertEquals(
    [...result.attachmentServers].sort((a, b) => a.localeCompare(b)),
    ['srv-attach']
  )
  assertEquals(
    [...result.participating].sort((a, b) => a.localeCompare(b)),
    ['srv-a', 'srv-attach']
  )
  assertEquals(result.drainedIds, ['srv-old'])
  assertEquals(
    deployParticipation({
      planServerIds: ['srv-a'],
      attachments: [],
      previous: [],
    }).drainedIds,
    []
  )
})

test('tcpUdpIngressServiceRefs and attachmentServerIds project ids', () => {
  assertEquals(tcpUdpIngressServiceRefs([{ serviceId: 'svc-1' }, { serviceId: 'svc-2' }]), [
    { serviceId: 'svc-1' },
    { serviceId: 'svc-2' },
  ])
  assertEquals(
    attachmentServerIds([
      { serverId: 'srv-a', networkKeys: [] },
      { serverId: 'srv-b', networkKeys: ['default'] },
    ]),
    ['srv-a', 'srv-b']
  )
})

function stubPreparedDeployCompose(managedNetworkServices: string[]): PreparedDeployCompose {
  return {
    composeYaml: '',
    composeFiles: [],
    desiredHash: '',
    replicaCounts: {},
    hooks: [],
    variableMaterial: [],
    storageMaterial: [],
    principalMaterial: [],
    sites: [],
    nativeAppServices: [],
    sourceMaterial: [],
    dockerExternalNetworks: [],
    dockerNetworkAddressing: [],
    fabricNetworks: [],
    managedNetworkServices,
    containers: [],
    ingressServices: [],
    hostings: [],
    tlsMaterial: [],
    listenerPorts: DEFAULT_MANAGED_INGRESS_PORTS,
    composeServiceExpansion: {},
    volumes: [],
    warnings: [],
  }
}

test('ingressServerIdsForDeploy includes attachments, leftovers, and managed hosts', () => {
  const ids = ingressServerIdsForDeploy({
    planServerIds: ['srv-a', 'srv-b'],
    preparedByServer: [
      {
        serverId: 'srv-a',
        prepared: stubPreparedDeployCompose(['web']),
      },
      {
        serverId: 'srv-b',
        prepared: stubPreparedDeployCompose([]),
      },
    ],
    attachments: [{ serverId: 'srv-attach', networkKeys: ['default'] }],
    consumers: [],
    spanning: new Map(),
    segmentsByServer: new Map(),
    listenerNames: new Map(),
    releasedListeners: ['srv-orphan'],
  })
  assertEquals(
    [...ids].sort((a, b) => a.localeCompare(b)),
    ['srv-a', 'srv-attach', 'srv-orphan']
  )
})

test('readHosting helpers parse http and tcp/udp options', () => {
  assertEquals(readHostnames(null), [])
  assertEquals(readHostnames({ hostnames: ['a.example.com', '', 3] }), ['a.example.com'])
  assertEquals(readPathPrefix({ pathPrefix: '/api' }), '/api')
  assertEquals(readPathPrefix({}), undefined)
  assertEquals(readTargetPort({ targetPort: 8080 }), 8080)
  assertEquals(readTargetPort({ targetPort: Number.NaN }), undefined)
  assertEquals(readHostingProtocol({ protocol: 'tcp' }), 'tcp')
  assertEquals(readHostingProtocol({ protocol: 'udp' }), 'udp')
  assertEquals(readHostingProtocol({ protocol: 'http' }), 'http')
  assertEquals(readHostingProtocol({}), 'http')
  assertEquals(
    readHostingPorts({
      ports: [
        { published: 5432, target: 5432 },
        { published: 0, target: 5432 },
        { published: 8443, target: '8080' },
        null,
      ],
    }),
    [{ published: 5432, target: 5432 }]
  )
})

test('preferredListenPortsFromHostings maps targetPort by compose service name', () => {
  const map = preferredListenPortsFromHostings([
    {
      hostingId: 'h1',
      serviceId: 'svc-web',
      composeServiceName: 'web',
      hostnames: ['app.example.com'],
      targetPort: 3000,
    },
    {
      hostingId: 'h2',
      serviceId: 'svc-api',
      composeServiceName: 'api',
      hostnames: ['api.example.com'],
    },
  ])
  assertEquals(map.get('web'), 3000)
  assertEquals(map.has('api'), false)
})

test('validateDeployMaterials rejects tcp hosting without ports', () => {
  const validationError = validateDeployMaterials(
    [
      {
        hostingId: 'h1',
        serviceId: 'svc-db',
        composeServiceName: 'db',
        hostnames: [],
        protocol: 'tcp',
        ports: [],
      },
    ],
    []
  )
  if (!validationError) {
    throw new TypeError('expected a validation error')
  }
  assertEquals(validationError.error, 'invalid_deploy_hosting')
})

function createRecordingCommandQueue(): CommandQueue & {
  envelopes: CommandEnvelope[]
} {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: (envelope) => {
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

function createMockCell(serverId: string): DaemonCell {
  const noopAsync = () => Promise.resolve()
  return {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: 'conn',
        lease: {
          holder: 'conn',
          token: 'conn',
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        },
      }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: () =>
      Promise.resolve({
        serverId,
        version: 0,
        updatedAt: new Date().toISOString(),
        connected: false,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId,
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: false,
        ...patch,
      }),
    enqueue: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    markSent: noopAsync,
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(null),
    createRequestAndWait: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'done' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: noopAsync,
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: noopAsync,
  }
}

function createTrackingRegistry(): DaemonCellRegistry {
  const cells = new Map<string, DaemonCell>()
  return {
    getCell(serverId: string): DaemonCell {
      let cell = cells.get(serverId)
      if (!cell) {
        cell = createMockCell(serverId)
        cells.set(serverId, cell)
      }
      return cell
    },
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

function composeWithEmptyServices(): ComposeDocument {
  return {
    version: 1,
    data: {
      services: {},
    },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

function composeWithWebService(): ComposeDocument {
  return {
    version: 1,
    data: {
      services: {
        web: { image: 'nginx:alpine' },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

function composeWithNamedWebService(): ComposeDocument {
  return {
    version: 1,
    data: {
      services: {
        web: { image: 'adminer:latest', container_name: 'adminer' },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

function composeWithReplicatedWebService(): ComposeDocument {
  return {
    version: 1,
    data: {
      services: {
        web: {
          image: 'nginx:alpine',
          ports: ['8080:80'],
          deploy: { replicas: 2 },
        },
      },
      networks: { default: { driver: 'overlay' } },
    },
    presentation: { keyOrder: ['services', 'networks'], comments: {} },
  }
}

async function createDeployRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  options: {
    registry: DaemonCellRegistry
    commandQueue: CommandQueue
  }
) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', options.registry)
    c.set('commandQueue', options.commandQueue)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    c.set('secretsConfig', secretsConfig)
    return next()
  })
  const routeOpts = {
    secrets,
    runtime: 'deno' as const,
    signupEnvOverride: undefined,
  }
  registerEnvironmentDeployPreviewRoutes(app, routeOpts)
  registerEnvironmentDeployRoutes(app, routeOpts)
  registerEnvironmentLifecycleRoutes(app, routeOpts)
  registerEnvironmentStopRoutes(app, routeOpts)
  registerEnvironmentDeploymentHistoryRoutes(app, routeOpts)
  registerEnvironmentReleaseRoutes(app, routeOpts)
  registerTlsRoutes(app, routeOpts)
  registerOrganizationRoutes(app, routeOpts)
  return { app, secrets }
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

async function withDeployFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    workspaceId: string
    projectId: string
    environmentId: string
    serverId: string
    commandQueue: ReturnType<typeof createRecordingCommandQueue>
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('environment deploy route tests')
    return
  }

  const db = createDenoDb()
  const commandQueue = createRecordingCommandQueue()
  const registry = createTrackingRegistry()
  const { app, secrets } = await createDeployRoutesTestApp(db, {
    registry,
    commandQueue,
  })

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Deploy Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `deploy-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Deploy Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Deploy Route Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Deploy Route Project',
      workspaceId,
      organizationId,
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Deploy Route Env',
      projectId,
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      workspaceId,
      projectId,
      environmentId,
      serverId,
      commandQueue,
    })
  } finally {
    await db.delete(command).where(eq(command.serverId, serverId))
    await db.delete(container).where(eq(container.serverId, serverId))
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    // Each fixture opens its own pool; leaking it exhausts a small Postgres.
    await endDbConnection(db)
  }
}

test('GET /environments/:id/deploy-preview returns prepared yaml with warnings for empty compose', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, projectId, environmentId, serverId }) => {
      await db
        .update(environment)
        .set({
          serverId,
          options: { compose: composeWithEmptyServices() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))
      await db
        .update(project)
        .set({
          options: { compose: emptyComposeDocument() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy-preview`, {
        method: 'GET',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      })

      assertEquals(res.status, 200)
      const body = (await res.json()) as {
        ok: boolean
        composeFiles: Array<{ filename: string; role: string; content: string }>
        projectName: string
        containers: unknown[]
        volumes: unknown[]
        warnings: Array<{ code: string }>
      }
      assertEquals(body.ok, true)
      assertEquals(body.projectName, projectId)
      assertEquals(body.containers, [])
      assertEquals(body.volumes, [])
      assertEquals(
        body.warnings.some((w) => w.code === 'empty_compose'),
        true
      )
      assertEquals(body.composeFiles?.[0]?.role, 'runtime')
      assertEquals(body.composeFiles?.[0]?.filename, 'compose.yaml')
    }
  )
})

test('GET /environments/:id/deploy-preview returns containers for a service', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, projectId, environmentId, serverId }) => {
      await db
        .update(environment)
        .set({
          serverId,
          options: { compose: emptyComposeDocument() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))
      await db
        .update(project)
        .set({
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy-preview`, {
        method: 'GET',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      })

      assertEquals(res.status, 200)
      const body = (await res.json()) as {
        ok: boolean
        composeFiles: Array<{
          filename: string
          role: string
          source?: string
          content: string
        }>
        projectName: string
        containers: Array<{
          serviceId: string
          composeServiceName: string
          containerName: string
          ordinal: number
        }>
        volumes: unknown[]
        warnings: unknown[]
      }
      assertEquals(body.ok, true)
      assertEquals(body.projectName, projectId)
      const runtimeYaml = body.composeFiles[0]?.content ?? ''
      assertEquals(runtimeYaml.includes('web:'), true)
      assertEquals(runtimeYaml.includes('x-turbopanel:'), true)
      assertEquals(runtimeYaml.includes(serverId), true)
      assertEquals((body as { servers?: unknown }).servers, undefined)
      assertEquals(body.containers.length >= 1, true)
      assertEquals(body.containers[0]!.composeServiceName, 'web')
      assertEquals(body.containers[0]!.ordinal, 1)
      // uuid naming: docker container_name is the service UUID (obfuscated)
      assertEquals(body.containers[0]!.containerName, body.containers[0]!.serviceId)
      assertEquals(runtimeYaml.includes(`container_name: ${body.containers[0]!.serviceId}`), true)

      assertEquals(body.composeFiles.length, 1)
      assertEquals(body.composeFiles[0]!.role, 'runtime')
      assertEquals(body.composeFiles[0]!.filename, 'compose.yaml')
    }
  )
})

test('GET /environments/:id/deploy-preview uses service UUID over authored container_name', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, projectId, environmentId, serverId }) => {
      await db
        .update(environment)
        .set({
          serverId,
          options: { compose: emptyComposeDocument() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))
      await db
        .update(project)
        .set({
          options: { compose: composeWithNamedWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy-preview`, {
        method: 'GET',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      })

      assertEquals(res.status, 200)
      const body = (await res.json()) as {
        ok: boolean
        composeFiles: Array<{ content: string }>
        containers: Array<{
          serviceId: string
          containerName: string
        }>
      }
      assertEquals(body.ok, true)
      assertEquals(body.containers.length >= 1, true)
      assertEquals(body.containers[0]!.containerName, body.containers[0]!.serviceId)
      const runtimeYaml = body.composeFiles[0]?.content ?? ''
      assertEquals(runtimeYaml.includes(`container_name: ${body.containers[0]!.serviceId}`), true)
      assertEquals(runtimeYaml.includes('container_name: adminer'), false)
    }
  )
})

test('POST /environments/:id/deploy payload carries runtime composeFiles', async () => {
  await withDeployFixtures(
    async ({
      db,
      app,
      secrets,
      userId,
      organizationId,
      projectId,
      environmentId,
      serverId,
      commandQueue,
    }) => {
      await db
        .update(environment)
        .set({
          serverId,
          name: 'Production',
          options: { compose: emptyComposeDocument() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))
      await db
        .update(project)
        .set({
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      assertEquals(res.status, 200)
      const body = (await res.json()) as { ok: boolean; commandId: string }
      assertEquals(body.ok, true)
      assertEquals(commandQueue.envelopes.length, 1)

      const [row] = await db
        .select({ payload: dispatch.payload })
        .from(dispatch)
        .where(eq(dispatch.commandId, body.commandId))
        .limit(1)
      const payload = row?.payload as {
        composeFiles: Array<{ filename: string; role: string; content: string }>
      }
      assertEquals(Array.isArray(payload.composeFiles), true)
      assertEquals(payload.composeFiles.length, 1)
      assertEquals(payload.composeFiles[0]!.role, 'runtime')
      assertEquals(payload.composeFiles[0]!.filename, 'compose.yaml')
      assertEquals(payload.composeFiles[0]!.content.includes('web:'), true)
    }
  )
})

test('POST /environments/:id/deploy payload carries the non-secret envFile', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, projectId, environmentId, serverId }) => {
      await db
        .update(environment)
        .set({
          serverId,
          name: 'Production',
          options: { compose: emptyComposeDocument() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))
      await db
        .update(project)
        .set({
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))
      await db.insert(variable).values({
        environmentId,
        key: 'APP_MODE',
        value: 'route-test',
      })

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      assertEquals(res.status, 200)
      const body = (await res.json()) as { ok: boolean; commandId: string }
      const [row] = await db
        .select({ payload: dispatch.payload })
        .from(dispatch)
        .where(eq(dispatch.commandId, body.commandId))
        .limit(1)
      const payload = row?.payload as { envFile?: string }
      assertEquals(payload.envFile?.includes('APP_MODE=route-test'), true)
    }
  )
})

type StrategyDeployResult = {
  status: number
  body: {
    strategy?: {
      requested: string
      effective: string
      fallbackReasons: Array<{ code: string }>
    }
    error?: string
  }
  payload: Record<string, unknown>
  context: Record<string, unknown>
}

/** Deploy the web fixture with `options` stored on the environment and `request` as the body. */
async function deployWithStrategy(
  environmentOptions: Record<string, unknown>,
  request: Record<string, unknown>
): Promise<StrategyDeployResult> {
  let result: StrategyDeployResult | undefined
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, projectId, environmentId, serverId }) => {
      await db
        .update(environment)
        .set({
          serverId,
          name: 'Production',
          options: { compose: emptyComposeDocument(), ...environmentOptions },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))
      await db
        .update(project)
        .set({
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: await sessionCookie(db, secrets, userId),
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      })
      const body = (await res.json()) as StrategyDeployResult['body'] & { commandId?: string }
      let payload: Record<string, unknown> = {}
      let context: Record<string, unknown> = {}
      if (body.commandId) {
        const [row] = await db
          .select({ payload: dispatch.payload })
          .from(dispatch)
          .where(eq(dispatch.commandId, body.commandId))
          .limit(1)
        payload = (row?.payload ?? {}) as Record<string, unknown>
        const [cmd] = await db
          .select({ context: command.context })
          .from(command)
          .where(eq(command.id, body.commandId))
          .limit(1)
        context = (cmd?.context ?? {}) as Record<string, unknown>
      }
      result = { status: res.status, body, payload, context }
    }
  )
  if (!result) throw new TypeError('fixtures did not run')
  return result
}

test('POST /environments/:id/deploy sends sequential to the daemon when the environment is sequential', async () => {
  const out = await deployWithStrategy({ deployStrategy: 'sequential' }, {})
  assertEquals(out.status, 200)
  assertEquals(out.payload.deployStrategy, 'sequential')
  assertEquals(out.payload.migrations, 'unknown')
  assertEquals(out.payload.healthTimeoutSeconds, 120)
  assertEquals(out.context.deployStrategy, 'sequential')
  assertEquals(out.body.strategy?.requested, 'sequential')
  assertEquals(out.body.strategy?.effective, 'sequential')
  assertEquals(out.body.strategy?.fallbackReasons, [])
})

test('POST /environments/:id/deploy keeps an environment with no strategy in place (no payload change)', async () => {
  const out = await deployWithStrategy({}, {})
  assertEquals(out.status, 200)
  assertEquals('deployStrategy' in out.payload, false)
  assertEquals('healthTimeoutSeconds' in out.payload, false)
  assertEquals(out.context.deployStrategy, 'inplace')
  assertEquals(out.body.strategy?.effective, 'inplace')
})

test('POST /environments/:id/deploy honors a per-deploy strategy override and the health timeout setting', async () => {
  const optedOut = await deployWithStrategy(
    { deployStrategy: 'sequential' },
    { strategy: 'inplace' }
  )
  assertEquals(optedOut.status, 200)
  assertEquals('deployStrategy' in optedOut.payload, false)
  assertEquals(optedOut.body.strategy?.requested, 'inplace')

  const optedIn = await deployWithStrategy({ healthTimeoutSeconds: 45 }, { strategy: 'sequential' })
  assertEquals(optedIn.status, 200)
  assertEquals(optedIn.payload.deployStrategy, 'sequential')
  assertEquals(optedIn.payload.healthTimeoutSeconds, 45)
})

test('POST /environments/:id/deploy runs a stored blue-green setting as sequential with a visible reason', async () => {
  const out = await deployWithStrategy({ deployStrategy: 'bluegreen' }, {})
  assertEquals(out.status, 200)
  assertEquals(out.payload.deployStrategy, 'sequential')
  assertEquals(out.body.strategy?.requested, 'bluegreen')
  assertEquals(out.body.strategy?.effective, 'sequential')
  assertEquals(
    out.body.strategy?.fallbackReasons.some((r) => r.code === 'bluegreen_unavailable'),
    true
  )
})

test('POST /environments/:id/deploy still refuses a per-deploy blue-green override with 501', async () => {
  const out = await deployWithStrategy({}, { strategy: 'bluegreen' })
  assertEquals(out.status, 501)
  assertEquals(out.body.error, 'deploy_strategy_unsupported')
})

test('POST /environments/:id/deploy stamps hostingIngress for HTTP hostnames', async () => {
  const traefikServiceId = '00000000-0000-4000-8000-0000000000aa'
  await withDeployFixtures(
    async ({
      db,
      app,
      secrets,
      userId,
      organizationId,
      projectId,
      environmentId,
      serverId,
      commandQueue,
    }) => {
      const originalEnsure = systemHierarchyProvision.ensure
      systemHierarchyProvision.ensure = () =>
        Promise.resolve({
          workspaceId: '00000000-0000-4000-8000-0000000000bb',
          projectId: '00000000-0000-4000-8000-0000000000cc',
          environmentId: '00000000-0000-4000-8000-0000000000dd',
          serviceId: traefikServiceId,
          containerRowId: '00000000-0000-4000-8000-0000000000ee',
          containerName: `${traefikServiceId}-in`,
        })
      let hostingServiceId: string | undefined
      try {
        await db
          .update(environment)
          .set({
            serverId,
            name: 'Production',
            options: { compose: emptyComposeDocument() },
            updatedAt: new Date().toISOString(),
          })
          .where(eq(environment.id, environmentId))
        await db
          .update(project)
          .set({
            options: { compose: composeWithWebService() },
            updatedAt: new Date().toISOString(),
          })
          .where(eq(project.id, projectId))

        const [svc] = await db
          .insert(service)
          .values({
            environmentId,
            name: 'web',
            composeServiceName: 'web',
          })
          .returning({ id: service.id })
        hostingServiceId = svc!.id
        await db.insert(hosting).values({
          serviceId: svc!.id,
          options: { hostnames: ['adminer.example.test'] },
        })

        const cookie = await sessionCookie(db, secrets, userId)
        const res = await app.request(`/environments/${environmentId}/deploy`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })

        assertEquals(res.status, 200)
        const body = (await res.json()) as { ok: boolean; commandId: string }
        assertEquals(body.ok, true)
        assertEquals(commandQueue.envelopes.length, 1)

        const [row] = await db
          .select({ payload: dispatch.payload })
          .from(dispatch)
          .where(eq(dispatch.commandId, body.commandId))
          .limit(1)
        const payload = row?.payload as {
          hostingIngress?: {
            serviceId: string
            composeServiceName: string
            containerName: string
          }
          hostingIngressNetwork?: string
        }
        assertEquals(payload.hostingIngress, {
          serviceId: traefikServiceId,
          composeServiceName: 'traefik',
          containerName: `${traefikServiceId}-in`,
        })
        // The shared ingress Docker network is that same component serviceId —
        // the daemon must never reconstruct it from a literal.
        assertEquals(payload.hostingIngressNetwork, traefikServiceId)
      } finally {
        if (hostingServiceId) {
          await db.delete(hosting).where(eq(hosting.serviceId, hostingServiceId))
        }
        systemHierarchyProvision.ensure = originalEnsure
      }
    }
  )
})

test("POST /environments/:id/deploy uses internal TLS after revoking a Let's Encrypt pin", async () => {
  const traefikServiceId = '00000000-0000-4000-8000-0000000000ab'
  await withDeployFixtures(
    async ({
      db,
      app,
      secrets,
      userId,
      organizationId,
      projectId,
      environmentId,
      serverId,
      commandQueue,
    }) => {
      const originalEnsure = systemHierarchyProvision.ensure
      systemHierarchyProvision.ensure = () =>
        Promise.resolve({
          workspaceId: '00000000-0000-4000-8000-0000000000bb',
          projectId: '00000000-0000-4000-8000-0000000000cc',
          environmentId: '00000000-0000-4000-8000-0000000000dd',
          serviceId: traefikServiceId,
          containerRowId: '00000000-0000-4000-8000-0000000000ee',
          containerName: `${traefikServiceId}-in`,
        })
      let hostingServiceId: string | undefined
      let tlsId: string | undefined
      try {
        await db
          .update(environment)
          .set({
            serverId,
            name: 'Production',
            options: { compose: emptyComposeDocument() },
            updatedAt: new Date().toISOString(),
          })
          .where(eq(environment.id, environmentId))
        await db
          .update(project)
          .set({
            options: { compose: composeWithWebService() },
            updatedAt: new Date().toISOString(),
          })
          .where(eq(project.id, projectId))
        // POST /tls source:lets_encrypt requires the org to have opted in to
        // ACME (organization.options.acmeEnabled, off by default).
        await db
          .update(organization)
          .set({ options: { acmeEnabled: true } })
          .where(eq(organization.id, organizationId))

        const cookie = await sessionCookie(db, secrets, userId)
        const headers = {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        }

        const createTls = await app.request('/tls', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            source: 'lets_encrypt',
            name: 'Deploy revoke LE',
            hostnames: ['app.example.com'],
            challengeType: 'http-01',
          }),
        })
        assertEquals(createTls.status, 200)
        const created = (await createTls.json()) as { ok: true; id: string }
        tlsId = created.id

        const [svc] = await db
          .insert(service)
          .values({
            environmentId,
            name: 'web',
            composeServiceName: 'web',
          })
          .returning({ id: service.id })
        hostingServiceId = svc!.id
        await db.insert(hosting).values({
          serviceId: svc!.id,
          tlsId: created.id,
          options: { hostnames: ['app.example.com'] },
        })

        const revoke = await app.request(`/tls/${created.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ revoke: true }),
        })
        assertEquals(revoke.status, 200)

        const res = await app.request(`/environments/${environmentId}/deploy`, {
          method: 'POST',
          headers,
          body: '{}',
        })
        assertEquals(res.status, 200)
        const body = (await res.json()) as { ok: boolean; commandId: string }
        assertEquals(body.ok, true)
        assertEquals(commandQueue.envelopes.length, 1)

        const [row] = await db
          .select({ payload: dispatch.payload })
          .from(dispatch)
          .where(eq(dispatch.commandId, body.commandId))
          .limit(1)
        const payload = row?.payload as {
          hostings: Array<{ tlsId?: string | null; tlsMode?: string }>
          tlsMaterial?: unknown[]
        }
        assertEquals(payload.hostings.length, 1)
        assertEquals(payload.hostings[0]?.tlsId ?? null, null)
        assertEquals(payload.hostings[0]?.tlsMode, undefined)
        assertEquals(payload.tlsMaterial ?? [], [])
      } finally {
        if (hostingServiceId) {
          await db.delete(hosting).where(eq(hosting.serviceId, hostingServiceId))
        }
        if (tlsId) {
          await db.delete(tls).where(eq(tls.id, tlsId))
        }
        systemHierarchyProvision.ensure = originalEnsure
      }
    }
  )
})

test('POST /environments/:id/deploy uses project defaultServerId when env pin is unset', async () => {
  await withDeployFixtures(
    async ({
      db,
      app,
      secrets,
      userId,
      organizationId,
      projectId,
      environmentId,
      serverId,
      commandQueue,
    }) => {
      await db
        .update(project)
        .set({
          options: {
            compose: composeWithWebService(),
            defaultServerId: serverId,
          },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))
      await db
        .update(environment)
        .set({
          serverId: null,
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      assertEquals(res.status, 200)
      assertEquals(commandQueue.envelopes.length, 1)
      assertEquals(commandQueue.envelopes[0]!.serverId, serverId)
    }
  )
})

test('POST /environments/:id/deploy rejects empty compose', async () => {
  await withDeployFixtures(
    async ({
      db,
      app,
      secrets,
      userId,
      organizationId,
      projectId,
      environmentId,
      serverId,
      commandQueue,
    }) => {
      await db
        .update(environment)
        .set({
          serverId,
          options: { compose: composeWithEmptyServices() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))
      await db
        .update(project)
        .set({
          options: { compose: emptyComposeDocument() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      assertEquals(res.status, 400)
      assertEquals(await res.json(), { error: 'compose_empty' })
      assertEquals(commandQueue.envelopes.length, 0)
    }
  )
})

test('POST /environments/:id/deploy pinned auto-resolves without body serverId', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      await db
        .update(environment)
        .set({
          serverId,
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })

      assertEquals(res.status, 200)
      const body = (await res.json()) as {
        ok: boolean
        commandId: string
        status: string
      }
      assertEquals(body.ok, true)
      assertEquals(body.status, 'queued')
      assertEquals(commandQueue.envelopes.length, 1)
      assertEquals(commandQueue.envelopes[0]!.serverId, serverId)
      assertEquals(commandQueue.envelopes[0]!.type, 'environment.deploy')

      const [envRow] = await db
        .select({
          serverId: environment.serverId,
          metadata: environment.metadata,
        })
        .from(environment)
        .where(eq(environment.id, environmentId))
        .limit(1)
      assertEquals(envRow?.serverId, serverId)
      const metadata = envRow?.metadata as { serverId?: string } | null
      assertEquals(metadata?.serverId, undefined)
    }
  )
})

test('POST /environments/:id/deploy ignores body serverId and uses environment.server_id', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      const now = new Date().toISOString()
      const [otherServer] = await db
        .insert(server)
        .values({
          organizationId,
          name: 'Deploy Route Other Server',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: server.id })
      const otherServerId = otherServer!.id

      try {
        await db
          .update(environment)
          .set({
            serverId,
            options: { compose: composeWithWebService() },
            updatedAt: new Date().toISOString(),
          })
          .where(eq(environment.id, environmentId))

        const cookie = await sessionCookie(db, secrets, userId)
        const res = await app.request(`/environments/${environmentId}/deploy`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ serverId: otherServerId }),
        })

        assertEquals(res.status, 200)
        assertEquals(commandQueue.envelopes.length, 1)
        assertEquals(commandQueue.envelopes[0]!.serverId, serverId)
      } finally {
        await db.delete(command).where(eq(command.serverId, otherServerId))
        await db.delete(command).where(eq(command.serverId, serverId))
        await db.delete(server).where(eq(server.id, otherServerId))
      }
    }
  )
})

test('POST /environments/:id/deploy requires persisted environment.server_id', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      await db
        .update(environment)
        .set({
          serverId: null,
          options: { compose: composeWithWebService() },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))

      const cookie = await sessionCookie(db, secrets, userId)

      const bodyServerIdRes = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ serverId }),
      })
      assertEquals(bodyServerIdRes.status, 409)
      assertEquals(await bodyServerIdRes.json(), {
        error: 'server_placement_required',
      })
      assertEquals(commandQueue.envelopes.length, 0)

      const missingRes = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      assertEquals(missingRes.status, 409)
      assertEquals(await missingRes.json(), {
        error: 'server_placement_required',
      })
      assertEquals(commandQueue.envelopes.length, 0)
    }
  )
})

test('POST /environments/:id/deploy stale environment pin returns 409', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, commandQueue }) => {
      const now = new Date().toISOString()
      const [foreignOrg] = await db
        .insert(organization)
        .values({ name: 'Deploy Route Foreign Org' })
        .returning({ id: organization.id })
      const foreignOrgId = foreignOrg!.id
      const [foreignServer] = await db
        .insert(server)
        .values({
          organizationId: foreignOrgId,
          name: 'Foreign Server',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: server.id })
      const foreignServerId = foreignServer!.id

      try {
        await db
          .update(environment)
          .set({
            serverId: foreignServerId,
            options: { compose: composeWithWebService() },
            updatedAt: new Date().toISOString(),
          })
          .where(eq(environment.id, environmentId))

        const cookie = await sessionCookie(db, secrets, userId)
        const res = await app.request(`/environments/${environmentId}/deploy`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })

        assertEquals(res.status, 409)
        assertEquals(await res.json(), { error: 'server_placement_required' })
        assertEquals(commandQueue.envelopes.length, 0)
      } finally {
        await db
          .update(environment)
          .set({ serverId: null, updatedAt: new Date().toISOString() })
          .where(eq(environment.id, environmentId))
        await db.delete(server).where(eq(server.id, foreignServerId))
        await db.delete(organization).where(eq(organization.id, foreignOrgId))
      }
    }
  )
})

test('POST /environments/:id/deploy rejects stored compose placement', async () => {
  await withDeployFixtures(
    async ({
      db,
      app,
      secrets,
      userId,
      organizationId,
      projectId,
      environmentId,
      serverId,
      commandQueue,
    }) => {
      // Stored compose placement must fail deploy — placement lives on environment.server_id.
      await db
        .update(project)
        .set({
          options: {
            compose: {
              version: 1,
              data: {
                services: { web: { image: 'nginx:alpine' } },
                'x-turbopanel': { placement: { server_id: crypto.randomUUID() } },
              },
              presentation: {
                keyOrder: ['services', 'x-turbopanel'],
                comments: {},
              },
            },
          },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(project.id, projectId))
      await db
        .update(environment)
        .set({
          serverId,
          options: composeWithWebService(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      assertEquals(res.status, 400)
      assertEquals(await res.json(), { error: 'Invalid compose document' })
      assertEquals(commandQueue.envelopes.length, 0)
    }
  )
})

test('POST /environments/:id/deploy rejects environment overlay compose placement', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      await db
        .update(environment)
        .set({
          serverId,
          options: {
            compose: {
              version: 1,
              data: {
                services: { web: { image: 'nginx:alpine' } },
                'x-turbopanel': { placement: { server_id: crypto.randomUUID() } },
              },
              presentation: {
                keyOrder: ['services', 'x-turbopanel'],
                comments: {},
              },
            },
          },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      assertEquals(res.status, 400)
      assertEquals(await res.json(), { error: 'Invalid compose document' })
      assertEquals(commandQueue.envelopes.length, 0)
    }
  )
})

test('POST /environments/:id/lifecycle enqueues environment.lifecycle', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      await db
        .update(environment)
        .set({
          serverId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/lifecycle`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'stop' }),
      })
      assertEquals(res.status, 200)
      const body = (await res.json()) as {
        ok: boolean
        commandId: string
        status: string
        serverId: string
      }
      assertEquals(body.ok, true)
      assertEquals(body.status, 'queued')
      assertEquals(body.serverId, serverId)
      assertEquals(commandQueue.envelopes.length, 1)
      assertEquals(commandQueue.envelopes[0]!.type, 'environment.lifecycle')
      assertEquals(commandQueue.envelopes[0]!.serverId, serverId)
    }
  )
})

test('POST /environments/:id/lifecycle rejects unknown action', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      await db
        .update(environment)
        .set({
          serverId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/lifecycle`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'down' }),
      })
      assertEquals(res.status, 400)
      assertEquals(await res.json(), { error: 'Invalid request' })
      assertEquals(commandQueue.envelopes.length, 0)
    }
  )
})

test('POST /environments/:id/lifecycle requires persisted environment.server_id', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, commandQueue }) => {
      await db
        .update(environment)
        .set({
          serverId: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/lifecycle`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'start' }),
      })
      assertEquals(res.status, 409)
      assertEquals(await res.json(), { error: 'server_placement_required' })
      assertEquals(commandQueue.envelopes.length, 0)
    }
  )
})

test('POST /environments/:id/lifecycle returns 403 for non-manager', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      await db
        .update(environment)
        .set({
          serverId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))
      await db
        .delete(grant)
        .where(and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)))

      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/environments/${environmentId}/lifecycle`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'start' }),
      })
      assertEquals(res.status, 403)
      assertEquals(commandQueue.envelopes.length, 0)
    }
  )
})

test('POST /environments/:id/lifecycle returns 404 for cross-org environment', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, serverId, commandQueue }) => {
      const [foreignOrg] = await db
        .insert(organization)
        .values({ name: 'Lifecycle Foreign Org' })
        .returning({ id: organization.id })
      const foreignOrgId = foreignOrg!.id
      const [foreignWorkspace] = await db
        .insert(workspace)
        .values({ name: 'Foreign Workspace', organizationId: foreignOrgId })
        .returning({ id: workspace.id })
      const [foreignProject] = await db
        .insert(project)
        .values({
          name: 'Foreign Project',
          workspaceId: foreignWorkspace!.id,
          organizationId: foreignOrgId,
          options: { compose: emptyComposeDocument() },
        })
        .returning({ id: project.id })
      const [foreignEnvironment] = await db
        .insert(environment)
        .values({
          name: 'Foreign Env',
          projectId: foreignProject!.id,
          serverId,
          options: { compose: emptyComposeDocument() },
        })
        .returning({ id: environment.id })

      try {
        const cookie = await sessionCookie(db, secrets, userId)
        const res = await app.request(`/environments/${foreignEnvironment!.id}/lifecycle`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'start' }),
        })
        assertEquals(res.status, 404)
        assertEquals(commandQueue.envelopes.length, 0)
      } finally {
        await db.delete(environment).where(eq(environment.id, foreignEnvironment!.id))
        await db.delete(project).where(eq(project.id, foreignProject!.id))
        await db.delete(workspace).where(eq(workspace.id, foreignWorkspace!.id))
        await db.delete(organization).where(eq(organization.id, foreignOrgId))
      }
    }
  )
})

const WG_PUBKEY_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const WG_PUBKEY_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='

async function cleanupMultiServerFabricDeploy(
  db: ReturnType<typeof createDenoDb>,
  params: {
    environmentId: string
    organizationId: string
    serverIds: readonly string[]
    extraServerId: string
  }
): Promise<void> {
  const serverIds = [...params.serverIds]
  await db.delete(command).where(inArray(command.serverId, serverIds))
  await db.delete(container).where(inArray(container.serverId, serverIds))
  await db.delete(deployment).where(eq(deployment.environmentId, params.environmentId))
  await db.delete(slot).where(eq(slot.environmentId, params.environmentId))
  await db.delete(subnet).where(inArray(subnet.serverId, serverIds))
  await db
    .delete(network)
    .where(and(eq(network.organizationId, params.organizationId), eq(network.kind, 'compose')))
  await db.delete(fabric).where(eq(fabric.organizationId, params.organizationId))
  await db.delete(server).where(eq(server.id, params.extraServerId))
}

async function settleFabricReconcileEnqueue(
  db: ReturnType<typeof createDenoDb>,
  params: {
    organizationId: string
    envelope: CommandEnvelope
    settleStatus: 'succeeded' | 'failed' | 'queued'
  }
): Promise<void> {
  if (params.envelope.type !== 'server.fabric.reconcile') return
  if (params.settleStatus === 'queued') return
  await transitionCommand(db, params.envelope.commandId, {
    status: params.settleStatus,
    ...(params.settleStatus === 'failed' ? { error: 'apply failed' } : {}),
  })
  if (params.settleStatus !== 'succeeded') return
  const metadata = await getCommandMetadata(db, params.envelope.commandId)
  const desiredHash = typeof metadata?.desiredHash === 'string' ? metadata.desiredHash : null
  const fabricRow = await getOrganizationFabric(db, params.organizationId)
  if (!desiredHash || !fabricRow) return
  await stampRelayReconcileSuccess(db, {
    fabricId: fabricRow.id,
    serverId: params.envelope.serverId,
    appliedPayloadHash: desiredHash,
  })
}

async function prepareMultiServerFabricDeploy(
  db: ReturnType<typeof createDenoDb>,
  params: {
    organizationId: string
    environmentId: string
    serverId: string
    commandQueue: ReturnType<typeof createRecordingCommandQueue>
    settleStatus: 'succeeded' | 'failed' | 'queued'
  }
): Promise<string> {
  const now = new Date().toISOString()
  await db
    .update(server)
    .set({ isConnected: true, updatedAt: now })
    .where(eq(server.id, params.serverId))
  const [extraServer] = await db
    .insert(server)
    .values({
      organizationId: params.organizationId,
      name: 'Deploy Route Fabric Peer',
      isConnected: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const extraServerId = extraServer!.id

  const fabricRow = await enableOrganizationFabric(db, params.organizationId)
  const relays = await listFabricRelays(db, fabricRow.id)
  const keys = [WG_PUBKEY_A, WG_PUBKEY_B]
  for (const [index, row] of relays.entries()) {
    await stampRelayPublicKey(db, {
      fabricId: fabricRow.id,
      serverId: row.serverId,
      publicKey: keys[index] ?? WG_PUBKEY_A,
    })
    await updateFabricRelay(db, {
      fabricId: fabricRow.id,
      serverId: row.serverId,
      endpointAddress: `203.0.113.${10 + index}`,
    })
  }

  await db
    .update(environment)
    .set({
      serverId: null,
      options: { compose: composeWithReplicatedWebService() },
      updatedAt: now,
    })
    .where(eq(environment.id, params.environmentId))

  const originalEnqueue = params.commandQueue.enqueue.bind(params.commandQueue)
  params.commandQueue.enqueue = async (envelope) => {
    await originalEnqueue(envelope)
    await settleFabricReconcileEnqueue(db, {
      organizationId: params.organizationId,
      envelope,
      settleStatus: params.settleStatus,
    })
  }

  return extraServerId
}

test('POST /environments/:id/deploy waits for fabric reconcile before environment.deploy', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      const extraServerId = await prepareMultiServerFabricDeploy(db, {
        organizationId,
        environmentId,
        serverId,
        commandQueue,
        settleStatus: 'succeeded',
      })
      try {
        const cookie = await sessionCookie(db, secrets, userId)
        const res = await app.request(`/environments/${environmentId}/deploy`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
        assertEquals(res.status, 200)
        const types = commandQueue.envelopes.map((envelope) => envelope.type)
        const lastFabric = types.lastIndexOf('server.fabric.reconcile')
        const firstDeploy = types.indexOf('environment.deploy')
        assertEquals(types.filter((type) => type === 'server.fabric.reconcile').length >= 1, true)
        assertEquals(types.filter((type) => type === 'environment.deploy').length, 2)
        assertEquals(lastFabric >= 0 && firstDeploy > lastFabric, true)
      } finally {
        await cleanupMultiServerFabricDeploy(db, {
          environmentId,
          organizationId,
          serverIds: [serverId, extraServerId],
          extraServerId,
        })
      }
    }
  )
})

test('POST /environments/:id/deploy returns 422 when fabric reconcile fails without mutating generation', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      const extraServerId = await prepareMultiServerFabricDeploy(db, {
        organizationId,
        environmentId,
        serverId,
        commandQueue,
        settleStatus: 'failed',
      })
      try {
        const cookie = await sessionCookie(db, secrets, userId)
        const res = await app.request(`/environments/${environmentId}/deploy`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
        assertEquals(res.status, 422)
        const body = (await res.json()) as { error?: string }
        assertEquals(body.error, 'fabric_reconcile_failed')
        assertEquals(
          commandQueue.envelopes.some((envelope) => envelope.type === 'environment.deploy'),
          false
        )
        const [envRow] = await db
          .select({ generation: environment.generation })
          .from(environment)
          .where(eq(environment.id, environmentId))
          .limit(1)
        assertEquals(envRow?.generation, 0)
        const deployments = await db
          .select({ id: deployment.id })
          .from(deployment)
          .where(eq(deployment.environmentId, environmentId))
        assertEquals(deployments.length, 0)
        const leftover = await listEnvironmentComposeNetworks(db, environmentId)
        assertEquals(leftover.length, 0)
        assertEquals(
          leftover.reduce((count, row) => count + row.segments.length, 0),
          0
        )
      } finally {
        await cleanupMultiServerFabricDeploy(db, {
          environmentId,
          organizationId,
          serverIds: [serverId, extraServerId],
          extraServerId,
        })
      }
    }
  )
})

test('POST /environments/:id/deploy purges spanning networks when fabric gate times out', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      setFabricConvergenceTimeoutMsForTests(0)
      const extraServerId = await prepareMultiServerFabricDeploy(db, {
        organizationId,
        environmentId,
        serverId,
        commandQueue,
        settleStatus: 'queued',
      })
      try {
        const cookie = await sessionCookie(db, secrets, userId)
        const res = await app.request(`/environments/${environmentId}/deploy`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
        assertEquals(res.status, 409)
        const body = (await res.json()) as { error?: string }
        assertEquals(body.error, 'fabric_reconcile_pending')
        assertEquals(
          commandQueue.envelopes.some((envelope) => envelope.type === 'environment.deploy'),
          false
        )
        const leftoverAfterTimeout = await listEnvironmentComposeNetworks(db, environmentId)
        assertEquals(leftoverAfterTimeout.length, 0)
      } finally {
        setFabricConvergenceTimeoutMsForTests(undefined)
        await cleanupMultiServerFabricDeploy(db, {
          environmentId,
          organizationId,
          serverIds: [serverId, extraServerId],
          extraServerId,
        })
      }
    }
  )
})

test('POST /environments/:id/deploy purges spanning networks when prepare fails', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      const extraServerId = await prepareMultiServerFabricDeploy(db, {
        organizationId,
        environmentId,
        serverId,
        commandQueue,
        settleStatus: 'succeeded',
      })
      await db
        .update(environment)
        .set({
          options: {
            compose: {
              version: 1,
              data: {
                services: {
                  web: {
                    image: 'nginx:alpine',
                    environment: { MISSING: '{$project.does_not_exist}' },
                    deploy: { replicas: 2 },
                  },
                },
              },
              presentation: { keyOrder: ['services'], comments: {} },
            },
          },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(environment.id, environmentId))
      try {
        const cookie = await sessionCookie(db, secrets, userId)
        const res = await app.request(`/environments/${environmentId}/deploy`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
        assertEquals(res.status, 422)
        const body = (await res.json()) as { error?: string }
        assertEquals(body.error, 'variable_unresolved')
        assertEquals(
          commandQueue.envelopes.some((envelope) => envelope.type === 'environment.deploy'),
          false
        )
        const leftoverAfterPrepare = await listEnvironmentComposeNetworks(db, environmentId)
        assertEquals(leftoverAfterPrepare.length, 0)
      } finally {
        await cleanupMultiServerFabricDeploy(db, {
          environmentId,
          organizationId,
          serverIds: [serverId, extraServerId],
          extraServerId,
        })
      }
    }
  )
})

test('POST /environments/:id/deploy records per-server failures when queue delivery fails mid fan-out', async () => {
  await withDeployFixtures(
    async ({ db, app, secrets, userId, organizationId, environmentId, serverId, commandQueue }) => {
      const extraServerId = await prepareMultiServerFabricDeploy(db, {
        organizationId,
        environmentId,
        serverId,
        commandQueue,
        settleStatus: 'succeeded',
      })
      const innerEnqueue = commandQueue.enqueue.bind(commandQueue)
      let deployEnqueues = 0
      commandQueue.enqueue = async (envelope) => {
        if (envelope.type === 'environment.deploy') {
          deployEnqueues += 1
          if (deployEnqueues >= 2) {
            throw new Error('queue down')
          }
        }
        await innerEnqueue(envelope)
      }
      try {
        const cookie = await sessionCookie(db, secrets, userId)
        const res = await app.request(`/environments/${environmentId}/deploy`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
        assertEquals(res.status, 200)
        const body = (await res.json()) as {
          commands?: Array<{ serverId: string; status: string }>
        }
        assertEquals(body.commands?.length, 1)
        assertEquals(body.commands?.[0]?.status, 'queued')

        const targets = await db
          .select({
            serverId: deployment.serverId,
            status: deployment.status,
            lastCommandId: deployment.lastCommandId,
          })
          .from(deployment)
          .where(eq(deployment.environmentId, environmentId))
        const statuses = targets.map((row) => row.status).sort((a, b) => a.localeCompare(b))
        assertEquals(targets.length, 2)
        assertEquals(statuses, ['applying', 'failed'])
        assertEquals(
          targets.every((row) => row.lastCommandId != null),
          true
        )
        const applying = targets.find((row) => row.status === 'applying')
        assertEquals(body.commands?.[0]?.serverId, applying?.serverId)

        const deployCommands = await db
          .select({
            id: command.id,
            status: command.status,
          })
          .from(command)
          .where(
            and(
              eq(command.name, 'environment.deploy'),
              inArray(command.serverId, [serverId, extraServerId])
            )
          )
        const commandStatuses = deployCommands
          .map((row) => row.status)
          .sort((a, b) => a.localeCompare(b))
        assertEquals(deployCommands.length, 2)
        assertEquals(commandStatuses, ['failed', 'queued'])

        // Spanning compose networks only materialize when the plan places
        // replicas on more than one server (see `collectSpanningComposeNetworkKeys`);
        // pin that precondition down explicitly so a placement regression fails
        // here with a clear signal instead of surfacing as an empty `leftover`
        // below with no indication of why.
        const placement = await db
          .select({ serverId: slot.serverId })
          .from(slot)
          .where(eq(slot.environmentId, environmentId))
        assertEquals([...new Set(placement.map((row) => row.serverId))].sort().length, 2)

        const leftover = await listEnvironmentComposeNetworks(db, environmentId)
        assertEquals(leftover.length > 0, true)
        assertEquals(
          leftover.some((row) => row.segments.length > 0),
          true
        )
      } finally {
        await cleanupMultiServerFabricDeploy(db, {
          environmentId,
          organizationId,
          serverIds: [serverId, extraServerId],
          extraServerId,
        })
      }
    }
  )
})

type TwoServerCtx = {
  db: ReturnType<typeof createDenoDb>
  app: Hono<AppEnv>
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
  userId: string
  organizationId: string
  environmentId: string
  serverId: string
  commandQueue: ReturnType<typeof createRecordingCommandQueue>
}

type TwoServerOptions = {
  updateConfig?: Record<string, unknown>
  /** Status the deploy answers with; 200 unless the queue is made to fail. */
  expectStatus?: number
  /** Make every `environment.deploy` enqueue throw. */
  failDeployEnqueue?: boolean
}

/** POST to an environment route as the fixture user. */
function postEnvironment(ctx: TwoServerCtx, path: string, body = '{}'): Promise<Response> {
  return sessionCookie(ctx.db, ctx.secrets, ctx.userId).then((cookie) =>
    ctx.app.request(`/environments/${ctx.environmentId}/${path}`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: ctx.organizationId,
        'Content-Type': 'application/json',
      },
      body,
    })
  )
}

/** Run the two-server deploy under `deployStrategy: sequential`, with an optional update_config. */
async function deployTwoServersSequentially(
  ctx: TwoServerCtx,
  options: TwoServerOptions,
  check: (input: {
    body: {
      commands: Array<{ serverId: string }>
      strategy: { rollout: { parallelism: number; batches: number } }
    }
    serverIds: string[]
  }) => Promise<void>
): Promise<void> {
  const { db, organizationId, environmentId, serverId, commandQueue } = ctx
  const extraServerId = await prepareMultiServerFabricDeploy(db, {
    organizationId,
    environmentId,
    serverId,
    commandQueue,
    settleStatus: 'succeeded',
  })
  const compose = composeWithReplicatedWebService()
  if (options.updateConfig !== undefined) {
    const services = compose.data.services as Record<string, { deploy: Record<string, unknown> }>
    services.web!.deploy.update_config = options.updateConfig
  }
  await db
    .update(environment)
    .set({ options: { compose, deployStrategy: 'sequential' } })
    .where(eq(environment.id, environmentId))
  if (options.failDeployEnqueue) {
    const inner = commandQueue.enqueue.bind(commandQueue)
    commandQueue.enqueue = async (envelope) => {
      if (envelope.type === 'environment.deploy') throw new Error('queue down')
      await inner(envelope)
    }
  }
  try {
    const res = await postEnvironment(ctx, 'deploy')
    assertEquals(res.status, options.expectStatus ?? 200)
    await check({
      body: (await res.json()) as Parameters<typeof check>[0]['body'],
      serverIds: [serverId, extraServerId],
    })
  } finally {
    await cleanupMultiServerFabricDeploy(db, {
      environmentId,
      organizationId,
      serverIds: [serverId, extraServerId],
      extraServerId,
    })
  }
}

/** Every deployment target of the environment, by server. */
async function targetsByServer(ctx: TwoServerCtx): Promise<Map<string, string>> {
  const rows = await ctx.db
    .select({ serverId: deployment.serverId, status: deployment.status })
    .from(deployment)
    .where(eq(deployment.environmentId, ctx.environmentId))
  return new Map(rows.map((row) => [row.serverId, row.status]))
}

test('POST /environments/:id/deploy on a sequential environment queues one server, holds the rest', async () => {
  await withDeployFixtures(async (ctx) => {
    await deployTwoServersSequentially(ctx, {}, async ({ body, serverIds }) => {
      assertEquals(body.strategy.rollout, { parallelism: 1, batches: 2 })
      assertEquals(body.commands.length, 1)
      const queuedDeploys = ctx.commandQueue.envelopes.filter(
        (envelope) => envelope.type === 'environment.deploy'
      )
      assertEquals(queuedDeploys.length, 1)
      const first = body.commands[0]!.serverId
      const second = serverIds.find((id) => id !== first)!

      const targets = await ctx.db
        .select({
          serverId: deployment.serverId,
          status: deployment.status,
          options: deployment.options,
        })
        .from(deployment)
        .where(eq(deployment.environmentId, ctx.environmentId))
      assertEquals(targets.find((row) => row.serverId === first)?.status, 'applying')
      const held = targets.find((row) => row.serverId === second)
      assertEquals(held?.status, 'pending')
      assertEquals((held?.options as { rollout?: unknown }).rollout, { batch: 1, batches: 2 })

      // The held server's command exists and was never handed to the queue.
      const [heldCommand] = await ctx.db
        .select({ id: command.id, status: command.status })
        .from(command)
        .where(and(eq(command.name, 'environment.deploy'), eq(command.serverId, second)))
      assertEquals(heldCommand?.status, 'queued')
      assertEquals(
        queuedDeploys.some((envelope) => envelope.commandId === heldCommand?.id),
        false
      )
    })
  })
})

test('POST /environments/:id/deploy with update_config.parallelism 0 queues every server at once', async () => {
  await withDeployFixtures(async (ctx) => {
    await deployTwoServersSequentially(
      ctx,
      { updateConfig: { parallelism: 0 } },
      async ({ body }) => {
        assertEquals(body.strategy.rollout, { parallelism: 0, batches: 1 })
        assertEquals(body.commands.length, 2)
      }
    )
  })
})

test('POST /environments/:id/deploy with update_config.parallelism 2 queues both servers in one batch', async () => {
  await withDeployFixtures(async (ctx) => {
    await deployTwoServersSequentially(
      ctx,
      { updateConfig: { parallelism: 2 } },
      async ({ body }) => {
        assertEquals(body.strategy.rollout, { parallelism: 2, batches: 1 })
        assertEquals(body.commands.length, 2)
      }
    )
  })
})

test('POST /environments/:id/deploy: a first-batch server that cannot be reached stops the rollout', async () => {
  await withDeployFixtures(async (ctx) => {
    await deployTwoServersSequentially(
      ctx,
      { failDeployEnqueue: true, expectStatus: 503 },
      async ({ serverIds }) => {
        const targets = await targetsByServer(ctx)
        assertEquals([...targets.values()], ['failed', 'failed'])
        const commands = await ctx.db
          .select({ status: command.status })
          .from(command)
          .where(and(eq(command.name, 'environment.deploy'), inArray(command.serverId, serverIds)))
        assertEquals(
          commands.map((row) => row.status).toSorted((a, b) => a.localeCompare(b)),
          ['cancelled', 'failed']
        )
      }
    )
  })
})

test('POST /environments/:id/stop mid-rollout cancels the servers still waiting', async () => {
  await withDeployFixtures(async (ctx) => {
    await deployTwoServersSequentially(ctx, {}, async ({ body, serverIds }) => {
      const first = body.commands[0]!.serverId
      const held = serverIds.find((id) => id !== first)!
      assertEquals((await targetsByServer(ctx)).get(held), 'pending')

      const stopped = await postEnvironment(ctx, 'stop')
      assertEquals(stopped.status, 200)

      const targets = await targetsByServer(ctx)
      assertEquals(targets.get(held), 'failed')
      assertEquals(targets.get(first), 'applying')
      const [heldCommand] = await ctx.db
        .select({ status: command.status })
        .from(command)
        .where(and(eq(command.name, 'environment.deploy'), eq(command.serverId, held)))
      assertEquals(heldCommand?.status, 'cancelled')
    })
  })
})

test('POST /environments/:id/deploy refuses an update_config setting nothing acts on yet', async () => {
  await withDeployFixtures(async (ctx) => {
    const extraServerId = await prepareMultiServerFabricDeploy(ctx.db, {
      organizationId: ctx.organizationId,
      environmentId: ctx.environmentId,
      serverId: ctx.serverId,
      commandQueue: ctx.commandQueue,
      settleStatus: 'succeeded',
    })
    const compose = composeWithReplicatedWebService()
    const services = compose.data.services as Record<string, { deploy: Record<string, unknown> }>
    services.web!.deploy.update_config = { parallelism: 1, delay: '10s' }
    await ctx.db
      .update(environment)
      .set({ options: { compose, deployStrategy: 'sequential' } })
      .where(eq(environment.id, ctx.environmentId))
    try {
      const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
      const res = await ctx.app.request(`/environments/${ctx.environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: ctx.organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      assertEquals(res.status, 422)
      const body = (await res.json()) as { error?: string; message?: string }
      assertEquals(body.error, 'compose_field_unsupported')
      assertEquals(body.message?.includes('update_config.delay'), true)
      assertEquals(
        ctx.commandQueue.envelopes.some((envelope) => envelope.type === 'environment.deploy'),
        false
      )
    } finally {
      await cleanupMultiServerFabricDeploy(ctx.db, {
        environmentId: ctx.environmentId,
        organizationId: ctx.organizationId,
        serverIds: [ctx.serverId, extraServerId],
        extraServerId,
      })
    }
  })
})

// --- host-level Compose features (audit S1, 2026-09-25) ---------------------

const DOCKER_SOCKET_BIND = '/var/run/docker.sock:/var/run/docker.sock'

function composeWithBind(bind: string): ComposeDocument {
  return {
    version: 1,
    data: { services: { web: { image: 'traefik:v3', volumes: [bind] } } },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

type HostLevelCtx = {
  db: ReturnType<typeof createDenoDb>
  app: Hono<AppEnv>
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
  userId: string
  organizationId: string
  projectId: string
  environmentId: string
  serverId: string
  commandQueue: ReturnType<typeof createRecordingCommandQueue>
}

const appsWithWebhookRoute = new WeakSet<Hono<AppEnv>>()

/**
 * Mount a stand-in for the GitHub webhook: the same
 * `runEnvironmentDeployForActor` the webhook trigger calls, with no person
 * behind it. Hono freezes its routes on the first request, so this is mounted
 * before any — once per app.
 */
function mountWebhookRoute(ctx: HostLevelCtx): void {
  if (appsWithWebhookRoute.has(ctx.app)) return
  appsWithWebhookRoute.add(ctx.app)
  ctx.app.post('/test/webhook-deploy/:id', (c) =>
    runEnvironmentDeployForActor(c, ctx.db, ctx.commandQueue, c.req.param('id'), {
      actorType: 'system',
      actorId: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      acknowledgeHealthCheckWarnings: true,
      noCache: false,
      selection: { ref: null, commitSha: null, sourceId: null },
    })
  )
}

/** Pin the environment, store `compose` on the project, set the org gate. */
async function useCompose(
  ctx: HostLevelCtx,
  compose: ComposeDocument,
  hostLevelEnabled: boolean
): Promise<void> {
  mountWebhookRoute(ctx)
  const now = new Date().toISOString()
  await ctx.db
    .update(environment)
    .set({ serverId: ctx.serverId, name: 'Production', updatedAt: now })
    .where(eq(environment.id, ctx.environmentId))
  await ctx.db
    .update(project)
    .set({ options: { compose }, updatedAt: now })
    .where(eq(project.id, ctx.projectId))
  await ctx.db
    .update(organization)
    .set({ options: { composeGatedFieldsEnabled: hostLevelEnabled } })
    .where(eq(organization.id, ctx.organizationId))
}

async function managerDeploy(ctx: HostLevelCtx): Promise<Response> {
  const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
  return await ctx.app.request(`/environments/${ctx.environmentId}/deploy`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: ctx.organizationId,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
}

/** A deploy through the mounted webhook stand-in (see `mountWebhookRoute`). */
async function webhookDeploy(ctx: HostLevelCtx): Promise<Response> {
  return await ctx.app.request(`/test/webhook-deploy/${ctx.environmentId}`, {
    method: 'POST',
  })
}

async function storedApproval(ctx: HostLevelCtx): Promise<unknown> {
  const [row] = await ctx.db
    .select({ metadata: environment.metadata })
    .from(environment)
    .where(eq(environment.id, ctx.environmentId))
    .limit(1)
  const metadata = row?.metadata as Record<string, unknown> | null
  return metadata?.composeHostAccessApproval
}

test('POST /environments/:id/deploy refuses a Docker socket bind while host-level features are off', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), false)

    const res = await managerDeploy(ctx)

    assertEquals(res.status, 403)
    const body = (await res.json()) as {
      error: string
      issues: Array<{ path: string }>
    }
    assertEquals(body.error, 'compose_field_requires_org_opt_in')
    assertEquals(
      body.issues.some((issue) => issue.path === 'services.web.volumes[0]'),
      true
    )
    assertEquals(ctx.commandQueue.envelopes.length, 0)
  })
})

test('POST /environments/:id/deploy runs binds inside the service directory with host-level features off', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind('./data:/data'), false)

    assertEquals((await managerDeploy(ctx)).status, 200)
    // Nothing host-level, so a webhook needs no approval either.
    assertEquals((await webhookDeploy(ctx)).status, 200)
    assertEquals(ctx.commandQueue.envelopes.length, 2)
  })
})

test('a webhook deploy of host-level content no manager has deployed is refused', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), true)

    const res = await webhookDeploy(ctx)

    assertEquals(res.status, 403)
    const body = (await res.json()) as { error: string }
    assertEquals(body.error, 'compose_host_access_requires_approval')
    assertEquals(ctx.commandQueue.envelopes.length, 0)
  })
})

test("a manager's deploy approves host-level content for later webhook deploys", async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), true)

    assertEquals((await managerDeploy(ctx)).status, 200)
    const approval = (await storedApproval(ctx)) as
      | {
          fingerprint: string
          approvedBy: string
        }
      | undefined
    assertEquals(approval?.approvedBy, ctx.userId)
    assertEquals(approval?.fingerprint.length, 64)

    assertEquals((await webhookDeploy(ctx)).status, 200)
    assertEquals(ctx.commandQueue.envelopes.length, 2)
  })
})

test('changing what reaches the host voids the approval for webhook deploys', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), true)
    assertEquals((await managerDeploy(ctx)).status, 200)

    // Same stack, now binding the host root instead of the socket.
    await useCompose(ctx, composeWithBind('/:/host'), true)
    const res = await webhookDeploy(ctx)

    assertEquals(res.status, 403)
    const body = (await res.json()) as { error: string }
    assertEquals(body.error, 'compose_host_access_requires_approval')
    assertEquals(ctx.commandQueue.envelopes.length, 1)
  })
})

test('a deploy preview approves nothing', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), true)
    const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)

    const preview = await ctx.app.request(`/environments/${ctx.environmentId}/deploy-preview`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: ctx.organizationId },
    })

    assertEquals(preview.status, 200)
    assertEquals(await storedApproval(ctx), undefined)
    assertEquals((await webhookDeploy(ctx)).status, 403)
  })
})

test('a person without organization:manage cannot deploy host-level content', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), true)

    const planned = await planEnvironmentDeploy(ctx.db, {
      environmentId: ctx.environmentId,
      organizationId: ctx.organizationId,
      hostAccess: { kind: 'not_manager' },
    })

    assertEquals('kind' in planned ? planned.kind : 'planned', 'compose_rejected')
    assertEquals(
      'kind' in planned && planned.kind === 'compose_rejected' ? planned.error.kind : null,
      'compose_host_access_requires_manager'
    )
  })
})

/** `hostLevelApproved` on the queued `environment.deploy` payload for a deploy response. */
async function payloadHostLevelApproved(ctx: HostLevelCtx, res: Response): Promise<unknown> {
  const body = (await res.json()) as { commandId: string }
  const [row] = await ctx.db
    .select({ payload: dispatch.payload })
    .from(dispatch)
    .where(eq(dispatch.commandId, body.commandId))
    .limit(1)
  return (row?.payload as Record<string, unknown> | undefined)?.hostLevelApproved
}

test("a manager's host-level deploy tells the daemon it is approved", async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), true)

    const res = await managerDeploy(ctx)

    assertEquals(res.status, 200)
    assertEquals(await payloadHostLevelApproved(ctx, res), true)
  })
})

test('a webhook deploy matching a recorded approval tells the daemon it is approved', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), true)
    assertEquals((await managerDeploy(ctx)).status, 200)

    const res = await webhookDeploy(ctx)

    assertEquals(res.status, 200)
    assertEquals(await payloadHostLevelApproved(ctx, res), true)
  })
})

test('a deploy that reaches nothing on the host carries no approval, even with the gate on', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind('./data:/data'), true)

    const res = await managerDeploy(ctx)

    assertEquals(res.status, 200)
    assertEquals(await payloadHostLevelApproved(ctx, res), undefined)
  })
})

test('the planner approves host-level content only for an allowed actor', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), true)
    const manager = await planEnvironmentDeploy(ctx.db, {
      environmentId: ctx.environmentId,
      organizationId: ctx.organizationId,
      hostAccess: { kind: 'manager', userId: ctx.userId, recordApproval: false },
    })
    assertEquals('kind' in manager ? manager.kind : manager.hostLevelApproved, true)

    await useCompose(ctx, composeWithBind('./data:/data'), true)
    const ordinary = await planEnvironmentDeploy(ctx.db, {
      environmentId: ctx.environmentId,
      organizationId: ctx.organizationId,
      hostAccess: { kind: 'automated' },
    })
    assertEquals('kind' in ordinary ? ordinary.kind : ordinary.hostLevelApproved, false)
  })
})

type StrategyPreviewBody = {
  strategy: string
  effectiveStrategy: string
  migrations: string
  fallbackReasons: Array<{ code: string; services: string[] }>
}

async function previewStrategy(
  ctx: Parameters<Parameters<typeof withDeployFixtures>[0]>[0],
  compose: ComposeDocument,
  environmentOptions: Record<string, unknown>,
  query = ''
): Promise<{ status: number; body: StrategyPreviewBody }> {
  await ctx.db
    .update(environment)
    .set({
      serverId: ctx.serverId,
      options: { compose: emptyComposeDocument(), ...environmentOptions },
      updatedAt: new Date().toISOString(),
    })
    .where(eq(environment.id, ctx.environmentId))
  await ctx.db
    .update(project)
    .set({ options: { compose }, updatedAt: new Date().toISOString() })
    .where(eq(project.id, ctx.projectId))
  const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
  const res = await ctx.app.request(`/environments/${ctx.environmentId}/deploy-preview${query}`, {
    headers: { Cookie: cookie, [ORG_ID_HEADER]: ctx.organizationId },
  })
  return { status: res.status, body: (await res.json()) as StrategyPreviewBody }
}

test('GET /environments/:id/deploy-preview reports inplace for an environment with no deploy settings', async () => {
  await withDeployFixtures(async (ctx) => {
    const { status, body } = await previewStrategy(ctx, composeWithWebService(), {})
    assertEquals(status, 200)
    assertEquals(body.strategy, 'inplace')
    assertEquals(body.effectiveStrategy, 'inplace')
    assertEquals(body.migrations, 'unknown')
    assertEquals(body.fallbackReasons, [])
  })
})

test('GET /environments/:id/deploy-preview explains a blue-green fallback', async () => {
  await withDeployFixtures(async (ctx) => {
    const { status, body } = await previewStrategy(ctx, composeWithNamedWebService(), {
      deployStrategy: 'bluegreen',
      migrations: 'compatible',
    })
    assertEquals(status, 200)
    assertEquals(body.strategy, 'bluegreen')
    assertEquals(body.effectiveStrategy, 'sequential')
    assertEquals(
      body.fallbackReasons.map((reason) => [reason.code, reason.services]),
      [
        ['authored_container_name', ['web']],
        ['bluegreen_unavailable', []],
      ]
    )
  })
})

test('GET /environments/:id/deploy-preview accepts what-if strategy and migration queries and refuses bad ones', async () => {
  await withDeployFixtures(async (ctx) => {
    const whatIf = await previewStrategy(
      ctx,
      composeWithWebService(),
      { deployStrategy: 'inplace' },
      '?strategy=bluegreen&migration=breaking'
    )
    assertEquals(whatIf.status, 200)
    assertEquals(whatIf.body.strategy, 'bluegreen')
    assertEquals(whatIf.body.migrations, 'breaking')
    assertEquals(whatIf.body.effectiveStrategy, 'sequential')
    assertEquals(
      whatIf.body.fallbackReasons.map((reason) => reason.code),
      ['migration_breaking', 'bluegreen_unavailable']
    )

    const bad = await previewStrategy(ctx, composeWithWebService(), {}, '?strategy=rolling')
    assertEquals(bad.status, 400)
  })
})

type RunCtx = HostLevelCtx & { workspaceId: string }

async function previewYaml(ctx: HostLevelCtx): Promise<string> {
  const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
  const res = await ctx.app.request(`/environments/${ctx.environmentId}/deploy-preview`, {
    headers: { Cookie: cookie, [ORG_ID_HEADER]: ctx.organizationId },
  })
  assertEquals(res.status, 200)
  const body = (await res.json()) as { composeFiles: Array<{ content: string }> }
  return body.composeFiles[0]?.content ?? ''
}

function composeOf(services: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data: { services },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

test('an environment overlay merges on top of the project base in what a deploy would run, and leaves the base alone', async () => {
  await withDeployFixtures(async (ctx) => {
    const base = composeOf({ web: { image: 'nginx:alpine' }, db: { image: 'postgres:17' } })
    const overlay = composeOf({ web: { image: 'nginx:1.27' }, api: { image: 'node:22' } })
    await ctx.db
      .update(project)
      .set({ options: { compose: base } })
      .where(eq(project.id, ctx.projectId))
    await ctx.db
      .update(environment)
      .set({ serverId: ctx.serverId, options: { compose: overlay } })
      .where(eq(environment.id, ctx.environmentId))

    const yaml = await previewYaml(ctx)

    // Overlay wins where both name a service; base-only and overlay-only services both survive.
    assertEquals(yaml.includes('image: nginx:1.27'), true)
    assertEquals(yaml.includes('nginx:alpine'), false)
    assertEquals(yaml.includes('image: postgres:17'), true)
    assertEquals(yaml.includes('image: node:22'), true)

    const [stored] = await ctx.db
      .select({ options: project.options })
      .from(project)
      .where(eq(project.id, ctx.projectId))
    assertEquals(
      (
        (stored?.options as { compose: ComposeDocument }).compose.data.services as Record<
          string,
          { image: string }
        >
      ).web.image,
      'nginx:alpine'
    )
  })
})

type LimitViolation = { scope: string; field: string; limit: number; requested: number }

async function pinServiceCpus(
  ctx: HostLevelCtx,
  cpusByService: Record<string, number>
): Promise<void> {
  await Promise.all(
    Object.entries(cpusByService).map(([name, cpus]) =>
      ctx.db
        .update(service)
        .set({ options: { resources: { cpus } } })
        .where(
          and(eq(service.environmentId, ctx.environmentId), eq(service.composeServiceName, name))
        )
    )
  )
}

async function deployBody(
  ctx: HostLevelCtx
): Promise<{ status: number; body: { error?: string; violations?: LimitViolation[] } }> {
  const res = await managerDeploy(ctx)
  return {
    status: res.status,
    body: (await res.json()) as { error?: string; violations?: LimitViolation[] },
  }
}

test('a deploy over the organization or server ceiling is refused with the limit named, and nothing is queued', async () => {
  await withDeployFixtures(async (ctx) => {
    const compose = composeOf({ web: { image: 'nginx:alpine' }, db: { image: 'postgres:17' } })
    await useCompose(ctx, compose, false)
    // The ceilings sum what each service row asks for (its pinned resources).
    await reconcileServicesForEnvironment(ctx.db, ctx.environmentId)
    await pinServiceCpus(ctx, { web: 2, db: 1 })

    await ctx.db
      .update(organization)
      .set({ options: { resourceLimits: { maxServicesPerEnvironment: 1 } } })
      .where(eq(organization.id, ctx.organizationId))
    const overOrg = await deployBody(ctx)
    assertEquals(overOrg.status, 409)
    assertEquals(overOrg.body.error, 'resource_limit_exceeded')
    assertEquals(overOrg.body.violations, [
      { scope: 'organization', field: 'maxServicesPerEnvironment', limit: 1, requested: 2 },
    ])

    await ctx.db
      .update(organization)
      .set({ options: {} })
      .where(eq(organization.id, ctx.organizationId))
    await ctx.db
      .update(server)
      .set({ options: { resourceLimits: { maxCpus: 2 } } })
      .where(eq(server.id, ctx.serverId))
    const overServer = await deployBody(ctx)
    assertEquals(overServer.status, 409)
    assertEquals(overServer.body.violations, [
      { scope: 'server', field: 'maxCpus', limit: 2, requested: 3 },
    ])
    assertEquals(ctx.commandQueue.envelopes.length, 0)

    // Within both ceilings the same stack deploys.
    await ctx.db
      .update(server)
      .set({ options: { resourceLimits: { maxCpus: 3 } } })
      .where(eq(server.id, ctx.serverId))
    assertEquals((await managerDeploy(ctx)).status, 200)
    assertEquals(ctx.commandQueue.envelopes.length, 1)
  })
})

async function setServerCeiling(ctx: HostLevelCtx, limits: Record<string, number>): Promise<void> {
  await ctx.db
    .update(server)
    .set({ options: { resourceLimits: limits } })
    .where(eq(server.id, ctx.serverId))
}

async function deployComposeWithCeiling(
  ctx: HostLevelCtx,
  services: Record<string, unknown>,
  limits: Record<string, number>
): Promise<{ status: number; body: { error?: string; violations?: LimitViolation[] } }> {
  await useCompose(ctx, composeOf(services), false)
  await ctx.db
    .update(organization)
    .set({ options: {} })
    .where(eq(organization.id, ctx.organizationId))
  await reconcileServicesForEnvironment(ctx.db, ctx.environmentId)
  await setServerCeiling(ctx, limits)
  return deployBody(ctx)
}

test('compose-authored cpus count toward the server ceiling', async () => {
  await withDeployFixtures(async (ctx) => {
    const services = {
      web: { image: 'nginx:alpine', cpus: 2 },
      db: { image: 'postgres:17', deploy: { resources: { limits: { cpus: '1' } } } },
    }
    const over = await deployComposeWithCeiling(ctx, services, { maxCpus: 2 })
    assertEquals(over.status, 409)
    assertEquals(over.body.error, 'resource_limit_exceeded')
    assertEquals(over.body.violations, [
      { scope: 'server', field: 'maxCpus', limit: 2, requested: 3 },
    ])
    assertEquals(ctx.commandQueue.envelopes.length, 0)

    await setServerCeiling(ctx, { maxCpus: 3 })
    assertEquals((await managerDeploy(ctx)).status, 200)
  })
})

test('compose-authored memory limits are parsed by unit and checked against the ceiling', async () => {
  await withDeployFixtures(async (ctx) => {
    const mib = 1024 ** 2
    const services = {
      a: { image: 'x:1', mem_limit: '512m' },
      b: { image: 'x:2', mem_limit: '512mb' },
      c: { image: 'x:3', deploy: { resources: { limits: { memory: '1g' } } } },
      d: { image: 'x:4', mem_limit: 1048576 },
    }
    const over = await deployComposeWithCeiling(ctx, services, { maxMemoryBytes: 2048 * mib })
    assertEquals(over.status, 409)
    assertEquals(over.body.violations, [
      { scope: 'server', field: 'maxMemoryBytes', limit: 2048 * mib, requested: 2049 * mib },
    ])

    await setServerCeiling(ctx, { maxMemoryBytes: 2049 * mib })
    assertEquals((await managerDeploy(ctx)).status, 200)
  })
})

test('a compose mem_reservation larger than the limit counts', async () => {
  await withDeployFixtures(async (ctx) => {
    const services = { a: { image: 'x:1', mem_limit: '1m', mem_reservation: '8m' } }
    const over = await deployComposeWithCeiling(ctx, services, { maxMemoryBytes: 4 * 1024 ** 2 })
    assertEquals(over.status, 409)
    assertEquals(over.body.violations?.[0]?.requested, 8 * 1024 ** 2)
  })
})

test('deploy.replicas multiplies the compose-authored request', async () => {
  await withDeployFixtures(async (ctx) => {
    const services = { web: { image: 'nginx:alpine', cpus: 1, deploy: { replicas: 3 } } }
    const over = await deployComposeWithCeiling(ctx, services, { maxCpus: 2 })
    assertEquals(over.status, 409)
    assertEquals(over.body.violations, [
      { scope: 'server', field: 'maxCpus', limit: 2, requested: 3 },
    ])
    await setServerCeiling(ctx, { maxCpus: 3 })
    assertEquals((await managerDeploy(ctx)).status, 200)
  })
})

test('services with no limits are not counted, and settings still win over the compose value', async () => {
  await withDeployFixtures(async (ctx) => {
    const services = { web: { image: 'nginx:alpine', cpus: 4 }, db: { image: 'postgres:17' } }
    await useCompose(ctx, composeOf(services), false)
    await reconcileServicesForEnvironment(ctx.db, ctx.environmentId)
    await pinServiceCpus(ctx, { web: 1 })
    await setServerCeiling(ctx, { maxCpus: 1 })
    // Settings pin web to 1 cpu (they are applied over the document); db asks for nothing.
    assertEquals((await managerDeploy(ctx)).status, 200)

    await pinServiceCpus(ctx, { web: 2 })
    const over = await deployBody(ctx)
    assertEquals(over.status, 409)
    assertEquals(over.body.violations, [
      { scope: 'server', field: 'maxCpus', limit: 1, requested: 2 },
    ])
  })
})

async function withExtraUser(
  ctx: RunCtx,
  permission: 'organization:own' | null,
  fn: (userId: string) => Promise<void>
): Promise<void> {
  const [row] = await ctx.db
    .insert(user)
    .values({
      email: `extra-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const extraId = row!.id
  if (permission) {
    await ctx.db.insert(grant).values({
      entityType: 'organization',
      entityId: ctx.organizationId,
      actorType: 'user',
      actorId: extraId,
      permission,
    })
  }
  try {
    await fn(extraId)
  } finally {
    await ctx.db.delete(grant).where(eq(grant.actorId, extraId))
    await ctx.db.delete(user).where(eq(user.id, extraId))
  }
}

function putGate(ctx: HostLevelCtx, cookie: string, enabled: boolean): Promise<Response> {
  return Promise.resolve(
    ctx.app.request(`/organizations/${ctx.organizationId}/compose-privileged-fields`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ composeGatedFieldsEnabled: enabled }),
    })
  )
}

test('host-level compose is refused by default with the way to enable it; an owner enables it, a manager deploys, a member is refused', async () => {
  await withDeployFixtures(async (ctx) => {
    await useCompose(ctx, composeWithBind(DOCKER_SOCKET_BIND), false)
    await ctx.db
      .update(organization)
      .set({ options: null })
      .where(eq(organization.id, ctx.organizationId))

    // Default: refused, and the refusal says who turns it on and where.
    const refused = await managerDeploy(ctx)
    assertEquals(refused.status, 403)
    const refusedBody = (await refused.json()) as { issues: Array<{ message: string }> }
    assertEquals(refusedBody.issues[0]!.message.includes('Manage Organization'), true)
    assertEquals(
      refusedBody.issues[0]!.message.includes('an organization owner has to turn on'),
      true
    )

    const managerCookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
    // A manager cannot enable it: that is the owner's switch.
    assertEquals((await putGate(ctx, managerCookie, true)).status, 403)
    assertEquals((await managerDeploy(ctx)).status, 403)

    await withExtraUser({ ...ctx, workspaceId: '' }, 'organization:own', async (ownerId) => {
      const ownerCookie = await sessionCookie(ctx.db, ctx.secrets, ownerId)
      assertEquals((await putGate(ctx, ownerCookie, true)).status, 200)
    })

    // Enabled: the manager's deploy goes through.
    assertEquals((await managerDeploy(ctx)).status, 200)
    assertEquals(ctx.commandQueue.envelopes.length, 1)

    // A member (no organization:manage) is still refused, and nothing more is queued.
    await withExtraUser({ ...ctx, workspaceId: '' }, null, async (memberId) => {
      const memberCookie = await sessionCookie(ctx.db, ctx.secrets, memberId)
      const res = await ctx.app.request(`/environments/${ctx.environmentId}/deploy`, {
        method: 'POST',
        headers: {
          Cookie: memberCookie,
          [ORG_ID_HEADER]: ctx.organizationId,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      assertEquals(res.status, 403)
    })
    assertEquals(ctx.commandQueue.envelopes.length, 1)
  })
})

test('the project container-naming setting is honoured by what a deploy would run: custom keeps the authored name, uuid replaces it', async () => {
  await withDeployFixtures(async (ctx) => {
    await ctx.db
      .update(environment)
      .set({ serverId: ctx.serverId })
      .where(eq(environment.id, ctx.environmentId))

    const withNaming = async (containerNaming: 'custom' | 'uuid'): Promise<string> => {
      await ctx.db
        .update(project)
        .set({ options: { compose: composeWithNamedWebService(), containerNaming } })
        .where(eq(project.id, ctx.projectId))
      return await previewYaml(ctx)
    }

    assertEquals((await withNaming('custom')).includes('container_name: adminer'), true)
    assertEquals((await withNaming('uuid')).includes('container_name: adminer'), false)
  })
})

// --- control-plane evidence for the Track C deploy/hosting checklist rows ---

type VerifyDeployCtx = {
  db: ReturnType<typeof createDenoDb>
  app: Hono<AppEnv>
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
  userId: string
  organizationId: string
  projectId: string
  environmentId: string
  serverId: string
  commandQueue: ReturnType<typeof createRecordingCommandQueue>
}

async function pinWebEnvironment(
  ctx: Pick<VerifyDeployCtx, 'db' | 'projectId' | 'environmentId' | 'serverId'>,
  serviceOptions?: Record<string, unknown>
): Promise<string> {
  const now = new Date().toISOString()
  await ctx.db
    .update(environment)
    .set({
      serverId: ctx.serverId,
      name: 'Production',
      options: { compose: emptyComposeDocument() },
      updatedAt: now,
    })
    .where(eq(environment.id, ctx.environmentId))
  await ctx.db
    .update(project)
    .set({ options: { compose: composeWithWebService() }, updatedAt: now })
    .where(eq(project.id, ctx.projectId))
  const [svc] = await ctx.db
    .insert(service)
    .values({
      environmentId: ctx.environmentId,
      name: 'web',
      composeServiceName: 'web',
      options: serviceOptions ?? null,
    })
    .returning({ id: service.id })
  return svc!.id
}

async function verifyHeaders(ctx: VerifyDeployCtx): Promise<Record<string, string>> {
  const cookie = await sessionCookie(ctx.db, ctx.secrets, ctx.userId)
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: ctx.organizationId,
    'Content-Type': 'application/json',
  }
}

async function dispatchedPayload(
  db: ReturnType<typeof createDenoDb>,
  commandId: string
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ payload: dispatch.payload })
    .from(dispatch)
    .where(eq(dispatch.commandId, commandId))
    .limit(1)
  return row!.payload as Record<string, unknown>
}

type ServiceHookWire = {
  composeServiceName: string
  preDeployCommand?: string
  confinement?: string
}

test('deploy hooks reach the host only when the organization opted in, and then only confined to the service container', async () => {
  await withDeployFixtures(async (ctx) => {
    await pinWebEnvironment(ctx, {
      preDeployCommand: 'echo before',
      postDeployCommand: 'echo after',
    })
    const headers = await verifyHeaders(ctx)
    const hooksFor = async (): Promise<ServiceHookWire[]> => {
      const res = await ctx.app.request(`/environments/${ctx.environmentId}/deploy`, {
        method: 'POST',
        headers,
        body: '{}',
      })
      assertEquals(res.status, 200)
      const body = (await res.json()) as { commandId: string }
      const payload = await dispatchedPayload(ctx.db, body.commandId)
      return (payload.serviceHooks ?? []) as ServiceHookWire[]
    }

    // Gate off (the default): the commands are dropped before the wire.
    const refused = await hooksFor()
    assertEquals(
      refused.some((hook) => hook.preDeployCommand !== undefined),
      false
    )

    // Gate on: the commands ride along, each confined to the compose service.
    await ctx.db
      .update(organization)
      .set({ options: { deployHooksEnabled: true } })
      .where(eq(organization.id, ctx.organizationId))
    const allowed = await hooksFor()
    const web = allowed.find((hook) => hook.composeServiceName === 'web')
    assertEquals(web?.preDeployCommand, 'echo before')
    assertEquals(web?.confinement, 'compose-service')
  })
})

test('a required health gate refuses a deploy with the services it names and queues nothing; a warn gate needs acknowledgement', async () => {
  await withDeployFixtures(async (ctx) => {
    await pinWebEnvironment(ctx, { healthCheck: { policy: 'required' } })
    const headers = await verifyHeaders(ctx)
    const deploy = (body: string) =>
      ctx.app.request(`/environments/${ctx.environmentId}/deploy`, {
        method: 'POST',
        headers,
        body,
      })

    const required = await deploy('{}')
    assertEquals(required.status, 409)
    assertEquals(await required.json(), {
      error: 'health_check_missing',
      required: true,
      services: ['web'],
    })
    // Acknowledging cannot waive a required gate.
    const acknowledged = await deploy(JSON.stringify({ acknowledgeHealthCheckWarnings: true }))
    assertEquals(acknowledged.status, 409)
    assertEquals(ctx.commandQueue.envelopes.length, 0)

    await ctx.db
      .update(service)
      .set({ options: { healthCheck: { policy: 'warn' } } })
      .where(eq(service.environmentId, ctx.environmentId))
    const warned = await deploy('{}')
    assertEquals(warned.status, 409)
    assertEquals(((await warned.json()) as { required: boolean }).required, false)
    assertEquals(ctx.commandQueue.envelopes.length, 0)
    const ok = await deploy(JSON.stringify({ acknowledgeHealthCheckWarnings: true }))
    assertEquals(ok.status, 200)
    assertEquals(ctx.commandQueue.envelopes.length, 1)

    await ctx.db
      .update(service)
      .set({ options: { healthCheck: { policy: 'disabled' } } })
      .where(eq(service.environmentId, ctx.environmentId))
    const disabled = await deploy('{}')
    assertEquals(disabled.status, 200)
  })
})

test('GET deploy-preview shows the prepared shape and changes nothing: no command, dispatch, deployment, generation or queue entry', async () => {
  await withDeployFixtures(async (ctx) => {
    await pinWebEnvironment(ctx)
    const headers = await verifyHeaders(ctx)
    const snapshot = async () => {
      const [env] = await ctx.db
        .select({ generation: environment.generation, updatedAt: environment.updatedAt })
        .from(environment)
        .where(eq(environment.id, ctx.environmentId))
      const commands = await ctx.db
        .select({ id: command.id })
        .from(command)
        .where(eq(command.serverId, ctx.serverId))
      const deployments = await ctx.db
        .select({ id: deployment.id })
        .from(deployment)
        .where(eq(deployment.environmentId, ctx.environmentId))
      return JSON.stringify({
        env,
        commands: commands.length,
        deployments: deployments.length,
        queued: ctx.commandQueue.envelopes.length,
      })
    }
    const before = await snapshot()
    const res = await ctx.app.request(`/environments/${ctx.environmentId}/deploy-preview`, {
      headers,
    })
    assertEquals(res.status, 200)
    const body = (await res.json()) as { composeFiles: Array<{ content: string }> }
    assertEquals(body.composeFiles[0]?.content.includes('web:'), true)
    assertEquals(await snapshot(), before)
  })
})

test('lifecycle start, stop and restart each reach the host as environment.lifecycle with that action', async () => {
  await withDeployFixtures(async (ctx) => {
    await pinWebEnvironment(ctx)
    const headers = await verifyHeaders(ctx)
    const actions = ['start', 'stop', 'restart']
    await forEachSequential(actions, async (action) => {
      const res = await ctx.app.request(`/environments/${ctx.environmentId}/lifecycle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action }),
      })
      assertEquals(res.status, 200)
      const body = (await res.json()) as { commandId: string; status: string }
      assertEquals(body.status, 'queued')
      const payload = await dispatchedPayload(ctx.db, body.commandId)
      assertEquals(payload.action, action)
    })
    assertEquals(
      ctx.commandQueue.envelopes.map((envelope) => envelope.type),
      ['environment.lifecycle', 'environment.lifecycle', 'environment.lifecycle']
    )
    assertEquals(
      ctx.commandQueue.envelopes.every((envelope) => envelope.serverId === ctx.serverId),
      true
    )
  })
})

test('revoking an uploaded certificate stops deploys of the hostnames pinned to it, naming the hosting', async () => {
  const traefikServiceId = '00000000-0000-4000-8000-0000000000af'
  await withDeployFixtures(async (ctx) => {
    const originalEnsure = systemHierarchyProvision.ensure
    systemHierarchyProvision.ensure = () =>
      Promise.resolve({
        workspaceId: '00000000-0000-4000-8000-0000000000bf',
        projectId: '00000000-0000-4000-8000-0000000000cf',
        environmentId: '00000000-0000-4000-8000-0000000000df',
        serviceId: traefikServiceId,
        containerRowId: '00000000-0000-4000-8000-0000000000ef',
        containerName: `${traefikServiceId}-in`,
      })
    let tlsId: string | undefined
    let hostingId: string | undefined
    try {
      const serviceId = await pinWebEnvironment(ctx)
      const headers = await verifyHeaders(ctx)
      const minted = await mintSelfSignedCertificate(['pinned.example.com'])
      const created = await ctx.app.request('/tls', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: 'upload',
          name: 'Pinned upload',
          certificatePem: minted.certificatePem,
          privateKeyPem: minted.privateKeyPem,
        }),
      })
      assertEquals(created.status, 200)
      tlsId = ((await created.json()) as { id: string }).id
      const [hostingRow] = await ctx.db
        .insert(hosting)
        .values({ serviceId, tlsId, options: { hostnames: ['pinned.example.com'] } })
        .returning({ id: hosting.id })
      hostingId = hostingRow!.id
      const deploy = () =>
        ctx.app.request(`/environments/${ctx.environmentId}/deploy`, {
          method: 'POST',
          headers,
          body: '{}',
        })

      // While the pin is usable the hostname resolves; this fixture server has
      // no daemon key, so the deploy only stops later, at sealing the key.
      const before = await deploy()
      assertEquals(before.status, 422)
      assertEquals(
        ((await before.json()) as { error: string }).error,
        'No encryption-capable daemon key on target server'
      )
      const queuedBefore = ctx.commandQueue.envelopes.length

      const revoke = await ctx.app.request(`/tls/${tlsId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ revoke: true }),
      })
      assertEquals(revoke.status, 200)

      const after = await deploy()
      assertEquals(after.status, 400)
      assertEquals(await after.json(), { error: 'tls_pin_not_ready', hostingId })
      assertEquals(ctx.commandQueue.envelopes.length, queuedBefore)
    } finally {
      systemHierarchyProvision.ensure = originalEnsure
      if (hostingId) await ctx.db.delete(hosting).where(eq(hosting.id, hostingId))
      if (tlsId) await ctx.db.delete(tls).where(eq(tls.id, tlsId))
    }
  })
})

test('deployment history lists every deploy with its outcome', async () => {
  await withDeployFixtures(async (ctx) => {
    await pinWebEnvironment(ctx)
    const headers = await verifyHeaders(ctx)
    const deployIds = await mapSequential([0, 1], async () => {
      const res = await ctx.app.request(`/environments/${ctx.environmentId}/deploy`, {
        method: 'POST',
        headers,
        body: '{}',
      })
      assertEquals(res.status, 200)
      return ((await res.json()) as { commandId: string }).commandId
    })
    // One deploy finishes, the other is stopped by the host.
    await transitionCommand(ctx.db, deployIds[0]!, { status: 'succeeded' })
    await transitionCommand(ctx.db, deployIds[1]!, {
      status: 'failed',
      errorCode: 'compose_up_failed',
      error: 'service web exited',
    })

    const res = await ctx.app.request(`/environments/${ctx.environmentId}/deployments`, { headers })
    assertEquals(res.status, 200)
    const body = (await res.json()) as {
      deployments: Array<{ id?: string; commandId?: string; status: string; generation: number }>
    }
    const listed = body.deployments.map((entry) => ({
      status: entry.status,
      generation: entry.generation,
    }))
    assertEquals(listed.length, 2)
    assertEquals(new Set(listed.map((entry) => entry.status)), new Set(['succeeded', 'failed']))
    assertEquals(listed[0]!.generation > listed[1]!.generation, true)
  })
})
