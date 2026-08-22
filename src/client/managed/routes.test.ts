import { assertEquals } from '@std/assert'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb, endDbConnection } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  type SecretsConfig,
} from '../authn/secrets.ts'
import { attachDaemonStateToServer } from '../../daemon/authn/server-identity-db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { DaemonOutboundEnvelope } from '../../daemon/cell/protocol.ts'
import { emptyComposeDocument } from '../../lib/compose/index.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import { getManagedEngineSpec } from '../../lib/managed/index.ts'
import {
  binding,
  command,
  dispatch,
  container,
  environment,
  grant,
  managed,
  organization,
  principal,
  project,
  server,
  service,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { getCatalogEntry, readManagedEngineOptions } from '../projects/catalog/index.ts'
import { registerManagedRoutes } from './routes.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createRecordingCommandQueue(): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: (envelope: CommandEnvelope) => {
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

function createStubRegistry(): DaemonCellRegistry {
  return {
    getCell: () => ({
      createRequestAndWait: (outbound: DaemonOutboundEnvelope) =>
        Promise.resolve({
          serverId: 'stub',
          requestId: outbound.requestId,
          requestKind: outbound.kind,
          status: 'done' as const,
          createdAt: outbound.at,
          expiresAt: outbound.at,
          result: { logs: 'stub-logs\n' },
        }),
    }),
  } as unknown as DaemonCellRegistry
}

/**
 * Repoint the environment's placement to a second, *offline* server in the
 * same org while leaving `managed.server_id` pinned at the original (online)
 * server. `assertTargetServerOnline` on the drifted server would reject with
 * `server_offline`, so a passing operation inside `fn` proves the route
 * dispatched against `managed.server_id`, not the environment's current
 * placement — mirrors the existing backup drift test.
 */
async function withDriftedPlacement(
  db: ReturnType<typeof createDenoDb>,
  environmentId: string,
  organizationId: string,
  originalServerId: string,
  fn: (driftedServerId: string) => Promise<void>,
): Promise<void> {
  const now = new Date().toISOString()
  const [driftedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Drifted Placement Server',
      createdAt: now,
      updatedAt: now,
      isConnected: false,
      statusChangedAt: now,
    })
    .returning({ id: server.id })
  const driftedServerId = driftedServer!.id
  await attachDaemonStateToServer(db, driftedServerId, {
    publicJwk: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: `managed-drift-test-key-${driftedServerId}`,
    },
    fingerprint: `managed-drift-test-fingerprint-${driftedServerId}`,
  })
  await db.update(environment).set({ serverId: driftedServerId }).where(
    eq(environment.id, environmentId),
  )
  try {
    await fn(driftedServerId)
  } finally {
    await db.update(environment).set({ serverId: originalServerId }).where(
      eq(environment.id, environmentId),
    )
    await db.delete(container).where(eq(container.serverId, driftedServerId))
    await db.delete(server).where(eq(server.id, driftedServerId))
  }
}

