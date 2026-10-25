/**
 * The login table: settings columns, the databases a login may use (`scope`
 * rows), removal and restore (database-backed; skipped without
 * `TURBOPANEL_DATABASE_URL`).
 */

import { assertEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  binding,
  environment,
  login,
  managed,
  managedDatabase,
  organization,
  principal,
  project,
  scope,
  server,
  service,
  workspace,
} from '../../db/schema.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { countPrincipalReferences } from '../principals/store.ts'
import { loadManagedOptions, saveManagedOptions } from './options.ts'
import { postgresEngineSpec } from './postgres.ts'
import {
  createLoginForPrincipal,
  createManagedLogin,
  findManagedLogin,
  listManagedLogins,
  patchLogin,
  removeManagedLogin,
  removeLoginsDroppedByApply,
  restoreManagedLogin,
  rotateLoginPassword,
} from './logins.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function withManagedFixture(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    dataEncryptionSecrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
    organizationId: string
    managedId: string
    serviceId: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('login store tests')
    return
  }
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Login Store Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Login Store Workspace', organizationId })
    .returning({ id: workspace.id })
  const now = new Date().toISOString()
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Login Store Server', createdAt: now, updatedAt: now })
    .returning({ id: server.id })
  const [proj] = await db
    .insert(project)
    .values({
      name: 'Login Store Project',
      workspaceId: ws!.id,
      organizationId,
      kind: 'managed',
      metadata: { code: 'postgres' },
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ name: 'production', projectId: proj!.id, serverId: srv!.id })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({ environmentId: env!.id, name: 'web', composeServiceName: 'web' })
    .returning({ id: service.id })
  const [row] = await db
    .insert(managed)
    .values({
      environmentId: env!.id,
      serverId: srv!.id,
      name: 'Postgres',
      engine: 'postgres',
      status: 'ready',
      options: { settings: postgresEngineSpec.defaultSettings },
    })
    .returning({ id: managed.id })
  await db.insert(managedDatabase).values([
    { managedId: row!.id, name: 'postgres' },
    { managedId: row!.id, name: 'shop' },
  ])
  try {
    await fn({
      db,
      dataEncryptionSecrets,
      organizationId,
      managedId: row!.id,
      serviceId: svc!.id,
    })
  } finally {
    await db.delete(binding).where(eq(binding.serviceId, svc!.id))
    await db.delete(managed).where(eq(managed.id, row!.id))
    await db.delete(principal).where(eq(principal.organizationId, organizationId))
    await db.delete(service).where(eq(service.id, svc!.id))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

test('a new login keeps its settings as columns and lists its databases as scope rows', async () => {
  await withManagedFixture(async ({ db, dataEncryptionSecrets, managedId }) => {
    const created = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId,
      username: 'app',
      appliedUsername: 'app_abcdefghijk',
      nameScheme: 'partial',
      databases: ['shop', 'postgres'],
      privileges: ['read-write'],
      connectionRole: 'read-only',
      grantMode: 'recipe',
      tool: true,
      allowedSources: ['internal'],
      maxConnections: 4,
    })
    const found = await findManagedLogin(db, managedId, created.loginId)
    assertEquals(found?.username, 'app')
    assertEquals(found?.appliedUsername, 'app_abcdefghijk')
    assertEquals(found?.nameScheme, 'partial')
    assertEquals(found?.databases, ['shop', 'postgres'])
    assertEquals(found?.privileges, ['read-write'])
    assertEquals(found?.connectionRole, 'read-only')
    assertEquals(found?.grantMode, 'recipe')
    assertEquals(found?.tool, true)
    assertEquals(found?.allowedSources, ['internal'])
    assertEquals(found?.maxConnections, 4)
    assertEquals(found?.principalId, null)
    assertEquals(found?.password?.startsWith('tpsecret.'), true)

    // Only the id finds a login; a name or a made-up value does not.
    assertEquals(await findManagedLogin(db, managedId, 'app'), undefined)
    assertEquals(await findManagedLogin(db, managedId, 'not-a-uuid'), undefined)

    await patchLogin(db, created.loginId, {
      databases: ['shop'],
      allowedSources: null,
      maxConnections: null,
      tool: false,
    })
    const patched = await findManagedLogin(db, managedId, created.loginId)
    assertEquals(patched?.databases, ['shop'])
    assertEquals(patched?.allowedSources, undefined)
    assertEquals(patched?.maxConnections, undefined)
    assertEquals(patched?.tool, false)
    assertEquals(patched?.privileges, ['read-write'])
    await assertRejects(() => patchLogin(db, created.loginId, { databases: ['nope'] }), TypeError)
  })
})

test('rotation stores a new sealed password and returns the one it replaced', async () => {
  await withManagedFixture(async ({ db, dataEncryptionSecrets, managedId }) => {
    const created = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId,
      username: 'app',
      databases: ['postgres'],
    })
    const [before] = await db
      .select({ password: login.password })
      .from(login)
      .where(eq(login.id, created.loginId))
    const rotated = await rotateLoginPassword(db, dataEncryptionSecrets, created.loginId)
    assertEquals(rotated.previousPassword, before?.password)
    const [after] = await db
      .select({ password: login.password })
      .from(login)
      .where(eq(login.id, created.loginId))
    assertEquals(after?.password === before?.password, false)
  })
})

