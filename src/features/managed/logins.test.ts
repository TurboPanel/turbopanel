/**
 * The login table, its backfill and the dual-write with the legacy
 * `principal` rows (database-backed; skipped without `TURBOPANEL_DATABASE_URL`).
 *
 * The migration's backfill is replayed verbatim against temporary tables that
 * shadow `principal`, `binding` and `login` for one transaction, so the
 * statements that ship in `migrations/0030_login_table.sql` are the ones
 * proven here on rows shaped the way the previous release wrote them.
 */

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { and, eq, sql } from 'drizzle-orm'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  binding,
  environment,
  login,
  managed,
  organization,
  principal,
  project,
  server,
  service,
  workspace,
} from '../../db/schema.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { countPrincipalReferences, createManagedPrincipal } from '../principals/store.ts'
import { postgresEngineSpec } from './postgres.ts'
import {
  createLoginForPrincipal,
  findManagedLogin,
  listManagedLoginCredentials,
  listManagedLogins,
  removeManagedLogin,
  restoreManagedLogin,
  rotateLoginPassword,
  syncLegacyLogins,
} from './logins.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** A stand-in for a sealed envelope; never a real credential. */
const sealedFor = (tag: string) => `tpsecret.v1.${tag}`

const MIGRATION = new URL('../../../migrations/0030_login_table.sql', import.meta.url)

/** The migration's statements from its backfill on: INSERT, UPDATE, the duplicate guard, the unique index, comments. */
async function backfillStatements(): Promise<string[]> {
  const text = await Deno.readTextFile(MIGRATION)
  const statements = text.split('--> statement-breakpoint').map((entry) => entry.trim())
  const start = statements.findIndex((entry) => entry.startsWith('-- backfill'))
  if (start < 0) throw new TypeError('0030_login_table.sql has no backfill marker')
  return statements.slice(start).filter((entry) => entry.length > 0)
}

type LegacyPrincipal = {
  id: string
  managedId: string
  username: string
  appliedUsername: string
  metadata: Record<string, unknown>
  password: string | null
}

/**
 * Run `fn` against temporary tables that shadow the real ones for one
 * transaction (`pg_temp` comes first on the search path), seeded with
 * legacy-shaped rows, and roll everything back.
 */
async function withShadowedLegacyRows(
  db: ReturnType<typeof createDenoDb>,
  rows: LegacyPrincipal[],
  bindings: Array<{ id: string; principalId: string; serviceId: string }>,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>
): Promise<void> {
  const rollback = new Error('rollback')
  let inner: unknown
  await assertRejects(
    () =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql.raw('CREATE TEMP TABLE "principal" (LIKE "public"."principal" INCLUDING DEFAULTS)')
        )
        await tx.execute(
          sql.raw('CREATE TEMP TABLE "binding" (LIKE "public"."binding" INCLUDING DEFAULTS)')
        )
        await tx.execute(
          sql.raw('CREATE TEMP TABLE "login" (LIKE "public"."login" INCLUDING DEFAULTS)')
        )
        for (const row of rows) {
          await tx.execute(sql`
            INSERT INTO "principal" ("id", "organization_id", "kind", "provider", "username", "applied_username", "managed_id", "metadata", "password")
            VALUES (${row.id}::uuid, uuidv7(), 'database', 'postgres', ${row.username}, ${row.appliedUsername}, ${row.managedId}::uuid, ${JSON.stringify(row.metadata)}::jsonb, ${row.password})
          `)
        }
        for (const row of bindings) {
          await tx.execute(sql`
            INSERT INTO "binding" ("id", "principal_id", "service_id", "database_name")
            VALUES (${row.id}::uuid, ${row.principalId}::uuid, ${row.serviceId}::uuid, 'app')
          `)
        }
        try {
          await fn(tx)
        } catch (error) {
          inner = error
        }
        throw rollback
      }),
    Error,
    'rollback'
  )
  // An assertion that failed inside the transaction, not the rollback sentinel.
  if (inner !== undefined) throw inner
}

/** The database's own message: drizzle wraps it as `Failed query` with the cause underneath. */
function rootMessage(error: unknown): string {
  let current = error
  while (current instanceof Error && current.cause instanceof Error) current = current.cause
  return current instanceof Error ? current.message : String(current)
}