function composeWithPostgresService(): ComposeDocument {
  const spec = getManagedEngineSpec('postgres')
  if (!spec) throw new TypeError('postgres managed engine spec missing')
  return {
    version: 1,
    data: {
      services: {
        postgres: { image: spec.defaultImage },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

async function createManagedRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  secretsConfig: SecretsConfig,
  options?: {
    commandQueue?: CommandQueue
    registry?: DaemonCellRegistry
  },
) {
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const commandQueue = options?.commandQueue ?? createRecordingCommandQueue()
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    c.set('daemonCellRegistry', options?.registry ?? createStubRegistry())
    c.set('commandQueue', commandQueue)
    return next()
  })
  registerManagedRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, secrets, commandQueue, dataEncryptionSecrets }
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

async function withManagedFixtures(
  options: {
    withManageGrant?: boolean
    withPlacement?: boolean
    projectKind?: 'managed-postgres' | 'docker-compose'
    foreignServer?: boolean
    online?: boolean
  },
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    commandQueue: CommandQueue & { envelopes: CommandEnvelope[] }
    userId: string
    organizationId: string
    workspaceId: string
    projectId: string
    environmentId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping managed route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const secretsConfig = parseTestSecretsConfig('deno')
  const db = createDenoDb()
  try {
    await withManagedFixturesBody(db, secretsConfig, options, fn)
  } finally {
    await endDbConnection(db)
  }
}

async function withManagedFixturesBody(
  db: ReturnType<typeof createDenoDb>,
  secretsConfig: SecretsConfig,
  options: {
    withManageGrant?: boolean
    withPlacement?: boolean
    projectKind?: 'managed-postgres' | 'docker-compose'
    foreignServer?: boolean
    online?: boolean
  },
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    commandQueue: CommandQueue & { envelopes: CommandEnvelope[] }
    userId: string
    organizationId: string
    workspaceId: string
    projectId: string
    environmentId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  const withManageGrant = options.withManageGrant !== false
  const withPlacement = options.withPlacement !== false
  const projectKind = options.projectKind ?? 'managed-postgres'
  const foreignServer = options.foreignServer === true
  const online = options.online !== false

  const commandQueue = createRecordingCommandQueue()
  const { app, secrets } = await createManagedRoutesTestApp(db, secretsConfig, {
    commandQueue,
  })

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Managed Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  let foreignOrgId: string | null = null
  if (foreignServer) {
    const [foreignOrg] = await db
      .insert(organization)
      .values({ name: 'Managed Route Foreign Org' })
      .returning({ id: organization.id })
    foreignOrgId = foreignOrg!.id
  }

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `managed-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  if (withManageGrant) {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
    })
  }

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Managed Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId: foreignServer ? foreignOrgId! : organizationId,
      name: 'Managed Route Server',
      createdAt: now,
      updatedAt: now,
      isConnected: online,
      statusChangedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  if (!foreignServer) {
    await attachDaemonStateToServer(db, serverId, {
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'managed-test-key' },
      fingerprint: 'managed-test-fingerprint',
    })
    if (online) {
      await db.update(server).set({
        isConnected: true,
        statusChangedAt: now,
        updatedAt: now,
      }).where(eq(server.id, serverId))
    }
  }

  const catalogEntry = getCatalogEntry('postgres')
  if (!catalogEntry) throw new TypeError('missing postgres catalog entry')
  const engineOptions = readManagedEngineOptions(catalogEntry)

  const [insertedProject] = await db
    .insert(project)
    .values(
      projectKind === 'managed-postgres'
        ? {
          name: 'Managed Postgres Project',
          workspaceId,
          metadata: { type: 'managed', code: 'postgres' },
          options: {
            compose: catalogEntry.compose,
            ...(engineOptions ?? {}),
          },
        }
        : {
          name: 'Compose Project',
          workspaceId,
          metadata: { type: 'docker-compose' },
          options: { compose: emptyComposeDocument() },
        },
    )
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Production',
      projectId,
      serverId: withPlacement ? serverId : null,
      options: {
        compose: withPlacement
          ? composeWithPostgresService()
          : emptyComposeDocument(),
      },
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  try {
    await fn({
      db,
      app,
      secrets,
      commandQueue,
      userId,
      organizationId,
      workspaceId,
      projectId,
      environmentId,
      serverId,
    })
  } finally {
    const managedRows = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.environmentId, environmentId))
    for (const row of managedRows) {
      await db.delete(principal).where(eq(principal.managedId, row.id))
    }
    await db.delete(managed).where(eq(managed.environmentId, environmentId))
    await db.delete(principal).where(eq(principal.projectId, projectId))
    const envServices = await db
      .select({ id: service.id })
      .from(service)
      .where(eq(service.environmentId, environmentId))
    for (const row of envServices) {
      try {
        await db.delete(binding).where(eq(binding.serviceId, row.id))
      } catch {
        // unmigrated local DB
      }
      await db.delete(container).where(eq(container.serviceId, row.id))
    }
    await db.delete(service).where(eq(service.environmentId, environmentId))
    await db.delete(command).where(eq(command.serverId, serverId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))

    // Managed apply/backup/lifecycle routes self-heal a system
    // (managed-ingress) workspace/project/environment/service/container
    // scoped to `serverId` as a side effect of reconciling ProxySQL — sweep
    // every remaining workspace under this test-owned organization (not just
    // the tracked ids above) so that hierarchy never leaks and blocks the
    // `server` delete below via RESTRICT foreign keys.
    await db.delete(container).where(eq(container.serverId, serverId))
    const leftoverWorkspaceIds = (
      await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.organizationId, organizationId))
    ).map((row) => row.id)
    if (leftoverWorkspaceIds.length > 0) {
      const leftoverProjectIds = (
        await db
          .select({ id: project.id })
          .from(project)
          .where(inArray(project.workspaceId, leftoverWorkspaceIds))
      ).map((row) => row.id)
      if (leftoverProjectIds.length > 0) {
        const leftoverEnvironmentIds = (
          await db
            .select({ id: environment.id })
            .from(environment)
            .where(inArray(environment.projectId, leftoverProjectIds))
        ).map((row) => row.id)
        if (leftoverEnvironmentIds.length > 0) {
          await db.delete(service).where(inArray(service.environmentId, leftoverEnvironmentIds))
          await db.delete(managed).where(inArray(managed.environmentId, leftoverEnvironmentIds))
          await db.delete(environment).where(inArray(environment.id, leftoverEnvironmentIds))
        }
        await db.delete(project).where(inArray(project.id, leftoverProjectIds))
      }
      await db.delete(workspace).where(inArray(workspace.id, leftoverWorkspaceIds))
    }

    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    if (foreignOrgId) {
      await db.delete(organization).where(eq(organization.id, foreignOrgId))
    }
  }
}

test('POST /environments/:id/managed is forbidden without manage grant', async () => {
  await withManagedFixtures({ withManageGrant: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    assertEquals(res.status, 403)
  })
})

test('POST /environments/:id/managed requires placement pin', async () => {
  await withManagedFixtures({ withPlacement: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/managed`, {
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
  })
})

test('POST /environments/:id/managed 404s when pinned server is foreign', async () => {
  await withManagedFixtures({ foreignServer: true }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    assertEquals(res.status, 404)
  })
})

test('create enqueue failure compensation clears pending null-id containers', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
  }) => {
    commandQueue.enqueue = () => {
      throw new Error('queue unavailable')
    }

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    assertEquals(res.status, 503)

    const managedRows = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.environmentId, environmentId))
    assertEquals(managedRows.length, 0)

    const pending = await db
      .select({
        id: container.id,
        status: container.status,
        containerId: container.containerId,
      })
      .from(container)
      .innerJoin(service, eq(container.serviceId, service.id))
      .where(
        and(
          eq(service.environmentId, environmentId),
          isNull(container.containerId),
          eq(container.status, 'pending'),
        ),
      )
    assertEquals(pending.length, 0)
  })
})

