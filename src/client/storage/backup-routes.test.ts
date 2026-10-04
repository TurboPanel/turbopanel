/**
 * Storage-copy backup routes against a real database: policy CRUD for a
 * manager, `manage` required (a read-only member is refused), a copy must
 * belong to the storage in the path, copies that cannot be backed up are
 * refused, manual backups list and dispatch to the copy's own server, and a
 * restore names an archive of that copy and carries the row's checksum.
 * Skips without TURBOPANEL_DATABASE_URL.
 */

import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  grant,
  organization,
  principal,
  server,
  storage,
  storageCopy,
  user,
  archive,
} from '../../db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerStorageRoutes } from './routes.ts'
import { buildStorageRestorePayload, registerStorageBackupRoutes } from './backup-routes.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  organizationId: string
  serverId: string
  storageId: string
  copyId: string
  managerCookie: string
  readerCookie: string
}

async function insertUser(db: Db, organizationId: string, permission: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({
      email: `copy-backup-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: row!.id,
    permission,
  })
  return row!.id
}

async function cookieFor(
  db: Db,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
}

async function insertCopy(
  db: Db,
  values: {
    organizationId: string
    serverId: string | null
    kind: string
    provider: string
    path?: string
    principalUsername?: string
  }
): Promise<{ storageId: string; copyId: string }> {
  let principalId: string | null = null
  if (values.principalUsername) {
    const [owner] = await db
      .insert(principal)
      .values({
        organizationId: values.organizationId,
        kind: 'system',
        provider: 'server',
        username: values.principalUsername,
        appliedUsername: values.principalUsername,
      })
      .returning({ id: principal.id })
    principalId = owner!.id
  }
  const [store] = await db
    .insert(storage)
    .values({
      organizationId: values.organizationId,
      kind: values.kind,
      name: 'uploads',
      principalId,
    })
    .returning({ id: storage.id })
  const [copy] = await db
    .insert(storageCopy)
    .values({
      storageId: store!.id,
      serverId: values.serverId,
      provider: values.provider,
      path: values.path ?? null,
    })
    .returning({ id: storageCopy.id })
  return { storageId: store!.id, copyId: copy!.id }
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping storage backup route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  const opts = { secrets, runtime: 'deno' as const, signupEnvOverride: undefined }
  registerStorageRoutes(app, opts)
  registerStorageBackupRoutes(app, opts)

  const [org] = await db
    .insert(organization)
    .values({ name: 'Copy Backup Route Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const userIds: string[] = []
  try {
    const managerId = await insertUser(db, organizationId, 'organization:manage')
    const readerId = await insertUser(db, organizationId, 'organization:read')
    userIds.push(managerId, readerId)
    const now = new Date().toISOString()
    const [srv] = await db
      .insert(server)
      .values({ organizationId, name: 'Copy Backup Server', createdAt: now, updatedAt: now })
      .returning({ id: server.id })
    const { storageId, copyId } = await insertCopy(db, {
      organizationId,
      serverId: srv!.id,
      kind: 'volume',
      provider: 'docker',
    })
    await fn({
      db,
      app,
      organizationId,
      serverId: srv!.id,
      storageId,
      copyId,
      managerCookie: await cookieFor(db, secrets, managerId),
      readerCookie: await cookieFor(db, secrets, readerId),
    })
  } finally {
    await db.delete(storage).where(eq(storage.organizationId, organizationId))
    await db.delete(principal).where(eq(principal.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db
      .delete(grant)
      .where(and(eq(grant.entityId, organizationId), inArray(grant.actorId, userIds)))
    if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

function request(
  fixture: Fixture,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {}
): Promise<Response> {
  return Promise.resolve(
    fixture.app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        Cookie: init.cookie ?? fixture.managerCookie,
        [ORG_ID_HEADER]: fixture.organizationId,
        'Content-Type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  )
}

function policiesPath(fixture: Fixture, storageId = fixture.storageId, copyId = fixture.copyId) {
  return `/storage/${storageId}/copies/${copyId}/backup-policies`
}

const DAILY = { name: 'Nightly', schedule: { preset: 'daily', time: '02:30' }, retentionKeep: 7 }

test('a manager creates, lists, edits and deletes a copy backup policy', async () => {
  await withFixture(async (fixture) => {
    const created = await request(fixture, policiesPath(fixture), { method: 'POST', body: DAILY })
    assertEquals(created.status, 201)
    const { policy, reconcile } = (await created.json()) as {
      policy: { id: string; targetKind: string; copyId: string; managedId: string | null }
      reconcile: { failedServerIds: string[] }
    }
    assertEquals(policy.targetKind, 'copy')
    assertEquals(policy.copyId, fixture.copyId)
    assertEquals(policy.managedId, null)
    // No command queue in this app: the push is reported, never an error.
    assertEquals(reconcile.failedServerIds, [fixture.serverId])

    const listed = (await (await request(fixture, policiesPath(fixture))).json()) as {
      policies: { id: string }[]
    }
    assertEquals(
      listed.policies.map((row) => row.id),
      [policy.id]
    )

    const edited = await request(fixture, `${policiesPath(fixture)}/${policy.id}`, {
      method: 'PATCH',
      body: { retentionKeep: 30 },
    })
    assertEquals(edited.status, 200)
    assertEquals(
      ((await edited.json()) as { policy: { retentionKeep: number } }).policy.retentionKeep,
      30
    )

    const runs = await request(fixture, `${policiesPath(fixture)}/${policy.id}/runs`)
    assertEquals(await runs.json(), { runs: [] })

    const removed = await request(fixture, `${policiesPath(fixture)}/${policy.id}`, {
      method: 'DELETE',
    })
    assertEquals(removed.status, 200)
    const after = (await (await request(fixture, policiesPath(fixture))).json()) as {
      policies: unknown[]
    }
    assertEquals(after.policies, [])
  })
})

test('a read-only member cannot read or write copy backups', async () => {
  await withFixture(async (fixture) => {
    const cookie = fixture.readerCookie
    assertEquals((await request(fixture, policiesPath(fixture), { cookie })).status, 403)
    const post = await request(fixture, policiesPath(fixture), {
      method: 'POST',
      body: DAILY,
      cookie,
    })
    assertEquals(post.status, 403)
    const backups = await request(
      fixture,
      `/storage/${fixture.storageId}/copies/${fixture.copyId}/backups`,
      { method: 'POST', cookie }
    )
    assertEquals(backups.status, 403)
  })
})

test('a copy that belongs to another storage is not found', async () => {
  await withFixture(async (fixture) => {
    const other = await insertCopy(fixture.db, {
      organizationId: fixture.organizationId,
      serverId: fixture.serverId,
      kind: 'volume',
      provider: 'docker',
    })
    const res = await request(fixture, policiesPath(fixture, fixture.storageId, other.copyId), {
      method: 'POST',
      body: DAILY,
    })
    assertEquals(res.status, 404)
    const notUuid = await request(fixture, policiesPath(fixture, fixture.storageId, 'nope'))
    assertEquals(notUuid.status, 404)
  })
})

test('copies that cannot be backed up are refused; a principal-style path is accepted', async () => {
  await withFixture(async (fixture) => {
    const refused = [
      { kind: 'volume', provider: 's3' },
      { kind: 'directory', provider: 'path', path: '/etc' },
      { kind: 'directory', provider: 'path', path: '/srv/users/../etc' },
      // Inside /srv/users but another site owner's tree, or no owner at all.
      {
        kind: 'directory',
        provider: 'path',
        path: '/srv/users/victim/volumes/uploads',
        principalUsername: 'acme',
      },
      { kind: 'directory', provider: 'path', path: '/srv/users/acme/volumes/uploads' },
      { kind: 'file', provider: 'path' },
    ]
    for (const values of refused) {
      const target = await insertCopy(fixture.db, {
        organizationId: fixture.organizationId,
        serverId: fixture.serverId,
        ...values,
      })
      const res = await request(fixture, policiesPath(fixture, target.storageId, target.copyId), {
        method: 'POST',
        body: DAILY,
      })
      assertEquals(res.status, 400, JSON.stringify(values))
      assertEquals(((await res.json()) as { error: string }).error, 'backup_target_unsupported')
    }
    const accepted = await insertCopy(fixture.db, {
      organizationId: fixture.organizationId,
      serverId: fixture.serverId,
      kind: 'directory',
      provider: 'path',
      path: '/srv/users/acme/volumes/uploads',
      principalUsername: 'acme',
    })
    const res = await request(fixture, policiesPath(fixture, accepted.storageId, accepted.copyId), {
      method: 'POST',
      body: DAILY,
    })
    assertEquals(res.status, 201)
  })
})

test('a manager cannot point a copy at another owner path or a foreign volume', async () => {
  await withFixture(async (fixture) => {
    const own = await insertCopy(fixture.db, {
      organizationId: fixture.organizationId,
      serverId: fixture.serverId,
      kind: 'directory',
      provider: 'path',
      path: '/srv/users/acme/volumes/uploads',
      principalUsername: 'acme',
    })
    const copyPath = `/storage/${own.storageId}/copies/${own.copyId}`
    const refusedPatches = [
      { path: '/srv/users/victim/volumes/uploads' },
      { path: '/srv/users/acme/volumes' },
      { path: '/etc' },
      { options: { managed: false, externalName: 'other-site-data' } },
    ]
    for (const body of refusedPatches) {
      const res = await request(fixture, copyPath, { method: 'PATCH', body })
      assertEquals(res.status, 400, JSON.stringify(body))
    }
    const ownPatch = await request(fixture, copyPath, {
      method: 'PATCH',
      body: { path: '/srv/users/acme/volumes/other' },
    })
    assertEquals(ownPatch.status, 200)
    const create = await request(fixture, `/storage/${own.storageId}/copies`, {
      method: 'POST',
      body: { provider: 'path', serverId: fixture.serverId, path: '/srv/users/victim/volumes/x' },
    })
    assertEquals(create.status, 400)
    const volume = await request(fixture, `/storage/${fixture.storageId}`, {
      method: 'PATCH',
      body: { metadata: { dockerVolumeName: 'someone-elses-volume' } },
    })
    assertEquals(volume.status, 400)
  })
})

test('manual copy backups list their records and dispatch only to an online server', async () => {
  await withFixture(async (fixture) => {
    await fixture.db.insert(archive).values({
      copyId: fixture.copyId,
      backupId: 'bk_manual',
      sizeBytes: 10,
      checksum: 'a'.repeat(64),
      path: `/backup/copies/${fixture.copyId}/bk_manual.tar.gz`,
    })
    const base = `/storage/${fixture.storageId}/copies/${fixture.copyId}/backups`
    const listed = (await (await request(fixture, base)).json()) as { backups: { id: string }[] }
    assertEquals(
      listed.backups.map((row) => row.id),
      ['bk_manual']
    )

    // The copy's server has no live daemon here.
    const create = await request(fixture, base, { method: 'POST' })
    assertEquals(create.status, 409)
    assertEquals(((await create.json()) as { error: string }).error, 'server_offline')

    const missing = await request(fixture, `${base}/bk_nope`, { method: 'DELETE' })
    assertEquals(missing.status, 404)
    const remove = await request(fixture, `${base}/bk_manual`, { method: 'DELETE' })
    assertEquals(remove.status, 409)
  })
})

test('a restore needs manage, an archive of this copy, and an online server', async () => {
  await withFixture(async (fixture) => {
    await fixture.db.insert(archive).values({
      copyId: fixture.copyId,
      backupId: 'bk_manual',
      sizeBytes: 10,
      checksum: 'a'.repeat(64),
      path: `/backup/copies/${fixture.copyId}/bk_manual.tar.gz`,
    })
    const base = `/storage/${fixture.storageId}/copies/${fixture.copyId}/backups`
    const restore = (backupId: string, cookie?: string) =>
      request(fixture, `${base}/${backupId}/restore`, { method: 'POST', cookie })

    assertEquals((await restore('bk_manual', fixture.readerCookie)).status, 403)
    const missing = await restore('bk_nope')
    assertEquals(missing.status, 404)
    assertEquals(((await missing.json()) as { error: string }).error, 'backup_not_found')

    // Another copy's archive is not this copy's, even in the same org.
    const other = await insertCopy(fixture.db, {
      organizationId: fixture.organizationId,
      serverId: fixture.serverId,
      kind: 'volume',
      provider: 'docker',
    })
    const crossCopy = await request(
      fixture,
      `/storage/${other.storageId}/copies/${other.copyId}/backups/bk_manual/restore`,
      { method: 'POST' }
    )
    assertEquals(crossCopy.status, 404)

    // The copy's server has no live daemon here.
    const offline = await restore('bk_manual')
    assertEquals(offline.status, 409)
    assertEquals(((await offline.json()) as { error: string }).error, 'server_offline')
  })
})

test('the restore payload takes its checksum and retention from the archive row', () => {
  const source = { copyId: 'c', copyProvider: 'docker' as const, volumeName: 'shop_uploads' }
  assertEquals(
    buildStorageRestorePayload(source, { id: 'bk_1', checksum: 'b'.repeat(64), policyId: null }),
    { ...source, backupId: 'bk_1', checksum: 'b'.repeat(64) }
  )
  assertEquals(
    buildStorageRestorePayload(source, { id: 'bk_2', checksum: 'c'.repeat(64), policyId: 'p' }),
    { ...source, backupId: 'bk_2', checksum: 'c'.repeat(64), policyId: 'p' }
  )
})
