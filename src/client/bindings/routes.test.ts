/**
 * Real-DB route coverage for `registerBindingRoutes`.
 */

import { assertEquals } from 'jsr:@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { createSession } from '../authn/session-store.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
  type SecretsConfig,
} from '../authn/secrets.ts'
import {
  binding,
  container,
  environment,
  grant,
  managed,
  membership,
  node,
  organization,
  principal,
  project,
  server,
  service,
  tls,
  user,
  variable,
  workspace,
} from '../../lib/db/schema.ts'
import { postgresEngineSpec } from '../../lib/managed/postgres.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { registerBindingRoutes } from './routes.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createBindingRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  secretsConfig: SecretsConfig,
  options?: { withDataEncryption?: boolean },
) {
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = options?.withDataEncryption === false
    ? undefined
    : await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    if (dataEncryptionSecrets) {
      c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    }
    return next()
  })
  registerBindingRoutes(app, { secrets, runtime: 'deno' })
  return { app, secrets, dataEncryptionSecrets }
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

/** Exhaustive org cleanup (consumer + system managed-ingress workspaces). */
async function cleanupBindingRoutesOrg(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  userId: string,
): Promise<void> {
  const workspaceRows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.organizationId, organizationId))
  const workspaceIds = workspaceRows.map((row) => row.id)

  if (workspaceIds.length > 0) {
    const projectRows = await db
      .select({ id: project.id })
      .from(project)
      .where(inArray(project.workspaceId, workspaceIds))
    const projectIds = projectRows.map((row) => row.id)

    if (projectIds.length > 0) {
      const envRows = await db
        .select({ id: environment.id })
        .from(environment)
        .where(inArray(environment.projectId, projectIds))
      const environmentIds = envRows.map((row) => row.id)

      if (environmentIds.length > 0) {
        const serviceRows = await db
          .select({ id: service.id })
          .from(service)
          .where(inArray(service.environmentId, environmentIds))
        const serviceIds = serviceRows.map((row) => row.id)

        if (serviceIds.length > 0) {
          await db.delete(variable).where(inArray(variable.serviceId, serviceIds))
          await db.delete(binding).where(inArray(binding.serviceId, serviceIds))
          await db.delete(container).where(inArray(container.serviceId, serviceIds))
          await db.delete(service).where(inArray(service.id, serviceIds))
        }
        await db.delete(environment).where(inArray(environment.id, environmentIds))
      }
      await db.delete(project).where(inArray(project.id, projectIds))
    }
    await db.delete(workspace).where(inArray(workspace.id, workspaceIds))
  }

  await db.delete(tls).where(eq(tls.organizationId, organizationId))
  await db.delete(server).where(eq(server.organizationId, organizationId))
  await db.delete(grant).where(and(
    eq(grant.actorId, userId),
    eq(grant.entityId, organizationId),
  ))
  await db.delete(membership).where(and(
    eq(membership.userId, userId),
    eq(membership.organizationId, organizationId),
  ))
  await db.delete(user).where(eq(user.id, userId))
  await db.delete(organization).where(eq(organization.id, organizationId))
}