test('managed create returns rootPassword once, seals principal, is idempotent', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const first = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(first.status, 200)
    const firstBody = await first.json() as {
      ok: boolean
      alreadyProvisioned?: boolean
      rootPassword?: string
      commandId?: string
      managed: {
        id: string
        engine: string
        status: string
        serverId: string
      }
    }
    assertEquals(firstBody.ok, true)
    assertEquals(firstBody.alreadyProvisioned, undefined)
    assertEquals(typeof firstBody.rootPassword, 'string')
    assertEquals((firstBody.rootPassword?.length ?? 0) > 0, true)
    assertEquals(typeof firstBody.commandId, 'string')
    assertEquals(firstBody.managed.engine, 'postgres')
    assertEquals(firstBody.managed.serverId, serverId)
    // A successful apply also self-heals ProxySQL ingress and Orchestrator HA
    // reconcile for the same server, so managed.apply plus both whole-server
    // reconciles get enqueued.
    assertEquals(commandQueue.envelopes.length, 3)
    assertEquals(commandQueue.envelopes[0]?.type, 'managed.apply')
    assertEquals(commandQueue.envelopes[1]?.type, 'managed.ingress.reconcile')
    assertEquals(commandQueue.envelopes[2]?.type, 'managed.ha.reconcile')
    assertEquals(
      commandQueue.envelopes.every((envelope) => envelope.serverId === serverId),
      true,
    )

    const [managedRow] = await db
      .select({ options: managed.options, id: managed.id })
      .from(managed)
      .where(eq(managed.environmentId, environmentId))
      .limit(1)
    const options = managedRow?.options as { settings?: unknown; databases?: string[] }
    assertEquals(Array.isArray(options.databases), true)
    assertEquals(options.settings !== undefined, true)

    const principals = await db
      .select({ password: principal.password, managedId: principal.managedId })
      .from(principal)
      .where(eq(principal.managedId, managedRow!.id))
    assertEquals(principals.length, 1)
    assertEquals(principals[0]!.password?.startsWith('tpsecret.'), true)

    const second = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(second.status, 200)
    const secondBody = await second.json() as {
      ok: boolean
      alreadyProvisioned?: boolean
      rootPassword?: string
      commandId?: string
    }
    assertEquals(secondBody.alreadyProvisioned, true)
    assertEquals(secondBody.rootPassword, undefined)
    assertEquals(secondBody.commandId, undefined)
    assertEquals(commandQueue.envelopes.length, 3)

    const getRes = await app.request(`/environments/${environmentId}/managed`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(getRes.status, 200)
    const getBody = await getRes.json() as Record<string, unknown>
    assertEquals(JSON.stringify(getBody).includes('password'), false)
    assertEquals(JSON.stringify(getBody).includes('tpsecret.'), false)
  })
})

test('PATCH rejects denylisted dockerOptions and does not enqueue', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    // Create enqueues apply and sets status=applying; clear the busy guard so
    // PATCH can exercise settings validation.
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.environmentId, environmentId),
    )
    const beforeCount = commandQueue.envelopes.length

    const denied = await app.request(`/environments/${environmentId}/managed`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        settings: { dockerOptions: { privileged: true } },
      }),
    })
    assertEquals(denied.status, 400)
    assertEquals(await denied.json(), { error: 'managed_settings_invalid' })

    const badBind = await app.request(`/environments/${environmentId}/managed`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        settings: { exposure: { enabled: true, scope: 'internet' } },
      }),
    })
    assertEquals(badBind.status, 400)
    assertEquals(commandQueue.envelopes.length, beforeCount)
  })
})

test('managed_busy guard on apply while status=applying', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }

    await db
      .update(managed)
      .set({ status: 'applying' })
      .where(eq(managed.id, created.managed.id))

    const apply = await app.request(`/environments/${environmentId}/managed/apply`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(apply.status, 409)
    assertEquals(await apply.json(), { error: 'managed_busy' })
  })
})

test('GET /organizations/:id/managed returns joined rows', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    projectId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)

    const list = await app.request(`/organizations/${organizationId}/managed`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(list.status, 200)
    const body = await list.json() as {
      managed: Array<{
        projectId: string
        environmentId: string
        serverId: string | null
        engine: string | null
        engineDisplayName: string | null
      }>
    }
    assertEquals(body.managed.length, 1)
    assertEquals(body.managed[0]?.projectId, projectId)
    assertEquals(body.managed[0]?.environmentId, environmentId)
    assertEquals(body.managed[0]?.serverId, serverId)
    assertEquals(body.managed[0]?.engine, 'postgres')
    assertEquals(body.managed[0]?.engineDisplayName, 'PostgreSQL')
  })
})

test('GET /environments/:id/managed/status returns status host port containers', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }

    // The live connection listener (Comment 2: reachable-endpoint fix) always
    // wins over stale `metadata.host`/`.port` when it can resolve — exposure
    // stays disabled here (bind local), so the listener resolves the safe
    // loopback address rather than trusting a stored public host that may no
    // longer be reachable/valid.
    await db.update(managed).set({
      status: 'ready',
      metadata: {
        rootPrincipalId: '00000000-0000-4000-8000-000000000099',
        host: '203.0.113.50',
        port: 5432,
      },
    }).where(eq(managed.id, created.managed.id))

    const statusRes = await app.request(
      `/environments/${environmentId}/managed/status`,
      { headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(statusRes.status, 200)
    const body = await statusRes.json() as {
      status: string | null
      host: string | null
      port: number | null
      error: string | null
      containers: Array<{ role: string }>
    }
    assertEquals(body.status, 'ready')
    assertEquals(body.host, '127.0.0.1')
    assertEquals(body.port, 15432)
    assertEquals(body.error, null)
    assertEquals(Array.isArray(body.containers), true)
    for (const row of body.containers) {
      assertEquals(typeof row.role, 'string')
      assertEquals(
        row.role === 'service' || row.role === 'ingress' || row.role === 'turbopanel',
        true,
      )
    }
  })
})

test('GET /environments/:id/managed/status returns last apply and ingress errors', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    const managedId = created.managed.id

    await db.update(managed).set({ status: 'failed' }).where(eq(managed.id, managedId))

    const apply = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: userId,
      type: 'managed.apply',
      payload: { managedId, environmentId },
    })
    await transitionCommand(db, apply.id, {
      status: 'failed',
      error: 'permission denied while trying to connect to the docker API',
    })

    const ingress = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: userId,
      type: 'managed.ingress.reconcile',
      payload: {},
    })
    await transitionCommand(db, ingress.id, {
      status: 'failed',
      error: 'proxysql admin.cnf is missing',
    })

    const statusRes = await app.request(
      `/environments/${environmentId}/managed/status`,
      { headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(statusRes.status, 200)
    const body = await statusRes.json() as { status: string | null; error: string | null }
    assertEquals(body.status, 'failed')
    assertEquals(
      body.error,
      'permission denied while trying to connect to the docker API\nproxysql admin.cnf is missing',
    )
  })
})

