import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../authn/secrets.ts'
import {
  environment,
  grant,
  membership,
  organization,
  project,
  server,
  service,
  storage,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerStorageRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createStorageRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerStorageRoutes(app, { secrets, runtime: 'deno' })
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

async function withStorageFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    projectId: string
    environmentId: string
    serviceId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping storage route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createStorageRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Storage Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `storage-route-${crypto.randomUUID()}@example.com`,
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

  const now = new Date().toISOString()
  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Storage Route Workspace', organizationId, createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Storage Route Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Storage Route Project',
      workspaceId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Storage Route Env',
      projectId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  const [insertedService] = await db
    .insert(service)
    .values({
      environmentId,
      name: 'web',
      composeServiceName: 'web',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })
  const serviceId = insertedService!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      projectId,
      environmentId,
      serviceId,
      serverId,
    })
  } finally {
    await db.delete(storage).where(eq(storage.organizationId, organizationId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(membership).where(and(
      eq(membership.userId, userId),
      eq(membership.organizationId, organizationId),
    ))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('storage CRUD covers list, parent filter, create, patch, and delete', async () => {
  await withStorageFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    serviceId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const emptyList = await app.request('/storage', {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(emptyList.status, 200)
    const emptyBody = await emptyList.json() as { storage: unknown[] }
    assertEquals(emptyBody.storage.length, 0)

    const createVolume = await app.request('/storage', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId,
        kind: 'docker_volume',
        name: 'app-data',
        serverId,
      }),
    })
    assertEquals(createVolume.status, 200)
    const { id: volumeId } = await createVolume.json() as { ok: true; id: string }

    const [volumeRow] = await db
      .select({ metadata: storage.metadata })
      .from(storage)
      .where(eq(storage.id, volumeId))
      .limit(1)
    const metadata = volumeRow?.metadata as { dockerVolumeName?: string } | null
    assertEquals(metadata?.dockerVolumeName, volumeId)

    const createMount = await app.request('/storage', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serviceId,
        kind: 'bind_mount',
        name: 'config',
        serverId,
        destinationPath: '/etc/app/config',
        sourcePath: '/var/lib/app/config',
      }),
    })
    assertEquals(createMount.status, 200)
    const { id: mountId } = await createMount.json() as { ok: true; id: string }

    const listAll = await app.request('/storage', {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(listAll.status, 200)
    const listBody = await listAll.json() as { storage: Array<{ id: string }> }
    assertEquals(listBody.storage.length, 2)

    const listByProject = await app.request(`/storage?projectId=${projectId}`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(listByProject.status, 200)
    const projectBody = await listByProject.json() as { storage: Array<{ id: string }> }
    assertEquals(projectBody.storage.length, 1)
    assertEquals(projectBody.storage[0]?.id, volumeId)

    const listByService = await app.request(`/storage?serviceId=${serviceId}`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(listByService.status, 200)
    const serviceBody = await listByService.json() as { storage: Array<{ id: string }> }
    assertEquals(serviceBody.storage.length, 1)
    assertEquals(serviceBody.storage[0]?.id, mountId)

    const detail = await app.request(`/storage/${mountId}`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(detail.status, 200)
    const detailBody = await detail.json() as {
      storage: { id: string; destinationPath: string | null; resolvedSourcePath: string | null }
    }
    assertEquals(detailBody.storage.id, mountId)
    assertEquals(detailBody.storage.destinationPath, '/etc/app/config')
    assertEquals(detailBody.storage.resolvedSourcePath, '/var/lib/app/config')

    const patch = await app.request(`/storage/${mountId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'config-updated' }),
    })
    assertEquals(patch.status, 200)

    const delMount = await app.request(`/storage/${mountId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(delMount.status, 200)

    const delVolume = await app.request(`/storage/${volumeId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(delVolume.status, 200)
  })
})

test('POST /storage rejects mount kinds without destinationPath', async () => {
  await withStorageFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/storage', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId,
        kind: 'bind_mount',
        name: 'missing-dest',
        serverId,
      }),
    })
    assertEquals(res.status, 400)
    const body = await res.json()
    assertEquals(body.error, 'destinationPath is required for mount kinds')
  })
})

test('POST /storage rejects ambiguous parent selection', async () => {
  await withStorageFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    environmentId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/storage', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId,
        environmentId,
        kind: 'docker_volume',
        name: 'bad-parent',
        serverId,
      }),
    })
    assertEquals(res.status, 400)
    const body = await res.json()
    assertEquals(body.error, 'Exactly one parent resource must be specified')
  })
})

test('POST /storage returns 404 when server belongs to another org', async () => {
  await withStorageFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
  }) => {
    const now = new Date().toISOString()
    const [foreignOrg] = await db
      .insert(organization)
      .values({ name: 'Foreign Storage Org' })
      .returning({ id: organization.id })
    const [foreignServer] = await db
      .insert(server)
      .values({
        organizationId: foreignOrg!.id,
        name: 'Foreign Server',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request('/storage', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId,
          kind: 'docker_volume',
          name: 'foreign-server',
          serverId: foreignServer!.id,
        }),
      })
      assertEquals(res.status, 404)
    } finally {
      await db.delete(server).where(eq(server.id, foreignServer!.id))
      await db.delete(organization).where(eq(organization.id, foreignOrg!.id))
    }
  })
})

test('GET /storage/:id returns 404 for storage in another org', async () => {
  await withStorageFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const now = new Date().toISOString()
    const [foreignOrg] = await db
      .insert(organization)
      .values({ name: 'Foreign Storage Detail Org' })
      .returning({ id: organization.id })
    const [foreignWs] = await db
      .insert(workspace)
      .values({
        organizationId: foreignOrg!.id,
        name: 'Foreign WS',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: workspace.id })
    const [foreignProject] = await db
      .insert(project)
      .values({
        workspaceId: foreignWs!.id,
        name: 'Foreign Project',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: project.id })
    const [foreignStorage] = await db
      .insert(storage)
      .values({
        organizationId: foreignOrg!.id,
        projectId: foreignProject!.id,
        environmentId: null,
        serviceId: null,
        serverId,
        kind: 'docker_volume',
        name: 'foreign',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: storage.id })

    try {
      const cookie = await sessionCookie(db, secrets, userId)
      const res = await app.request(`/storage/${foreignStorage!.id}`, {
        headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
      })
      assertEquals(res.status, 404)
    } finally {
      await db.delete(storage).where(eq(storage.id, foreignStorage!.id))
      await db.delete(project).where(eq(project.id, foreignProject!.id))
      await db.delete(workspace).where(eq(workspace.id, foreignWs!.id))
      await db.delete(organization).where(eq(organization.id, foreignOrg!.id))
    }
  })
})

test('PATCH /storage returns 403 for a member without manage grants', async () => {
  await withStorageFixtures(async ({
    db,
    app,
    secrets,
    organizationId,
    projectId,
    serverId,
  }) => {
    const [viewer] = await db
      .insert(user)
      .values({
        email: `storage-viewer-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'user',
      })
      .returning({ id: user.id })
    const viewerId = viewer!.id
    await db.insert(membership).values({ organizationId, userId: viewerId })

    const now = new Date().toISOString()
    const [row] = await db
      .insert(storage)
      .values({
        organizationId,
        projectId,
        environmentId: null,
        serviceId: null,
        serverId,
        kind: 'docker_volume',
        name: 'locked',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: storage.id })
    const storageId = row!.id

    try {
      const cookie = await sessionCookie(db, secrets, viewerId)
      const res = await app.request(`/storage/${storageId}`, {
        method: 'PATCH',
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'nope' }),
      })
      assertEquals(res.status, 403)
    } finally {
      await db.delete(storage).where(eq(storage.id, storageId))
      await db.delete(membership).where(and(
        eq(membership.userId, viewerId),
        eq(membership.organizationId, organizationId),
      ))
      await db.delete(user).where(eq(user.id, viewerId))
    }
  })
})

test('POST /storage seals file content when encryption is configured', async () => {
  await withStorageFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/storage', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId,
        kind: 'file',
        name: 'secrets.txt',
        serverId,
        destinationPath: '/app/secrets.txt',
        content: 'hello-storage',
      }),
    })
    assertEquals(res.status, 200)
    const { id } = await res.json() as { ok: true; id: string }

    const [row] = await db
      .select({ contentEnvelope: storage.contentEnvelope })
      .from(storage)
      .where(eq(storage.id, id))
      .limit(1)
    if (typeof row?.contentEnvelope !== 'string' || row.contentEnvelope.length === 0) {
      throw new TypeError('expected sealed content envelope')
    }
    assertEquals(row.contentEnvelope.startsWith('tpsecret.'), true)
  })
})