async function withBindingFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    dataEncryptionSecrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
    secretsConfig: SecretsConfig
    userId: string
    organizationId: string
    serverId: string
    managedId: string
    managedEnvironmentId: string
    principalId: string
    consumerEnvironmentId: string
    consumerServiceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping binding route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  try {
    const probe = createDenoDb()
    await probe.select({ id: binding.id }).from(binding).limit(1)
  } catch {
    console.warn('Skipping binding route tests: binding table not applied')
    return
  }

  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const db = createDenoDb()
  const { app, secrets, dataEncryptionSecrets } = await createBindingRoutesTestApp(
    db,
    secretsConfig,
  )
  if (!dataEncryptionSecrets) {
    throw new TypeError('expected data encryption secrets for binding fixtures')
  }

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Binding Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `bind-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(membership).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Binding Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Binding Route Server',
      createdAt: now,
      updatedAt: now,
      connected: true,
      statusChangedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [managedProject] = await db
    .insert(project)
    .values({
      name: 'Binding Route Managed Project',
      workspaceId,
      metadata: { type: 'managed', code: 'postgres' },
    })
    .returning({ id: project.id })

  const [managedEnv] = await db
    .insert(environment)
    .values({
      name: 'Production',
      projectId: managedProject!.id,
      serverId,
    })
    .returning({ id: environment.id })
  const managedEnvironmentId = managedEnv!.id

  const settings = postgresEngineSpec.defaultSettings
  const [insertedManaged] = await db
    .insert(managed)
    .values({
      environmentId: managedEnvironmentId,
      serverId,
      name: 'Postgres',
      engine: 'postgres',
      status: 'ready',
      options: { settings, databases: ['postgres', 'appdb'] },
    })
    .returning({ id: managed.id })
  const managedId = insertedManaged!.id

  await db.insert(node).values({
    managedId,
    serverId,
    role: 'primary',
    readEligible: false,
    ordinal: 1,
  })

  const sealedPassword = await encryptSecret(dataEncryptionSecrets, 'bind-route-secret')
  const [insertedPrincipal] = await db
    .insert(principal)
    .values({
      kind: 'database',
      provider: 'postgres',
      username: `bind_user_${crypto.randomUUID().slice(0, 8)}`,
      password: sealedPassword,
      managedId,
    })
    .returning({ id: principal.id })
  const principalId = insertedPrincipal!.id

  const [consumerProject] = await db
    .insert(project)
    .values({
      name: 'Binding Route Consumer Project',
      workspaceId,
      metadata: { type: 'docker-compose' },
    })
    .returning({ id: project.id })

  const [consumerEnv] = await db
    .insert(environment)
    .values({
      name: 'Consumer',
      projectId: consumerProject!.id,
      serverId,
    })
    .returning({ id: environment.id })
  const consumerEnvironmentId = consumerEnv!.id

  const [consumerService] = await db
    .insert(service)
    .values({
      environmentId: consumerEnvironmentId,
      name: 'app',
      composeServiceName: 'app',
    })
    .returning({ id: service.id })
  const consumerServiceId = consumerService!.id

  try {
    await fn({
      db,
      app,
      secrets,
      dataEncryptionSecrets,
      secretsConfig,
      userId,
      organizationId,
      serverId,
      managedId,
      managedEnvironmentId,
      principalId,
      consumerEnvironmentId,
      consumerServiceId,
    })
  } finally {
    await cleanupBindingRoutesOrg(db, organizationId, userId)
  }
}

function authHeaders(
  cookie: string,
  organizationId: string,
): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: organizationId,
    'Content-Type': 'application/json',
  }
}

test('GET /bindings list filters and CRUD round-trip', async () => {
  await withBindingFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    principalId,
    managedEnvironmentId,
    consumerEnvironmentId,
    consumerServiceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = authHeaders(cookie, organizationId)

    const noFilter = await app.request('/bindings', { headers })
    assertEquals(noFilter.status, 400)
    const noFilterBody = await noFilter.json() as { error: string }
    assertEquals(
      noFilterBody.error.includes('Exactly one of serviceId'),
      true,
    )

    const dualFilter = await app.request(
      `/bindings?serviceId=${consumerServiceId}&environmentId=${consumerEnvironmentId}`,
      { headers },
    )
    assertEquals(dualFilter.status, 400)

    const emptyList = await app.request(
      `/bindings?serviceId=${consumerServiceId}`,
      { headers },
    )
    assertEquals(emptyList.status, 200)
    assertEquals(await emptyList.json(), { bindings: [] })

    const emptyManaged = await app.request(
      `/bindings?managedEnvironmentId=${managedEnvironmentId}`,
      { headers },
    )
    assertEquals(emptyManaged.status, 200)
    assertEquals(await emptyManaged.json(), { bindings: [] })

    const emptyConsumerEnv = await app.request(
      `/bindings?environmentId=${consumerEnvironmentId}`,
      { headers },
    )
    assertEquals(emptyConsumerEnv.status, 200)
    assertEquals(await emptyConsumerEnv.json(), { bindings: [] })

    const foreignService = crypto.randomUUID()
    const notFound = await app.request(
      `/bindings?serviceId=${foreignService}`,
      { headers },
    )
    assertEquals(notFound.status, 404)

    const createMissing = await app.request('/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify({ serviceId: consumerServiceId }),
    })
    assertEquals(createMissing.status, 400)

    const createBadPrefix = await app.request('/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        principalId,
        serviceId: consumerServiceId,
        databaseName: 'postgres',
        keyPrefix: 'TURBOPANEL',
      }),
    })
    assertEquals(createBadPrefix.status, 400)

    const createUnknownDb = await app.request('/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        principalId,
        serviceId: consumerServiceId,
        databaseName: 'missing_db',
        keyPrefix: 'DATABASE',
        emitEngineDefaults: false,
      }),
    })
    assertEquals(createUnknownDb.status, 404)
    assertEquals(await createUnknownDb.json(), { error: 'database_not_found' })

    const create = await app.request('/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        principalId,
        serviceId: consumerServiceId,
        databaseName: 'postgres',
        keyPrefix: 'DATABASE',
        emitEngineDefaults: false,
      }),
    })
    assertEquals(create.status, 200)
    const created = await create.json() as { ok: true; id: string }
    assertEquals(created.ok, true)
    if (typeof created.id !== 'string') {
      throw new TypeError('expected binding id string')
    }
    const bindingId = created.id

    const varsAfterCreate = await db
      .select({ key: variable.key })
      .from(variable)
      .where(eq(variable.bindingId, bindingId))
    assertEquals(varsAfterCreate.length > 0, true)

    const listByService = await app.request(
      `/bindings?serviceId=${consumerServiceId}`,
      { headers },
    )
    assertEquals(listByService.status, 200)
    const serviceBody = await listByService.json() as {
      bindings: Array<{ id: string; serviceId: string; keyPrefix: string }>
    }
    assertEquals(serviceBody.bindings.length, 1)
    assertEquals(serviceBody.bindings[0]?.id, bindingId)
    assertEquals(serviceBody.bindings[0]?.serviceId, consumerServiceId)
    assertEquals(serviceBody.bindings[0]?.keyPrefix, 'DATABASE')

    const listByConsumerEnv = await app.request(
      `/bindings?environmentId=${consumerEnvironmentId}`,
      { headers },
    )
    assertEquals(listByConsumerEnv.status, 200)
    const envBody = await listByConsumerEnv.json() as {
      bindings: Array<{ id: string }>
    }
    assertEquals(envBody.bindings.length, 1)
    assertEquals(envBody.bindings[0]?.id, bindingId)

    const listByManagedEnv = await app.request(
      `/bindings?managedEnvironmentId=${managedEnvironmentId}`,
      { headers },
    )
    assertEquals(listByManagedEnv.status, 200)
    const managedBody = await listByManagedEnv.json() as {
      bindings: Array<{ id: string }>
    }
    assertEquals(managedBody.bindings.length, 1)
    assertEquals(managedBody.bindings[0]?.id, bindingId)

    const conflictPrefix = await app.request('/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        principalId,
        serviceId: consumerServiceId,
        databaseName: 'appdb',
        keyPrefix: 'DATABASE',
        emitEngineDefaults: false,
      }),
    })
    assertEquals(conflictPrefix.status, 409)

    const patchBad = await app.request(`/bindings/${bindingId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ keyPrefix: 'TURBOPANEL' }),
    })
    assertEquals(patchBad.status, 400)

    const patch = await app.request(`/bindings/${bindingId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        keyPrefix: 'APP',
        emitEngineDefaults: false,
      }),
    })
    assertEquals(patch.status, 200)
    assertEquals(await patch.json(), { ok: true })

    const [patchedRow] = await db
      .select({ keyPrefix: binding.keyPrefix })
      .from(binding)
      .where(eq(binding.id, bindingId))
      .limit(1)
    assertEquals(patchedRow?.keyPrefix, 'APP')

    const patchMissing = await app.request(
      `/bindings/${crypto.randomUUID()}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ keyPrefix: 'OTHER' }),
      },
    )
    assertEquals(patchMissing.status, 404)

    const deleteMissing = await app.request(
      `/bindings/${crypto.randomUUID()}`,
      { method: 'DELETE', headers },
    )
    assertEquals(deleteMissing.status, 404)

    const del = await app.request(`/bindings/${bindingId}`, {
      method: 'DELETE',
      headers,
    })
    assertEquals(del.status, 200)
    assertEquals(await del.json(), { ok: true })

    const afterDelete = await db
      .select({ id: binding.id })
      .from(binding)
      .where(eq(binding.id, bindingId))
      .limit(1)
    assertEquals(afterDelete.length, 0)
  })
})