test('POST /environments/:id/managed does not seed provisional host/port', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as {
      managed: { host: string | null; port: number | null; id: string }
    }
    assertEquals(created.managed.host, null)
    assertEquals(created.managed.port, null)

    const [row] = await db
      .select({ metadata: managed.metadata })
      .from(managed)
      .where(eq(managed.id, created.managed.id))
      .limit(1)
    const meta = row?.metadata as Record<string, unknown>
    assertEquals(meta.host, undefined)
    assertEquals(meta.port, undefined)
    assertEquals(typeof meta.rootPrincipalId, 'string')
  })
})

test('backup routes are forbidden without manage grant', async () => {
  await withManagedFixtures({ withManageGrant: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const get = await app.request(`/environments/${environmentId}/managed/backups`, {
      headers,
    })
    assertEquals(get.status, 403)

    const create = await app.request(`/environments/${environmentId}/managed/backups`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 403)

    const remove = await app.request(
      `/environments/${environmentId}/managed/backups/bk_missing`,
      { method: 'DELETE', headers },
    )
    assertEquals(remove.status, 403)

    const restore = await app.request(
      `/environments/${environmentId}/managed/backups/bk_missing/restore`,
      { method: 'POST', headers, body: '{}' },
    )
    assertEquals(restore.status, 403)
  })
})

test('POST /environments/:id/managed/backups enqueues managed.backup create with the expected payload shape', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    const backup = await app.request(`/environments/${environmentId}/managed/backups`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(backup.status, 200)
    const backupBody = await backup.json() as {
      ok: boolean
      backupId: string
      commandId: string
      serverId: string
    }
    assertEquals(backupBody.ok, true)
    assertEquals(typeof backupBody.backupId, 'string')
    assertEquals(backupBody.backupId.startsWith('bk_'), true)
    assertEquals(typeof backupBody.commandId, 'string')

    const envelope = commandQueue.envelopes.at(-1)
    assertEquals(envelope?.type, 'managed.backup')

    const [commandRow] = await db
      .select({ payload: dispatch.payload })
      .from(dispatch)
      .where(eq(dispatch.commandId, envelope!.commandId))
      .limit(1)
    const payload = commandRow?.payload as Record<string, unknown>
    assertEquals(payload.managedId, created.managed.id)
    assertEquals(payload.engine, 'postgres')
    assertEquals(payload.action, 'create')
    assertEquals(payload.backupId, backupBody.backupId)
    assertEquals(payload.artifactExtension, 'dump')
    assertEquals(payload.scope, 'database')
    assertEquals(payload.database, 'postgres')
    assertEquals(payload.retentionKeep, 7)
  })
})

test('managed_busy guard on backup create while status=applying', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'applying' }).where(
      eq(managed.id, created.managed.id),
    )

    const backup = await app.request(`/environments/${environmentId}/managed/backups`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(backup.status, 409)
    assertEquals(await backup.json(), { error: 'managed_busy' })
  })
})

test('DELETE /environments/:id/managed/backups/:backupId 404s for an unknown id', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    const remove = await app.request(
      `/environments/${environmentId}/managed/backups/bk_missing`,
      { method: 'DELETE', headers },
    )
    assertEquals(remove.status, 404)
    assertEquals(await remove.json(), { error: 'backup_not_found' })
  })
})

test('POST restore 404s for an unknown backupId', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    const restore = await app.request(
      `/environments/${environmentId}/managed/backups/bk_missing/restore`,
      { method: 'POST', headers, body: '{}' },
    )
    assertEquals(restore.status, 404)
    assertEquals(await restore.json(), { error: 'backup_not_found' })
  })
})

test('GET backups returns stored metadata newest first, and delete/restore enqueue against a known record', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }

    const [row] = await db
      .select({ options: managed.options })
      .from(managed)
      .where(eq(managed.id, created.managed.id))
      .limit(1)
    const currentOptions = row?.options as { settings: unknown; databases: string[] }

    const older = {
      id: 'bk_older',
      createdAt: '2024-01-01T00:00:00.000Z',
      sizeBytes: 100,
      checksum: 'a'.repeat(64),
      database: 'postgres',
      path: '/var/lib/turbopanel/managed/x/backups/bk_older.dump',
    }
    const newer = {
      id: 'bk_newer',
      createdAt: '2024-06-01T00:00:00.000Z',
      sizeBytes: 200,
      checksum: 'b'.repeat(64),
      database: 'postgres',
      path: '/var/lib/turbopanel/managed/x/backups/bk_newer.dump',
    }
    await db.update(managed).set({
      status: 'ready',
      options: {
        settings: currentOptions.settings,
        databases: currentOptions.databases,
        backups: [older, newer],
      },
    }).where(eq(managed.id, created.managed.id))

    const list = await app.request(`/environments/${environmentId}/managed/backups`, {
      headers,
    })
    assertEquals(list.status, 200)
    const listBody = await list.json() as { backups: Array<{ id: string }> }
    assertEquals(listBody.backups.map((b) => b.id), ['bk_newer', 'bk_older'])

    const beforeCount = commandQueue.envelopes.length
    const remove = await app.request(
      `/environments/${environmentId}/managed/backups/bk_older`,
      { method: 'DELETE', headers },
    )
    assertEquals(remove.status, 200)
    const removeBody = await remove.json() as { ok: boolean; commandId: string }
    assertEquals(removeBody.ok, true)
    assertEquals(typeof removeBody.commandId, 'string')
    assertEquals(commandQueue.envelopes.length, beforeCount + 1)
    assertEquals(commandQueue.envelopes.at(-1)?.type, 'managed.backup')

    const restore = await app.request(
      `/environments/${environmentId}/managed/backups/bk_newer/restore`,
      { method: 'POST', headers, body: '{}' },
    )
    assertEquals(restore.status, 200)
    const restoreBody = await restore.json() as { ok: boolean; commandId: string }
    assertEquals(restoreBody.ok, true)
    assertEquals(typeof restoreBody.commandId, 'string')
    assertEquals(commandQueue.envelopes.length, beforeCount + 2)
    assertEquals(commandQueue.envelopes.at(-1)?.type, 'managed.restore')

    // Restore mutates the running engine — status flips to applying like managed.apply.
    const [afterRestore] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, created.managed.id))
      .limit(1)
    assertEquals(afterRestore?.status, 'applying')
  })
})

