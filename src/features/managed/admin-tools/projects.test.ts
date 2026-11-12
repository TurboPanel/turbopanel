/**
 * Admin tool lookups and the scope sync against a real database (skipped
 * without `TURBOPANEL_DATABASE_URL`).
 */

import { assertEquals } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { skipWithoutDatabase } from '../../../test-fixtures/require-service.test.support.ts'
import { getDatabaseUrl } from '../../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../../db/connection.ts'
import {
  environment,
  login,
  managed,
  managedDatabase,
  organization,
  principal,
  project,
  scope,
  server,
  workspace,
} from '../../../db/schema.ts'
import { deriveEncryptionSecretsConfig } from '../../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../../test-fixtures/secrets.ts'
import { createManagedLogin } from '../logins.ts'
import { saveManagedDatabases } from '../options.ts'
import { postgresEngineSpec } from '../postgres.ts'
import {
  addDatabasesToAdminToolLogins,
  adminToolLoginIds,
  findAdminTool,
  listAdminTools,
} from './projects.ts'
import { insertToolProjectFixture, removeToolProjectFixture } from './projects.test.support.ts'

const dbUrl = getDatabaseUrl()

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

type Cluster = { managedId: string; databaseIds: Record<string, string> }

type Fixture = {
  db: ReturnType<typeof createDenoDb>
  dataEncryptionSecrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
  organizationId: string
  workspaceId: string
  serverId: string
  a: Cluster
  b: Cluster
}

/** One organization with two Database Clusters on one server, each with `postgres` and `shop`. */
async function withTwoClusters(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('admin tool store tests')
    return
  }
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Admin Tool Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Admin Tool Workspace', organizationId })
    .returning({ id: workspace.id })
  const now = new Date().toISOString()
  const [srv] = await db
    .insert(server)
    .values({ organizationId, name: 'Admin Tool Server', createdAt: now, updatedAt: now })
    .returning({ id: server.id })
  const projectIds: string[] = []
  const environmentIds: string[] = []
  const makeCluster = async (label: string): Promise<Cluster> => {
    const [proj] = await db
      .insert(project)
      .values({
        name: `Cluster ${label}`,
        workspaceId: ws!.id,
        organizationId,
        kind: 'managed',
        metadata: { code: 'postgres' },
      })
      .returning({ id: project.id })
    projectIds.push(proj!.id)
    const [env] = await db
      .insert(environment)
      .values({ name: 'production', projectId: proj!.id, serverId: srv!.id })
      .returning({ id: environment.id })
    environmentIds.push(env!.id)
    const [row] = await db
      .insert(managed)
      .values({
        environmentId: env!.id,
        serverId: srv!.id,
        name: `Postgres ${label}`,
        engine: 'postgres',
        status: 'ready',
        options: { settings: postgresEngineSpec.defaultSettings },
      })
      .returning({ id: managed.id })
    const databases = await db
      .insert(managedDatabase)
      .values([
        { managedId: row!.id, name: 'postgres' },
        { managedId: row!.id, name: 'shop' },
      ])
      .returning({ id: managedDatabase.id, name: managedDatabase.name })
    return {
      managedId: row!.id,
      databaseIds: Object.fromEntries(databases.map((entry) => [entry.name, entry.id])),
    }
  }
  const a = await makeCluster('A')
  const b = await makeCluster('B')
  try {
    await fn({
      db,
      dataEncryptionSecrets,
      organizationId,
      workspaceId: ws!.id,
      serverId: srv!.id,
      a,
      b,
    })
  } finally {
    for (const cluster of [a, b]) {
      await db.delete(managed).where(eq(managed.id, cluster.managedId))
    }
    await db.delete(principal).where(eq(principal.organizationId, organizationId))
    for (const id of environmentIds) await db.delete(environment).where(eq(environment.id, id))
    for (const id of projectIds) await db.delete(project).where(eq(project.id, id))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

async function listedDatabases(db: Fixture['db'], loginId: string): Promise<string[]> {
  const rows = await db
    .select({ name: managedDatabase.name })
    .from(scope)
    .innerJoin(managedDatabase, eq(managedDatabase.id, scope.databaseId))
    .where(eq(scope.loginId, loginId))
  return rows.map((row) => row.name).sort()
}

test('a tool is found through its binding, and copied metadata bound to another cluster is not a tool', async () => {
  await withTwoClusters(async (f) => {
    const { db, dataEncryptionSecrets } = f
    const toolA = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId: f.a.managedId,
      username: 'tool_a',
      databases: ['postgres', 'shop'],
      tool: true,
    })
    const toolB = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId: f.b.managedId,
      username: 'tool_b',
      databases: ['postgres', 'shop'],
      tool: true,
    })
    const real = await insertToolProjectFixture(db, {
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      serverId: f.serverId,
      metadataManagedId: f.a.managedId,
      metadataLoginId: toolA.loginId,
      boundLoginId: toolA.loginId,
      boundDatabaseId: f.a.databaseIds.shop,
      name: 'Real Tool',
    })
    // Metadata copied from a real tool of cluster A, but its service is bound to a login of cluster B.
    const fake = await insertToolProjectFixture(db, {
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      serverId: f.serverId,
      metadataManagedId: f.a.managedId,
      metadataLoginId: toolA.loginId,
      boundLoginId: toolB.loginId,
      boundDatabaseId: f.b.databaseIds.shop,
      name: 'Copied Tool',
    })
    try {
      const listed = await listAdminTools(db, f.a.managedId, f.organizationId)
      assertEquals(
        listed.map((tool) => tool.projectId),
        [real.projectId]
      )
      assertEquals(listed[0]?.meta.loginId, toolA.loginId)
      assertEquals(
        await findAdminTool(db, f.a.managedId, f.organizationId, fake.projectId),
        undefined
      )
      assertEquals(await adminToolLoginIds(db, f.a.managedId), [toolA.loginId])
      // The same project is not cluster B's tool either: its metadata names cluster A.
      assertEquals(await listAdminTools(db, f.b.managedId, f.organizationId), [])
    } finally {
      await removeToolProjectFixture(db, fake)
      await removeToolProjectFixture(db, real)
    }
  })
})