test('a login that shares a site owner Linux user name is counted as a reference and survives removal of the other login', async () => {
  await withManagedFixture(async ({ db, dataEncryptionSecrets, organizationId, managedId }) => {
    const [systemUser] = await db
      .insert(principal)
      .values({ organizationId, username: 'alice', appliedUsername: 'alice' })
      .returning({ id: principal.id })
    const shared = await createLoginForPrincipal(db, dataEncryptionSecrets, {
      managedId,
      principalId: systemUser!.id,
      appliedUsername: 'alice',
      databases: ['postgres'],
    })
    const own = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId,
      username: 'app',
      databases: ['postgres'],
    })
    assertEquals(
      (await listManagedLogins(db, managedId)).map((entry) => [entry.username, entry.principalId]),
      [
        ['alice', systemUser!.id],
        ['app', null],
      ]
    )
    assertEquals((await countPrincipalReferences(db, systemUser!.id)).logins, 1)

    await removeManagedLogin(db, own.loginId)
    const [aliceStays] = await db
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.id, systemUser!.id))
    assertEquals(aliceStays?.id, systemUser!.id)
    assertEquals(
      (await findManagedLogin(db, managedId, shared.loginId))?.principalId,
      systemUser!.id
    )
  })
})

test('removing a login drops its scope rows and clears the databases it owned; restore puts both back', async () => {
  await withManagedFixture(async ({ db, dataEncryptionSecrets, managedId }) => {
    const created = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId,
      username: 'owner',
      databases: ['shop'],
      privileges: ['owner'],
    })
    await db
      .update(managedDatabase)
      .set({ isRoleOwned: true, ownerLoginId: created.loginId })
      .where(eq(managedDatabase.name, 'shop'))

    const removed = await removeManagedLogin(db, created.loginId)
    assertEquals(removed?.databaseIds.length, 1)
    assertEquals(removed?.ownedDatabaseIds.length, 1)
    assertEquals(await findManagedLogin(db, managedId, created.loginId), undefined)
    const [shop] = await db
      .select({
        ownerLoginId: managedDatabase.ownerLoginId,
        isRoleOwned: managedDatabase.isRoleOwned,
      })
      .from(managedDatabase)
      .where(eq(managedDatabase.name, 'shop'))
    assertEquals(shop?.ownerLoginId, null)
    assertEquals(shop?.isRoleOwned, true)
    assertEquals(
      (await db.select().from(scope)).filter((row) => row.loginId === created.loginId),
      []
    )

    await restoreManagedLogin(db, removed!)
    const back = await findManagedLogin(db, managedId, created.loginId)
    assertEquals(back?.databases, ['shop'])
    const [owned] = await db
      .select({ ownerLoginId: managedDatabase.ownerLoginId })
      .from(managedDatabase)
      .where(eq(managedDatabase.name, 'shop'))
    assertEquals(owned?.ownerLoginId, created.loginId)
  })
})

test('a dropped account removes its login row only when the apply drops it', async () => {
  await withManagedFixture(async ({ db, dataEncryptionSecrets, managedId }) => {
    const created = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId,
      username: 'keep_me',
      databases: ['postgres'],
    })
    const stays = await findManagedLogin(db, managedId, created.loginId)
    // A host that refused the drop never reaches the removal: the row stays.
    await removeLoginsDroppedByApply(db, managedId, [])
    await removeLoginsDroppedByApply(db, managedId, ['someone_else'])
    assertEquals((await findManagedLogin(db, managedId, created.loginId))?.id, stays?.id)
    await removeLoginsDroppedByApply(db, managedId, [stays!.appliedUsername])
    assertEquals(await findManagedLogin(db, managedId, created.loginId), undefined)
  })
})

test('a binding keeps its login and database; removing the login removes the binding', async () => {
  await withManagedFixture(async ({ db, dataEncryptionSecrets, managedId, serviceId }) => {
    const created = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId,
      username: 'app',
      databases: ['postgres'],
    })
    const [database] = await db
      .select({ id: managedDatabase.id })
      .from(managedDatabase)
      .where(eq(managedDatabase.name, 'postgres'))
    await db
      .insert(binding)
      .values({ loginId: created.loginId, serviceId, databaseId: database!.id })
    await assertRejects(() =>
      db.delete(managedDatabase).where(eq(managedDatabase.id, database!.id))
    )
    await removeManagedLogin(db, created.loginId)
    assertEquals(
      (await db.select().from(binding).where(eq(binding.serviceId, serviceId))).length,
      0
    )
  })
})

test('loadManagedOptions assembles settings and databases; saveManagedOptions keeps the rows in step', async () => {
  await withManagedFixture(async ({ db, dataEncryptionSecrets, managedId }) => {
    const [row] = await db.select().from(managed).where(eq(managed.id, managedId))
    const loaded = await loadManagedOptions(db, postgresEngineSpec, row!)
    assertEquals(loaded?.databases, ['postgres', 'shop'])
    assertEquals(loaded?.ownerRoleDatabases, undefined)

    const owner = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId,
      username: 'boss',
      databases: ['shop'],
    })
    await saveManagedOptions(db, managedId, {
      settings: loaded!.settings,
      databases: ['blog', 'shop'],
      ownerRoleDatabases: ['shop'],
      databaseOwners: { shop: { loginId: owner.loginId, username: 'boss' } },
    })
    const [after] = await db.select().from(managed).where(eq(managed.id, managedId))
    const reloaded = await loadManagedOptions(db, postgresEngineSpec, after!)
    assertEquals(reloaded?.databases, ['blog', 'shop'])
    assertEquals(reloaded?.ownerRoleDatabases, ['shop'])
    assertEquals(reloaded?.databaseOwners, { shop: { loginId: owner.loginId, username: 'boss' } })
    assertEquals(after?.options, { settings: loaded!.settings })
    // The dropped database is gone with its scope rows; the kept one still lists the login.
    assertEquals((await findManagedLogin(db, managedId, owner.loginId))?.databases, ['shop'])
  })
})