test('backup create/delete/restore target managed.server_id when environment placement has drifted', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string; serverId: string } }
    assertEquals(created.managed.serverId, serverId)
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    // Drift: repoint the environment to a second, offline server in the same
    // org, while the managed row keeps its original (online) server pin.
    // `assertTargetServerOnline` on the drifted server would reject with
    // `server_offline`, so a passing backup/delete/restore below proves the
    // routes dispatched against `managed.server_id`, not `ctx.serverId`.
    const now = new Date().toISOString()
    const [driftedServer] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Drifted Placement Server',
        createdAt: now,
        updatedAt: now,
        isConnected: false,
        statusChangedAt: now,
      })
      .returning({ id: server.id })
    const driftedServerId = driftedServer!.id
    await attachDaemonStateToServer(db, driftedServerId, {
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'managed-drift-test-key' },
      fingerprint: 'managed-drift-test-fingerprint',
    })
    await db.update(environment).set({ serverId: driftedServerId }).where(
      eq(environment.id, environmentId),
    )

    try {
      const beforeCreateCount = commandQueue.envelopes.length

      const backup = await app.request(`/environments/${environmentId}/managed/backups`, {
        method: 'POST',
        headers,
        body: '{}',
      })
      assertEquals(backup.status, 200)
      const backupBody = await backup.json() as { backupId: string; serverId: string }
      assertEquals(backupBody.serverId, serverId)
      assertEquals(commandQueue.envelopes.length, beforeCreateCount + 1)
      assertEquals(commandQueue.envelopes.at(-1)?.serverId, serverId)

      // Seed a stored backup record so delete/restore have a known target.
      const [row] = await db
        .select({ options: managed.options })
        .from(managed)
        .where(eq(managed.id, created.managed.id))
        .limit(1)
      const currentOptions = row?.options as { settings: unknown; databases: string[] }
      const record = {
        id: 'bk_drift',
        createdAt: '2024-01-01T00:00:00.000Z',
        sizeBytes: 100,
        checksum: 'a'.repeat(64),
        database: 'postgres',
        path: '/var/lib/turbopanel/managed/x/backups/bk_drift.dump',
      }
      await db.update(managed).set({
        status: 'ready',
        options: {
          settings: currentOptions.settings,
          databases: currentOptions.databases,
          backups: [record],
        },
      }).where(eq(managed.id, created.managed.id))

      const remove = await app.request(
        `/environments/${environmentId}/managed/backups/bk_drift`,
        { method: 'DELETE', headers },
      )
      assertEquals(remove.status, 200)
      const removeBody = await remove.json() as { ok: boolean; serverId: string }
      assertEquals(removeBody.serverId, serverId)
      assertEquals(commandQueue.envelopes.at(-1)?.serverId, serverId)

      const restore = await app.request(
        `/environments/${environmentId}/managed/backups/bk_drift/restore`,
        { method: 'POST', headers, body: '{}' },
      )
      assertEquals(restore.status, 200)
      const restoreBody = await restore.json() as { ok: boolean; serverId: string }
      assertEquals(restoreBody.serverId, serverId)
      assertEquals(commandQueue.envelopes.at(-1)?.serverId, serverId)
    } finally {
      await db.update(environment).set({ serverId }).where(
        eq(environment.id, environmentId),
      )
      await db.delete(server).where(eq(server.id, driftedServerId))
    }
  })
})

test('POST /environments/:id/managed/apply targets managed.server_id when environment placement has drifted', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    await withDriftedPlacement(db, environmentId, organizationId, serverId, async () => {
      const beforeCount = commandQueue.envelopes.length
      const apply = await app.request(`/environments/${environmentId}/managed/apply`, {
        method: 'POST',
        headers,
        body: '{}',
      })
      assertEquals(apply.status, 200)
      const applyBody = await apply.json() as { serverId: string }
      assertEquals(applyBody.serverId, serverId)
      // A successful apply also self-heals ProxySQL ingress and Orchestrator HA
      // reconcile for the same server — all envelopes must target
      // `managed.server_id`, never the drifted environment placement.
      const newEnvelopes = commandQueue.envelopes.slice(beforeCount)
      assertEquals(newEnvelopes.length, 3)
      assertEquals(
        newEnvelopes.every((envelope) => envelope.serverId === serverId),
        true,
      )
      assertEquals(
        newEnvelopes.some((envelope) => envelope.type === 'managed.apply'),
        true,
      )
      assertEquals(
        newEnvelopes.some((envelope) => envelope.type === 'managed.ingress.reconcile'),
        true,
      )
      assertEquals(
        newEnvelopes.some((envelope) => envelope.type === 'managed.ha.reconcile'),
        true,
      )
    })
  })
})

test('POST /environments/:id/managed/lifecycle targets managed.server_id when environment placement has drifted', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    await withDriftedPlacement(db, environmentId, organizationId, serverId, async () => {
      const beforeCount = commandQueue.envelopes.length
      const lifecycle = await app.request(
        `/environments/${environmentId}/managed/lifecycle`,
        { method: 'POST', headers, body: JSON.stringify({ action: 'restart' }) },
      )
      assertEquals(lifecycle.status, 200)
      const lifecycleBody = await lifecycle.json() as { serverId: string }
      assertEquals(lifecycleBody.serverId, serverId)
      assertEquals(commandQueue.envelopes.length, beforeCount + 1)
      assertEquals(commandQueue.envelopes.at(-1)?.serverId, serverId)
      assertEquals(commandQueue.envelopes.at(-1)?.type, 'managed.lifecycle')
    })
  })
})