test('a new database is listed on the tool login only, and a repeat adds nothing', async () => {
  await withTwoClusters(async (f) => {
    const { db, dataEncryptionSecrets } = f
    const tool = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId: f.a.managedId,
      username: 'tool_a',
      databases: ['postgres', 'shop'],
      tool: true,
    })
    const ordinary = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId: f.a.managedId,
      username: 'app',
      databases: ['shop'],
    })
    const backup = await createManagedLogin(db, dataEncryptionSecrets, {
      managedId: f.a.managedId,
      username: 'backup',
      role: 'backup',
      databases: [],
    })
    const made = await insertToolProjectFixture(db, {
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      serverId: f.serverId,
      metadataManagedId: f.a.managedId,
      metadataLoginId: tool.loginId,
      boundLoginId: tool.loginId,
      boundDatabaseId: f.a.databaseIds.shop,
      name: 'Real Tool',
    })
    try {
      await saveManagedDatabases(db, f.a.managedId, {
        databases: ['postgres', 'shop', 'fresh'],
        ownerRoleDatabases: [],
        databaseOwners: {},
      })
      assertEquals(await listedDatabases(db, tool.loginId), ['fresh', 'postgres', 'shop'])
      assertEquals(await listedDatabases(db, ordinary.loginId), ['shop'])
      assertEquals(await listedDatabases(db, backup.loginId), [])

      // Saving the same list again adds no database and no scope row.
      await saveManagedDatabases(db, f.a.managedId, {
        databases: ['postgres', 'shop', 'fresh'],
        ownerRoleDatabases: [],
        databaseOwners: {},
      })
      const [fresh] = await db
        .select({ id: managedDatabase.id })
        .from(managedDatabase)
        .where(and(eq(managedDatabase.managedId, f.a.managedId), eq(managedDatabase.name, 'fresh')))
      await addDatabasesToAdminToolLogins(db, f.a.managedId, [fresh!.id])
      assertEquals(await listedDatabases(db, tool.loginId), ['fresh', 'postgres', 'shop'])
      const rows = await db
        .select({ id: scope.id })
        .from(scope)
        .where(eq(scope.loginId, tool.loginId))
      assertEquals(rows.length, 3)
      // Another cluster's login is never touched.
      const other = await db
        .select({ id: login.id })
        .from(login)
        .where(eq(login.managedId, f.b.managedId))
      assertEquals(other.length, 0)
    } finally {
      await removeToolProjectFixture(db, made)
    }
  })
})
