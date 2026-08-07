import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { DaemonCell, DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import { emptyComposeDocument } from '../../lib/compose/index.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  command,
  container,
  environment,
  grant,
  member,
  organization,
  project,
  server,
  service,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import {
  expandHostingsForComposeInstances,
  preferredListenPortsFromHostings,
  readHostnames,
  readHostingPorts,
  readHostingProtocol,
  readPathPrefix,
  readTargetPort,
  registerEnvironmentDeployPreviewRoutes,
  registerEnvironmentDeployRoutes,
  registerEnvironmentLifecycleRoutes,
  validateDeployMaterials,
} from './deploy-routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

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
    },
  )
  assertEquals(expanded.length, 3)
  assertEquals(
    expanded.map((entry) => entry.composeServiceName).sort((a, b) => a.localeCompare(b)),
    ['api', 'web-1', 'web-2'],
  )
  const webClones = expanded.filter((entry) => entry.hostingId === 'h1')
  assertEquals(webClones.length, 2)
  assertEquals(webClones.every((entry) => entry.serviceId === 'svc-web'), true)
})

test('expandHostingsForComposeInstances passes through when expansion is missing', () => {
  const hostings = [{
    hostingId: 'h1',
    serviceId: 'svc-api',
    composeServiceName: 'api',
    hostnames: ['api.example.com'],
  }]
  const expanded = expandHostingsForComposeInstances(hostings, {})
  assertEquals(expanded.length, 1)
  assertEquals(expanded[0]?.composeServiceName, 'api')
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
    [{ published: 5432, target: 5432 }],
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
  const res = validateDeployMaterials(
    [{
      hostingId: 'h1',
      serviceId: 'svc-db',
      composeServiceName: 'db',
      hostnames: [],
      protocol: 'tcp',
      ports: [],
    }],
    [],
  )
  if (!(res instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(res.status, 400)
})

function createRecordingCommandQueue(): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: async (envelope) => {
      envelopes.push(envelope)
    },
  }
}

function createMockCell(serverId: string): DaemonCell {
  const noopAsync = async () => {}
  return {
    attachDaemonSocket: async () => ({
      connectionId: 'conn',
      lease: {
        holder: 'conn',
        token: 'conn',
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: async () => ({
      serverId,
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: false,
    }),
    putSnapshot: async (patch) => ({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: false,
      ...patch,
    }),
    enqueue: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'queued' as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    markSent: noopAsync,
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => null,
    createRequestAndWait: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'done' as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: async () => [],
    ackOutbox: noopAsync,
    prune: async () => [],
    clearUpdateStatus: async () => ({ cleared: 0 }),
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
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async () => {},
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

async function createDeployRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  options: {
    registry: DaemonCellRegistry
    commandQueue: CommandQueue
  },
) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', options.registry)
    c.set('commandQueue', options.commandQueue)
    return next()
  })
  registerEnvironmentDeployPreviewRoutes(app, { secrets, runtime: 'deno' })
  registerEnvironmentDeployRoutes(app, { secrets, runtime: 'deno' })
  registerEnvironmentLifecycleRoutes(app, { secrets, runtime: 'deno' })
  return { app, secrets }
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
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
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping environment deploy route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const commandQueue = createRecordingCommandQueue()
  const registry = createTrackingRegistry()
  const { app, secrets } = await createDeployRoutesTestApp(db, { registry, commandQueue })

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Deploy Route Test Org' })
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

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Deploy Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      displayName: 'Deploy Route Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Deploy Route Project',
      workspaceId,
      options: { compose: emptyComposeDocument() },
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      displayName: 'Deploy Route Env',
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
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('GET /environments/:id/deploy-preview returns prepared yaml with warnings for empty compose', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
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
    const res = await app.request(`/environments/${environmentId}/deploy-preview`, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      composeYaml: string
      projectName: string
      containers: unknown[]
      volumes: unknown[]
      warnings: Array<{ code: string }>
    }
    assertEquals(body.ok, true)
    assertEquals(body.projectName, projectId)
    assertEquals(body.containers, [])
    assertEquals(body.volumes, [])
    assertEquals(body.warnings.some((w) => w.code === 'empty_compose'), true)
  })
})