async function replayBackfill(
  tx: Parameters<Parameters<ReturnType<typeof createDenoDb>['transaction']>[0]>[0]
): Promise<void> {
  for (const statement of await backfillStatements()) {
    await tx.execute(sql.raw(statement))
  }
}

test('the migration backfill gives every legacy database principal a login and fills binding.login_id', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('login backfill test')
    return
  }
  const db = createDenoDb()
  try {
    const managedId = crypto.randomUUID()
    const root = crypto.randomUUID()
    const repl = crypto.randomUUID()
    const user = crypto.randomUUID()
    const bindingId = crypto.randomUUID()
    const serviceId = crypto.randomUUID()
    await withShadowedLegacyRows(
      db,
      [
        {
          id: root,
          managedId,
          username: 'postgres',
          appliedUsername: 'postgres_abcdefghijk',
          metadata: { managedRoot: true, engine: 'postgres', databases: ['postgres'] },
          password: sealedFor('root'),
        },
        {
          id: repl,
          managedId,
          username: 'tp_repl',
          appliedUsername: 'tp_repl_abcdefghijk',
          metadata: { managedReplication: true },
          password: sealedFor('repl'),
        },
        {
          id: user,
          managedId,
          username: 'app',
          appliedUsername: 'app',
          metadata: { engine: 'postgres', databases: ['postgres'], privileges: ['read-write'] },
          password: sealedFor('app'),
        },
      ],
      [{ id: bindingId, principalId: user, serviceId }],
      async (tx) => {
        await replayBackfill(tx)

        const logins = await tx.execute(
          sql.raw(
            'SELECT "principal_id", "role", "applied_username", "password", "metadata" FROM "login" ORDER BY "role"'
          )
        )
        const byRole = new Map(logins.map((row) => [row.role, row]))
        assertEquals([...byRole.keys()].sort(), ['replication', 'root', 'user'])

        const rootLogin = byRole.get('root')!
        assertEquals(rootLogin.principal_id, null)
        assertEquals(rootLogin.applied_username, 'postgres_abcdefghijk')
        assertEquals(rootLogin.password, sealedFor('root'))
        assertEquals((rootLogin.metadata as Record<string, unknown>).legacyPrincipalId, root)
        assertEquals((rootLogin.metadata as Record<string, unknown>).managedRoot, true)

        const replLogin = byRole.get('replication')!
        assertEquals(replLogin.principal_id, null)
        assertEquals((replLogin.metadata as Record<string, unknown>).legacyPrincipalId, repl)

        const userLogin = byRole.get('user')!
        assertEquals(userLogin.principal_id, user)
        assertEquals(userLogin.applied_username, 'app')
        assertEquals(userLogin.password, sealedFor('app'))
        assertEquals(userLogin.metadata, {
          engine: 'postgres',
          databases: ['postgres'],
          privileges: ['read-write'],
        })

        const [bound] = await tx.execute(
          sql.raw(
            'SELECT b."login_id" = l."id" AS linked FROM "binding" b JOIN "login" l ON l."principal_id" = b."principal_id"'
          )
        )
        assertEquals(bound?.linked, true)

        // The duplicate guard never runs twice on the same rows in a real
        // upgrade; replaying the unique index here proves it holds.
        const [indexed] = await tx.execute(
          sql.raw(
            "SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'uniq_login_managed_applied_username' AND tablename = 'login' AND schemaname = pg_my_temp_schema()::regnamespace::text"
          )
        )
        assertEquals(indexed?.n, 1)
      }
    )
  } finally {
    await endDbConnection(db)
  }
})

test('the migration refuses an upgrade whose legacy rows share a login name on one cluster, naming them', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('login backfill duplicate test')
    return
  }
  const db = createDenoDb()
  try {
    const managedId = crypto.randomUUID()
    let message = ''
    await withShadowedLegacyRows(
      db,
      [
        {
          id: crypto.randomUUID(),
          managedId,
          username: 'app',
          appliedUsername: 'App',
          metadata: { engine: 'postgres' },
          password: null,
        },
        {
          id: crypto.randomUUID(),
          managedId,
          username: 'app2',
          appliedUsername: 'app',
          metadata: { engine: 'postgres' },
          password: null,
        },
      ],
      [],
      async (tx) => {
        try {
          await replayBackfill(tx)
        } catch (error) {
          message = rootMessage(error)
        }
      }
    )
    assertStringIncludes(message, 'login names are not unique per cluster')
    assertStringIncludes(message, `cluster ${managedId} login app (2 rows)`)
  } finally {
    await endDbConnection(db)
  }
})

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
      metadata: { type: 'managed', code: 'postgres' },
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ name: 'Production', projectId: proj!.id, serverId: srv!.id })
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
      options: { settings: postgresEngineSpec.defaultSettings, databases: ['postgres'] },
    })
    .returning({ id: managed.id })
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