test('POST /bindings rejects non-bindable principals and encryption gaps', async () => {
  await withBindingFixtures(async ({
    db,
    app,
    secrets,
    secretsConfig,
    userId,
    organizationId,
    managedId,
    principalId,
    consumerServiceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = authHeaders(cookie, organizationId)

    const [rootPrincipal] = await db
      .insert(principal)
      .values({
        kind: 'database',
        provider: 'postgres',
        username: `root_${crypto.randomUUID().slice(0, 8)}`,
        managedId,
        metadata: { managedRoot: true },
      })
      .returning({ id: principal.id })

    const rootCreate = await app.request('/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        principalId: rootPrincipal!.id,
        serviceId: consumerServiceId,
        databaseName: 'postgres',
        keyPrefix: 'ROOTDB',
        emitEngineDefaults: false,
      }),
    })
    assertEquals(rootCreate.status, 404)

    const [noPassword] = await db
      .insert(principal)
      .values({
        kind: 'database',
        provider: 'postgres',
        username: `nopw_${crypto.randomUUID().slice(0, 8)}`,
        managedId,
      })
      .returning({ id: principal.id })

    const noPwCreate = await app.request('/bindings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        principalId: noPassword!.id,
        serviceId: consumerServiceId,
        databaseName: 'postgres',
        keyPrefix: 'NOPW',
        emitEngineDefaults: false,
      }),
    })
    assertEquals(noPwCreate.status, 422)
    assertEquals(await noPwCreate.json(), { error: 'binding_password_unavailable' })

    const { app: noEncApp, secrets: noEncSecrets } = await createBindingRoutesTestApp(
      db,
      secretsConfig,
      { withDataEncryption: false },
    )
    const noEncCookie = await sessionCookie(db, noEncSecrets, userId)

    const noEncCreate = await noEncApp.request('/bindings', {
      method: 'POST',
      headers: authHeaders(noEncCookie, organizationId),
      body: JSON.stringify({
        principalId,
        serviceId: consumerServiceId,
        databaseName: 'appdb',
        keyPrefix: 'NOENC',
        emitEngineDefaults: false,
      }),
    })
    assertEquals(noEncCreate.status, 503)
    assertEquals(await noEncCreate.json(), { error: 'Encryption unavailable' })
  })
})