test('DELETE /environments/:id/managed targets managed.server_id when environment placement has drifted', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    // Placed clusters always dispatch to the daemon (lifecycle stop leaves
    // containers; failed apply can still have brought the engine up).
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    await withDriftedPlacement(db, environmentId, organizationId, serverId, async () => {
      const beforeCount = commandQueue.envelopes.length
      const destroy = await app.request(`/environments/${environmentId}/managed`, {
        method: 'DELETE',
        headers,
      })
      assertEquals(destroy.status, 200)
      const destroyBody = await destroy.json() as { deleted: boolean; serverId: string }
      assertEquals(destroyBody.deleted, false)
      assertEquals(destroyBody.serverId, serverId)
      assertEquals(commandQueue.envelopes.length, beforeCount + 1)
      assertEquals(commandQueue.envelopes.at(-1)?.serverId, serverId)
      assertEquals(commandQueue.envelopes.at(-1)?.type, 'managed.destroy')
    })
  })
})

test('DELETE /environments/:id/managed marks the enqueued destroy payload deleteAfterDestroy so single-click delete completes row cleanup', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    // Placed clusters always dispatch to the daemon — this is the
    // single-click delete flow: API delete → queued managed.destroy →
    // consumer deletes the row only after the daemon reports success.
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    const destroy = await app.request(`/environments/${environmentId}/managed`, {
      method: 'DELETE',
      headers,
    })
    assertEquals(destroy.status, 200)
    const destroyBody = await destroy.json() as { deleted: boolean }
    // Deletion is not immediate — it happens after the daemon confirms
    // destroy succeeded, so the API response still reports `deleted: false`.
    assertEquals(destroyBody.deleted, false)

    const envelope = commandQueue.envelopes.at(-1)
    assertEquals(envelope?.type, 'managed.destroy')

    const [commandRow] = await db
      .select({ payload: dispatch.payload })
      .from(dispatch)
      .where(eq(dispatch.commandId, envelope!.commandId))
      .limit(1)
    const payload = commandRow?.payload as Record<string, unknown>
    assertEquals(payload.managedId, created.managed.id)
    assertEquals(payload.removeVolumes, true)
    assertEquals(payload.deleteAfterDestroy, true)

    // The managed row and its root principal are untouched until the
    // consumer's side effect runs on the terminal `succeeded` command —
    // this route never deletes them itself.
    const [stillPresent] = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.id, created.managed.id))
      .limit(1)
    assertEquals(stillPresent?.id, created.managed.id)
  })
})

test('POST /environments/:id/managed/root-password targets managed.server_id when environment placement has drifted', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    await withDriftedPlacement(db, environmentId, organizationId, serverId, async () => {
      const beforeCount = commandQueue.envelopes.length
      const rotate = await app.request(
        `/environments/${environmentId}/managed/root-password`,
        { method: 'POST', headers, body: '{}' },
      )
      assertEquals(rotate.status, 200)
      const rotateBody = await rotate.json() as {
        serverId: string
        rootPassword: string
        redeployRequired: { count: number; services: unknown[] }
      }
      assertEquals(rotateBody.serverId, serverId)
      assertEquals(typeof rotateBody.rootPassword, 'string')
      assertEquals((rotateBody.rootPassword.length ?? 0) > 0, true)
      assertEquals(rotateBody.redeployRequired.count, 0)
      assertEquals(rotateBody.redeployRequired.services, [])
      // A successful re-apply also self-heals ProxySQL ingress and Orchestrator HA
      // reconcile for the same server — all envelopes must target
      // `managed.server_id`, never the drifted environment placement.
      const newEnvelopes = commandQueue.envelopes.slice(beforeCount)
      assertEquals(newEnvelopes.length, 3)
      assertEquals(
        newEnvelopes.every((envelope) => envelope.serverId === serverId),
        true,
      )
      assertEquals(
        newEnvelopes.some((envelope) => envelope.type === 'managed.apply'),
        true,
      )
      assertEquals(
        newEnvelopes.some((envelope) => envelope.type === 'managed.ingress.reconcile'),
        true,
      )
      assertEquals(
        newEnvelopes.some((envelope) => envelope.type === 'managed.ha.reconcile'),
        true,
      )
    })
  })
})

test('POST root-password includes redeployRequired when bindings exist; DELETE user/db block on bindings', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
  }) => {
    try {
      await db.select({ id: binding.id }).from(binding).limit(1)
    } catch {
      console.warn('Skipping binding impact managed tests: binding table not applied')
      return
    }

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as {
      managed: { id: string; options?: { databases?: string[] } }
    }
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    // Consumer service (bindings need a service_id target).
    const [consumer] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'app',
        composeServiceName: 'app',
      })
      .returning({ id: service.id })
    const consumerServiceId = consumer!.id

    const [rootRow] = await db
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.managedId, created.managed.id))
      .limit(1)
    const rootPrincipalId = rootRow!.id

    await db.insert(binding).values({
      principalId: rootPrincipalId,
      serviceId: consumerServiceId,
      databaseName: 'postgres',
      keyPrefix: 'DATABASE',
      isEmitEngineDefaults: true,
    })

    const rotate = await app.request(
      `/environments/${environmentId}/managed/root-password`,
      { method: 'POST', headers, body: '{}' },
    )
    assertEquals(rotate.status, 200)
    const rotateBody = await rotate.json() as {
      redeployRequired: {
        count: number
        services: Array<{
          serviceId: string
          keyPrefix: string
          environmentId: string
          projectId: string
        }>
      }
    }
    assertEquals(rotateBody.redeployRequired.count, 1)
    assertEquals(rotateBody.redeployRequired.services[0]?.serviceId, consumerServiceId)
    assertEquals(rotateBody.redeployRequired.services[0]?.keyPrefix, 'DATABASE')
    assertEquals(rotateBody.redeployRequired.services[0]?.environmentId, environmentId)
    assertEquals(rotateBody.redeployRequired.services[0]?.projectId, projectId)

    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    const createUser = await app.request(`/environments/${environmentId}/managed/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'bound_user', databases: ['postgres'] }),
    })
    assertEquals(createUser.status, 200)
    const userBody = await createUser.json() as { user: { id: string } }
    const boundUserId = userBody.user.id

    await db.insert(binding).values({
      principalId: boundUserId,
      serviceId: consumerServiceId,
      databaseName: 'postgres',
      keyPrefix: 'APP',
      isEmitEngineDefaults: false,
    })

    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    const deleteUser = await app.request(
      `/environments/${environmentId}/managed/users/${boundUserId}`,
      { method: 'DELETE', headers },
    )
    assertEquals(deleteUser.status, 409)
    const deleteUserBody = await deleteUser.json() as {
      error: string
      services: Array<{ serviceId: string; keyPrefix: string }>
    }
    assertEquals(deleteUserBody.error, 'managed_user_has_bindings')
    assertEquals(deleteUserBody.services.some((s) => s.serviceId === consumerServiceId), true)

    // Extra non-initial DB then bind to it.
    const createDb = await app.request(`/environments/${environmentId}/managed/databases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'app_extra' }),
    })
    // Some engines pre-list only `postgres` — create may succeed when ready.
    if (createDb.status === 200) {
      await db.update(managed).set({ status: 'ready' }).where(
        eq(managed.id, created.managed.id),
      )
      await db.insert(binding).values({
        principalId: boundUserId,
        serviceId: consumerServiceId,
        databaseName: 'app_extra',
        keyPrefix: 'EXTRA',
        isEmitEngineDefaults: false,
      })
      const deleteDb = await app.request(
        `/environments/${environmentId}/managed/databases/app_extra`,
        { method: 'DELETE', headers },
      )
      assertEquals(deleteDb.status, 409)
      const deleteDbBody = await deleteDb.json() as { error: string }
      assertEquals(deleteDbBody.error, 'managed_database_has_bindings')
    }
  })
})