test('syncLegacyLogins adds the login a previous-release principal lacks, fills binding.login_id, and is idempotent', async () => {
  await withManagedFixture(async ({ db, organizationId, managedId, serviceId }) => {
    // Written the way the release before the login split wrote them.
    const [legacyUser] = await db
      .insert(principal)
      .values({
        organizationId,
        kind: 'database',
        provider: 'postgres',
        username: 'legacy',
        appliedUsername: 'legacy_abcdefghijk',
        options: { nameScheme: 'partial' },
        metadata: { engine: 'postgres', databases: ['postgres'] },
        password: sealedFor('legacy'),
        managedId,
      })
      .returning({ id: principal.id })
    const [legacyRoot] = await db
      .insert(principal)
      .values({
        organizationId,
        kind: 'database',
        provider: 'postgres',
        username: 'postgres',
        appliedUsername: 'postgres_abcdefghijk',
        metadata: { managedRoot: true, engine: 'postgres', databases: ['postgres'] },
        password: sealedFor('root'),
        managedId,
      })
      .returning({ id: principal.id })
    const [bound] = await db
      .insert(binding)
      .values({ principalId: legacyUser!.id, serviceId, databaseName: 'postgres' })
      .returning({ id: binding.id })

    await syncLegacyLogins(db, managedId)
    const logins = await listManagedLoginCredentials(db, managedId)
    assertEquals(
      logins.map((row) => [row.role, row.username, row.appliedUsername, row.principalId]),
      [
        ['user', 'legacy', 'legacy_abcdefghijk', legacyUser!.id],
        ['root', 'postgres_abcdefghijk', 'postgres_abcdefghijk', null],
      ]
    )
    assertEquals(logins[0]?.password, sealedFor('legacy'))
    assertEquals(logins[0]?.options, { nameScheme: 'partial' })
    assertEquals((logins[1]?.metadata as Record<string, unknown>).legacyPrincipalId, legacyRoot!.id)
    const [linked] = await db
      .select({ loginId: binding.loginId })
      .from(binding)
      .where(eq(binding.id, bound!.id))
    assertEquals(linked?.loginId, logins[0]?.id)

    await syncLegacyLogins(db, managedId)
    assertEquals((await listManagedLogins(db, managedId)).length, 2)

    // Found by its principal id, as the API names it, and by the root's legacy id.
    assertEquals((await findManagedLogin(db, managedId, legacyUser!.id))?.id, logins[0]?.id)
    assertEquals((await findManagedLogin(db, managedId, legacyRoot!.id))?.role, 'root')
    assertEquals(await findManagedLogin(db, managedId, 'not-a-uuid'), undefined)
  })
})