test('GET /bindings managedEnvironmentId returns empty when cluster has no principals', async () => {
  await withBindingFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = authHeaders(cookie, organizationId)

    const [ws] = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.organizationId, organizationId))
      .limit(1)

    const [lonelyProject] = await db
      .insert(project)
      .values({
        name: 'Lonely Managed',
        workspaceId: ws!.id,
        metadata: { type: 'managed', code: 'postgres' },
      })
      .returning({ id: project.id })
    const [lonelyEnv] = await db
      .insert(environment)
      .values({
        name: 'Lonely',
        projectId: lonelyProject!.id,
        serverId,
      })
      .returning({ id: environment.id })
    await db.insert(managed).values({
      environmentId: lonelyEnv!.id,
      serverId,
      name: 'Lonely PG',
      engine: 'postgres',
      status: 'ready',
      options: {
        settings: postgresEngineSpec.defaultSettings,
        databases: ['postgres'],
      },
    })

    const res = await app.request(
      `/bindings?managedEnvironmentId=${lonelyEnv!.id}`,
      { headers },
    )
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { bindings: [] })
  })
})

test('PATCH /bindings/:id returns 503 when encryption secrets are missing', async () => {
  await withBindingFixtures(async ({
    db,
    secretsConfig,
    userId,
    organizationId,
    principalId,
    consumerServiceId,
  }) => {
    const [row] = await db
      .insert(binding)
      .values({
        principalId,
        serviceId: consumerServiceId,
        databaseName: 'postgres',
        keyPrefix: 'PATCHENC',
        emitEngineDefaults: false,
      })
      .returning({ id: binding.id })

    const { app, secrets } = await createBindingRoutesTestApp(
      db,
      secretsConfig,
      { withDataEncryption: false },
    )
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/bindings/${row!.id}`, {
      method: 'PATCH',
      headers: authHeaders(cookie, organizationId),
      body: JSON.stringify({ keyPrefix: 'PATCHED' }),
    })
    assertEquals(res.status, 503)
    assertEquals(await res.json(), { error: 'Encryption unavailable' })
  })
})