test('managed user create/delete target managed.server_id when environment placement has drifted', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    await withDriftedPlacement(db, environmentId, organizationId, serverId, async () => {
      const beforeCount = commandQueue.envelopes.length
      const createUser = await app.request(
        `/environments/${environmentId}/managed/users`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ username: 'drift_user', databases: ['postgres'] }),
        },
      )
      assertEquals(createUser.status, 200)
      const createBody = await createUser.json() as {
        serverId: string
        user: { id: string }
      }
      assertEquals(createBody.serverId, serverId)
      // Each apply also self-heals ProxySQL ingress and Orchestrator HA
      // reconcile for the same server — all envelopes must target
      // `managed.server_id`, never the drifted environment placement.
      const afterCreateEnvelopes = commandQueue.envelopes.slice(beforeCount)
      assertEquals(afterCreateEnvelopes.length, 3)
      assertEquals(
        afterCreateEnvelopes.every((envelope) => envelope.serverId === serverId),
        true,
      )

      // User create enqueued a managed.apply, which flips status to
      // `applying` — reset so the delete below is not rejected as busy.
      await db.update(managed).set({ status: 'ready' }).where(
        eq(managed.id, created.managed.id),
      )

      const deleteUser = await app.request(
        `/environments/${environmentId}/managed/users/${createBody.user.id}`,
        { method: 'DELETE', headers },
      )
      assertEquals(deleteUser.status, 200)
      const deleteBody = await deleteUser.json() as { serverId: string }
      assertEquals(deleteBody.serverId, serverId)
      const afterDeleteEnvelopes = commandQueue.envelopes.slice(beforeCount + 3)
      assertEquals(afterDeleteEnvelopes.length, 3)
      assertEquals(
        afterDeleteEnvelopes.every((envelope) => envelope.serverId === serverId),
        true,
      )
    })
  })
})

test('managed database create/delete target managed.server_id when environment placement has drifted', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    await withDriftedPlacement(db, environmentId, organizationId, serverId, async () => {
      const beforeCount = commandQueue.envelopes.length
      const createDb = await app.request(
        `/environments/${environmentId}/managed/databases`,
        { method: 'POST', headers, body: JSON.stringify({ name: 'drift_db' }) },
      )
      assertEquals(createDb.status, 200)
      const createBody = await createDb.json() as {
        serverId: string
        databases: string[]
      }
      assertEquals(createBody.serverId, serverId)
      assertEquals(createBody.databases.includes('drift_db'), true)
      // Each apply also self-heals ProxySQL ingress and Orchestrator HA
      // reconcile for the same server — all envelopes must target
      // `managed.server_id`, never the drifted environment placement.
      const afterCreateEnvelopes = commandQueue.envelopes.slice(beforeCount)
      assertEquals(afterCreateEnvelopes.length, 3)
      assertEquals(
        afterCreateEnvelopes.every((envelope) => envelope.serverId === serverId),
        true,
      )

      // Database create enqueued a managed.apply, which flips status to
      // `applying` — reset so the delete below is not rejected as busy.
      await db.update(managed).set({ status: 'ready' }).where(
        eq(managed.id, created.managed.id),
      )

      const deleteDb = await app.request(
        `/environments/${environmentId}/managed/databases/${encodeURIComponent('drift_db')}`,
        { method: 'DELETE', headers },
      )
      assertEquals(deleteDb.status, 200)
      const deleteBody = await deleteDb.json() as {
        serverId: string
        databases: string[]
      }
      assertEquals(deleteBody.serverId, serverId)
      assertEquals(deleteBody.databases.includes('drift_db'), false)
      const afterDeleteEnvelopes = commandQueue.envelopes.slice(beforeCount + 3)
      assertEquals(afterDeleteEnvelopes.length, 3)
      assertEquals(
        afterDeleteEnvelopes.every((envelope) => envelope.serverId === serverId),
        true,
      )
    })
  })
})