test('a new managed principal gets a login twin, rotation writes both, and removal keeps a shared identity', async () => {
  await withManagedFixture(async ({ db, dataEncryptionSecrets, organizationId, managedId }) => {
    const created = await createManagedPrincipal(db, dataEncryptionSecrets, {
      managedId,
      provider: 'postgres',
      username: 'app',
      appliedUsername: 'app',
      nameScheme: 'plain',
      metadata: { engine: 'postgres', databases: ['postgres'] },
    })
    const [twin] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, created.principalId))
    const [row] = await db.select().from(login).where(eq(login.id, created.loginId))
    assertEquals(row?.principalId, created.principalId)
    assertEquals(row?.role, 'user')
    assertEquals(row?.password, twin?.password)
    assertEquals(row?.options, { nameScheme: 'plain' })

    const rotated = await rotateLoginPassword(db, dataEncryptionSecrets, created.loginId)
    assertEquals(rotated.previousPassword, twin?.password)
    const [afterLogin] = await db
      .select({ password: login.password })
      .from(login)
      .where(eq(login.id, created.loginId))
    const [afterTwin] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, created.principalId))
    assertEquals(afterLogin?.password, afterTwin?.password)
    assertEquals(afterLogin?.password === twin?.password, false)

    // A login for a principal of the other form: the site owner's Linux user.
    const [systemUser] = await db
      .insert(principal)
      .values({
        organizationId,
        kind: 'system',
        provider: 'server',
        username: 'alice',
        appliedUsername: 'alice',
      })
      .returning({ id: principal.id })
    const shared = await createLoginForPrincipal(db, dataEncryptionSecrets, {
      managedId,
      principalId: systemUser!.id,
      appliedUsername: 'alice',
      metadata: { engine: 'postgres', databases: ['postgres'] },
    })
    assertEquals(
      (await listManagedLogins(db, managedId)).map((entry) => [entry.username, entry.principalId]),
      [
        ['alice', systemUser!.id],
        ['app', created.principalId],
      ]
    )

    const removedShared = await removeManagedLogin(db, shared.loginId)
    assertEquals(removedShared?.principal, null)
    const [aliceStays] = await db
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.id, systemUser!.id))
    assertEquals(aliceStays?.id, systemUser!.id)

    const removedOwn = await removeManagedLogin(db, created.loginId)
    assertEquals(removedOwn?.principal?.id, created.principalId)
    const gone = await db
      .select({ id: principal.id })
      .from(principal)
      .where(and(eq(principal.id, created.principalId), eq(principal.managedId, managedId)))
    assertEquals(gone.length, 0)

    await restoreManagedLogin(db, removedOwn!)
    assertEquals((await findManagedLogin(db, managedId, created.principalId))?.id, created.loginId)
    const [back] = await db
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.id, created.principalId))
    assertEquals(back?.id, created.principalId)
  })
})

test('removing a shared login in either order never revives it and keeps countable references', async () => {
  await withManagedFixture(async ({ db, dataEncryptionSecrets, managedId }) => {
    // A cluster is one per environment: add a second environment with its own cluster.
    const [first] = await db
      .select({ environmentId: managed.environmentId, serverId: managed.serverId })
      .from(managed)
      .where(eq(managed.id, managedId))
    const [firstEnv] = await db
      .select({ projectId: environment.projectId })
      .from(environment)
      .where(eq(environment.id, first!.environmentId))
    const [otherEnv] = await db
      .insert(environment)
      .values({ name: 'Staging', projectId: firstEnv!.projectId, serverId: first!.serverId })
      .returning({ id: environment.id })
    const [second] = await db
      .insert(managed)
      .values({
        environmentId: otherEnv!.id,
        serverId: first!.serverId,
        name: 'Postgres B',
        engine: 'postgres',
        status: 'ready',
        options: { settings: postgresEngineSpec.defaultSettings, databases: ['postgres'] },
      })
      .returning({ id: managed.id })
    const otherManagedId = second!.id
    try {
      const created = await createManagedPrincipal(db, dataEncryptionSecrets, {
        managedId,
        provider: 'postgres',
        username: 'shared',
        appliedUsername: 'shared',
        nameScheme: 'plain',
        metadata: { engine: 'postgres', databases: ['postgres'] },
      })
      const onOther = await createLoginForPrincipal(db, dataEncryptionSecrets, {
        managedId: otherManagedId,
        principalId: created.principalId,
        appliedUsername: 'shared',
        metadata: { engine: 'postgres', databases: ['postgres'] },
      })
      assertEquals((await countPrincipalReferences(db, created.principalId)).logins, 2)

      // Remove the login on the cluster the principal row points at: the row is kept
      // (the other login still uses it) and follows the remaining login's cluster.
      const removedFirst = await removeManagedLogin(db, created.loginId)
      assertEquals(removedFirst?.principal, null)
      assertEquals(removedFirst?.repointedPrincipal?.managedId, managedId)
      assertEquals((await listManagedLogins(db, managedId)).length, 0)

      // Removing the last login now finds the row and removes it; nothing is revived.
      const removedLast = await removeManagedLogin(db, onOther.loginId)
      assertEquals(removedLast?.principal?.id, created.principalId)
      assertEquals((await listManagedLogins(db, managedId)).length, 0)
      assertEquals((await listManagedLogins(db, otherManagedId)).length, 0)
      const left = await db
        .select({ id: principal.id })
        .from(principal)
        .where(eq(principal.id, created.principalId))
      assertEquals(left.length, 0)
    } finally {
      await db.delete(managed).where(eq(managed.id, otherManagedId))
      await db.delete(environment).where(eq(environment.id, otherEnv!.id))
    }
  })
})
