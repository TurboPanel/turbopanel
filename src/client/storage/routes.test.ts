import { assertEquals } from '@std/assert'
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
} from '../authn/secrets.ts'
import {
  environment,
  grant,
  storageCopy,
  mount,
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
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createStorageRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseTestSecretsConfig('deno')
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
  registerStorageRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
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
        kind: 'volume',
        name: 'app-data',
        storageCopy: { provider: 'docker', serverId },
      }),
    })
    assertEquals(createVolume.status, 200)
    const { id: volumeId } = await createVolume.json() as { ok: true; id: string }

    const [volumeCopy] = await db
      .select({
        storageId: storageCopy.storageId,
        provider: storageCopy.provider,
        serverId: storageCopy.serverId,
      })
      .from(storageCopy)
      .where(eq(storageCopy.storageId, volumeId))
      .limit(1)
    assertEquals(volumeCopy?.storageId, volumeId)
    assertEquals(volumeCopy?.provider, 'docker')
    assertEquals(volumeCopy?.serverId, serverId)

    const [volumeRow] = await db
      .select({ metadata: storage.metadata })
      .from(storage)
      .where(eq(storage.id, volumeId))
      .limit(1)
    const metadata = volumeRow?.metadata as { dockerVolumeName?: string } | null
    assertEquals(metadata?.dockerVolumeName, volumeId)

    const createDir = await app.request('/storage', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        serviceId,
        kind: 'directory',
        name: 'config',
        storageCopy: {
          provider: 'path',
          serverId,
          path: '/var/lib/app/config',
        },
        mount: {
          serviceId,
          destinationPath: '/etc/app/config',
        },
      }),
    })
    assertEquals(createDir.status, 200)
    const { id: dirId } = await createDir.json() as { ok: true; id: string }

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
    assertEquals(serviceBody.storage[0]?.id, dirId)

    const detail = await app.request(`/storage/${dirId}`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(detail.status, 200)
    const detailBody = await detail.json() as {
      storage: {
        id: string
        copies: Array<{ resolvedSourcePath: string | null }>
        mounts: Array<{ destinationPath: string }>
      }
    }
    assertEquals(detailBody.storage.id, dirId)
    assertEquals(detailBody.storage.mounts[0]?.destinationPath, '/etc/app/config')
    assertEquals(detailBody.storage.copies[0]?.resolvedSourcePath, '/var/lib/app/config')

    const patch = await app.request(`/storage/${dirId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'config-updated' }),
    })
    assertEquals(patch.status, 200)

    const delDir = await app.request(`/storage/${dirId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(delDir.status, 200)

    const delVolume = await app.request(`/storage/${volumeId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(delVolume.status, 200)
  })
})

test('POST /storage rejects invalid kinds', async () => {
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
        storageCopy: { provider: 'path', serverId },
      }),
    })
    assertEquals(res.status, 400)
    const body = await res.json() as { error?: string }
    assertEquals(body.error, 'Invalid request')
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
        kind: 'volume',
        name: 'bad-parent',
        storageCopy: { provider: 'docker', serverId },
      }),
    })
    assertEquals(res.status, 400)
    const body = await res.json() as { error?: string }
    assertEquals(body.error, 'At most one parent resource may be specified')
  })
})

test('POST /storage returns 404 when storageCopy server belongs to another org', async () => {
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
          kind: 'volume',
          name: 'foreign-server',
          storageCopy: { provider: 'docker', serverId: foreignServer!.id },
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
        kind: 'volume',
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

    const now = new Date().toISOString()
    const [row] = await db
      .insert(storage)
      .values({
        organizationId,
        projectId,
        environmentId: null,
        serviceId: null,
        kind: 'volume',
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
        content: 'hello-storage',
        storageCopy: { provider: 'path', serverId, path: '/app/secrets.txt' },
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

test('nested storageCopy and mount routes create, list, patch, and delete', async () => {
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

    const create = await app.request('/storage', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId,
        kind: 'volume',
        name: 'nested',
      }),
    })
    assertEquals(create.status, 200)
    const { id: storageId } = await create.json() as { ok: true; id: string }

    const addCopy = await app.request(`/storage/${storageId}/copies`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'docker', serverId }),
    })
    assertEquals(addCopy.status, 200)
    const { id: copyId } = await addCopy.json() as { ok: true; id: string }

    const listCopies = await app.request(`/storage/${storageId}/copies`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(listCopies.status, 200)
    const copyBody = await listCopies.json() as { copies: Array<{ id: string; provider: string }> }
    assertEquals(copyBody.copies.length, 1)
    assertEquals(copyBody.copies[0]?.id, copyId)
    assertEquals(copyBody.copies[0]?.provider, 'docker')

    const patchCopy = await app.request(`/storage/${storageId}/copies/${copyId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ state: 'ready' }),
    })
    assertEquals(patchCopy.status, 200)

    const addMount = await app.request(`/storage/${storageId}/mounts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ serviceId, destinationPath: '/data' }),
    })
    assertEquals(addMount.status, 200)
    const { id: mountId } = await addMount.json() as { ok: true; id: string }

    const [mountRow] = await db
      .select({ destinationPath: mount.destinationPath, readOnly: mount.isReadOnly })
      .from(mount)
      .where(eq(mount.id, mountId))
      .limit(1)
    assertEquals(mountRow?.destinationPath, '/data')
    assertEquals(mountRow?.readOnly, false)

    const patchMount = await app.request(`/storage/${storageId}/mounts/${mountId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ readOnly: true }),
    })
    assertEquals(patchMount.status, 200)

    const delMount = await app.request(`/storage/${storageId}/mounts/${mountId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(delMount.status, 200)

    const delCopy = await app.request(`/storage/${storageId}/copies/${copyId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(delCopy.status, 200)

    const leftover = await db
      .select({ id: storageCopy.id })
      .from(storageCopy)
      .where(eq(storageCopy.storageId, storageId))
    assertEquals(leftover.length, 0)
  })
})