test('GET /environments/:id/managed returns null shape before provisioning', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/managed`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(res.status, 200)
    const body = await res.json() as {
      managed: unknown
      connection: unknown
      settings: unknown
      server: unknown
      rootUsername: string
    }
    assertEquals(body.managed, null)
    assertEquals(body.connection, null)
    assertEquals(body.settings, null)
    assertEquals(body.server, null)
    assertEquals(body.rootUsername, 'postgres')
  })
})

test('PATCH /environments/:id/managed persists clamped settings', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.environmentId, environmentId),
    )

    const patch = await app.request(`/environments/${environmentId}/managed`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        settings: { exposure: { enabled: false, scope: 'local' } },
      }),
    })
    assertEquals(patch.status, 200)
    const patchBody = await patch.json() as {
      ok: boolean
      settings: { exposure: { enabled: boolean } }
    }
    assertEquals(patchBody.ok, true)
    assertEquals(patchBody.settings.exposure.enabled, false)
  })
})

test('POST lifecycle rejects invalid action', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.environmentId, environmentId),
    )

    const bad = await app.request(
      `/environments/${environmentId}/managed/lifecycle`,
      { method: 'POST', headers, body: JSON.stringify({ action: 'pause' }) },
    )
    assertEquals(bad.status, 400)
    assertEquals(await bad.json(), { error: 'Invalid request' })
  })
})

test('DELETE hard-deletes unplaced managed without enqueueing destroy', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    // Create enqueues apply and sets status=applying; clear the busy guard so
    // DELETE can exercise the unplaced hard-delete path.
    await db.update(managed).set({ serverId: null, status: 'ready' }).where(
      eq(managed.id, created.managed.id),
    )

    const beforeCount = commandQueue.envelopes.length
    const destroy = await app.request(`/environments/${environmentId}/managed`, {
      method: 'DELETE',
      headers,
    })
    assertEquals(destroy.status, 200)
    assertEquals(await destroy.json(), { ok: true, deleted: true })
    assertEquals(commandQueue.envelopes.length, beforeCount)

    const rows = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.environmentId, environmentId))
    assertEquals(rows.length, 0)
  })
})

test('DELETE stopped placed managed enqueues destroy instead of hard-delete', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    commandQueue,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { managed: { id: string } }
    await db.update(managed).set({ status: 'stopped' }).where(
      eq(managed.id, created.managed.id),
    )

    const beforeCount = commandQueue.envelopes.length
    const destroy = await app.request(`/environments/${environmentId}/managed`, {
      method: 'DELETE',
      headers,
    })
    assertEquals(destroy.status, 200)
    const destroyBody = await destroy.json() as { deleted: boolean }
    assertEquals(destroyBody.deleted, false)
    assertEquals(commandQueue.envelopes.length, beforeCount + 1)
    assertEquals(commandQueue.envelopes.at(-1)?.type, 'managed.destroy')

    const [stillPresent] = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.id, created.managed.id))
      .limit(1)
    assertEquals(stillPresent?.id, created.managed.id)
  })
})

test('GET /environments/:id/managed/logs returns compose logs', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)

    const logs = await app.request(
      `/environments/${environmentId}/managed/logs?tail=50`,
      { headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(logs.status, 200)
    const body = await logs.json() as { logs: string }
    assertEquals(body.logs, 'stub-logs\n')
  })
})

test('POST user rejects invalid username and DELETE database protects initial database', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.environmentId, environmentId),
    )

    const badUser = await app.request(
      `/environments/${environmentId}/managed/users`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'postgres', databases: ['postgres'] }),
      },
    )
    assertEquals(badUser.status, 400)
    assertEquals(await badUser.json(), { error: 'Invalid username' })

    const dropInitial = await app.request(
      `/environments/${environmentId}/managed/databases/${encodeURIComponent('postgres')}`,
      { method: 'DELETE', headers },
    )
    assertEquals(dropInitial.status, 409)
    assertEquals(await dropInitial.json(), { error: 'cannot_drop_initial_database' })
  })
})

test('GET databases lists provisioned database names', async () => {
  await withManagedFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)

    const list = await app.request(
      `/environments/${environmentId}/managed/databases`,
      { headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(list.status, 200)
    const body = await list.json() as { databases: string[] }
    assertEquals(body.databases.includes('postgres'), true)
  })
})

test('create self-heals primary member; GET managed and status include members', async () => {
  await withManagedFixtures({}, async ({
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    serverId,
    db,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const create = await app.request(`/environments/${environmentId}/managed`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(create.status, 200)

    const membersRes = await app.request(
      `/environments/${environmentId}/managed/members`,
      { headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(membersRes.status, 200)
    const membersBody = await membersRes.json() as {
      members: Array<{
        id: string
        role: string
        ordinal: number
        serverId: string
        replicaClass: 'failover' | 'read' | null
      }>
    }
    assertEquals(membersBody.members.length, 1)
    assertEquals(membersBody.members[0]?.role, 'primary')
    assertEquals(membersBody.members[0]?.ordinal, 1)
    assertEquals(membersBody.members[0]?.serverId, serverId)
    assertEquals(membersBody.members[0]?.replicaClass, null)

    const detail = await app.request(`/environments/${environmentId}/managed`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(detail.status, 200)
    const detailBody = await detail.json() as {
      members: Array<{ role: string }>
    }
    assertEquals(detailBody.members?.some((m) => m.role === 'primary'), true)

    // Create leaves status `applying` (the fake command queue never
    // transitions it) — reset so the primary-role rejection below is not
    // masked by the busy gate.
    const [createdRow] = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.environmentId, environmentId))
      .limit(1)
    await db.update(managed).set({ status: 'ready' }).where(
      eq(managed.id, createdRow!.id),
    )

    const del = await app.request(
      `/environments/${environmentId}/managed/members/${membersBody.members[0]!.id}`,
      { method: 'DELETE', headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(del.status, 409)
    assertEquals(await del.json(), { error: 'managed_member_is_primary' })
  })
})

test('registerManagedRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  let threw = false
  try {
    registerManagedRoutes(app, {
      runtime: 'deno',
      signupEnvOverride: undefined,
    })
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
    assertEquals((error as Error).message, 'session secrets are required for managed routes')
  }
  assertEquals(threw, true)
})