test('GET /environments/:id/deploy-preview returns containers for a service', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        options: { compose: composeWithWebService() },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId))

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/deploy-preview`, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      composeYaml: string
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
    assertEquals(body.composeYaml.includes('web:'), true)
    assertEquals(body.containers.length >= 1, true)
    assertEquals(body.containers[0]!.composeServiceName, 'web')
    assertEquals(body.containers[0]!.ordinal, 1)
    // uuid naming: docker container_name is the service UUID (obfuscated)
    assertEquals(body.containers[0]!.containerName, body.containers[0]!.serviceId)
    assertEquals(body.composeYaml.includes(`container_name: ${body.containers[0]!.serviceId}`), true)
  })
})

test('POST /environments/:id/deploy uses project defaultServerId when env pin is unset', async () => {
  await withDeployFixtures(async ({
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
  })
})

test('POST /environments/:id/deploy rejects empty compose', async () => {
  await withDeployFixtures(async ({
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
  })
})

test('POST /environments/:id/deploy pinned auto-resolves without body serverId', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
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
    const body = await res.json() as { ok: boolean; commandId: string; status: string }
    assertEquals(body.ok, true)
    assertEquals(body.status, 'queued')
    assertEquals(commandQueue.envelopes.length, 1)
    assertEquals(commandQueue.envelopes[0]!.serverId, serverId)
    assertEquals(commandQueue.envelopes[0]!.type, 'environment.deploy')

    const [envRow] = await db
      .select({ serverId: environment.serverId, metadata: environment.metadata })
      .from(environment)
      .where(eq(environment.id, environmentId))
      .limit(1)
    assertEquals(envRow?.serverId, serverId)
    const metadata = envRow?.metadata as { serverId?: string } | null
    assertEquals(metadata?.serverId, undefined)
  })
})

test('POST /environments/:id/deploy ignores body serverId and uses environment.server_id', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    const now = new Date().toISOString()
    const [otherServer] = await db
      .insert(server)
      .values({
        organizationId,
        displayName: 'Deploy Route Other Server',
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
  })
})

test('POST /environments/:id/deploy requires persisted environment.server_id', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
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
    assertEquals(await bodyServerIdRes.json(), { error: 'server_placement_required' })
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
    assertEquals(await missingRes.json(), { error: 'server_placement_required' })
    assertEquals(commandQueue.envelopes.length, 0)
  })
})

test('POST /environments/:id/deploy stale environment pin returns 404', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    commandQueue,
  }) => {
    const now = new Date().toISOString()
    const [foreignOrg] = await db
      .insert(organization)
      .values({ displayName: 'Deploy Route Foreign Org' })
      .returning({ id: organization.id })
    const foreignOrgId = foreignOrg!.id
    const [foreignServer] = await db
      .insert(server)
      .values({
        organizationId: foreignOrgId,
        displayName: 'Foreign Server',
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

      assertEquals(res.status, 404)
      assertEquals(await res.json(), { error: 'Not found' })
      assertEquals(commandQueue.envelopes.length, 0)
    } finally {
      await db
        .update(environment)
        .set({ serverId: null, updatedAt: new Date().toISOString() })
        .where(eq(environment.id, environmentId))
      await db.delete(server).where(eq(server.id, foreignServerId))
      await db.delete(organization).where(eq(organization.id, foreignOrgId))
    }
  })
})

test('POST /environments/:id/deploy rejects stored compose placement', async () => {
  await withDeployFixtures(async ({
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
            presentation: { keyOrder: ['services', 'x-turbopanel'], comments: {} },
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
  })
})

test('POST /environments/:id/deploy rejects environment overlay compose placement', async () => {
  await withDeployFixtures(async ({
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
        options: {
          compose: {
            version: 1,
            data: {
              services: { web: { image: 'nginx:alpine' } },
              'x-turbopanel': { placement: { server_id: crypto.randomUUID() } },
            },
            presentation: { keyOrder: ['services', 'x-turbopanel'], comments: {} },
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
  })
})

test('POST /environments/:id/lifecycle enqueues environment.lifecycle', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
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
    const body = await res.json() as {
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
  })
})

test('POST /environments/:id/lifecycle rejects unknown action', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
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
  })
})

test('POST /environments/:id/lifecycle requires persisted environment.server_id', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    commandQueue,
  }) => {
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
  })
})

test('POST /environments/:id/lifecycle returns 403 for non-manager', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    commandQueue,
  }) => {
    await db
      .update(environment)
      .set({
        serverId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(environment.id, environmentId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))

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
  })
})

test('POST /environments/:id/lifecycle returns 404 for cross-org environment', async () => {
  await withDeployFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const [foreignOrg] = await db
      .insert(organization)
      .values({ displayName: 'Lifecycle Foreign Org' })
      .returning({ id: organization.id })
    const foreignOrgId = foreignOrg!.id
    const [foreignWorkspace] = await db
      .insert(workspace)
      .values({ displayName: 'Foreign Workspace', organizationId: foreignOrgId })
      .returning({ id: workspace.id })
    const [foreignProject] = await db
      .insert(project)
      .values({
        displayName: 'Foreign Project',
        workspaceId: foreignWorkspace!.id,
        options: { compose: emptyComposeDocument() },
      })
      .returning({ id: project.id })
    const [foreignEnvironment] = await db
      .insert(environment)
      .values({
        displayName: 'Foreign Env',
        projectId: foreignProject!.id,
        serverId,
        options: { compose: emptyComposeDocument() },
      })
      .returning({ id: environment.id })

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(
        `/environments/${foreignEnvironment!.id}/lifecycle`,
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            [ORG_ID_HEADER]: organizationId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'start' }),
        },
      )
      assertEquals(res.status, 404)
      assertEquals(commandQueue.envelopes.length, 0)
    } finally {
      await db.delete(environment).where(eq(environment.id, foreignEnvironment!.id))
      await db.delete(project).where(eq(project.id, foreignProject!.id))
      await db.delete(workspace).where(eq(workspace.id, foreignWorkspace!.id))
      await db.delete(organization).where(eq(organization.id, foreignOrgId))
    }
  })
})
