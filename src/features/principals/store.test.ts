import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertMatch, assertRejects } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { isUniqueViolationOn } from '../../db/unique-violation.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { decryptSecret } from '../../lib/secrets/data-encryption.ts'
import {
  environment,
  grant,
  managed,
  organization,
  principal,
  project,
  replica,
  server,
  service,
  tenancy,
  user,
  workspace,
  login,
} from '../../db/schema.ts'
import {
  createPrincipal,
  ensureComposePrincipal,
  isManagedUsernameTaken,
  isServerPrincipalUsernameTaken,
  replaceTenancies,
  resolveManagedAppliedUsername,
  setPrincipalPassword,
} from './store.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

async function withPrincipalFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    dataEncryptionSecrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
    serviceId: string
    principalId: string
    organizationId: string
    projectId: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('principal store tests')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )

  const insertedOrg = await db
    .insert(organization)
    .values({ name: 'Principal Store Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg[0]!.id

  const insertedUser = await db
    .insert(user)
    .values({
      email: `principal-store-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser[0]!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:own',
  })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Principal Store Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      name: 'Principal Store Project',
      workspaceId,
      organizationId,
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'principal-store-env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  const [insertedService] = await db
    .insert(service)
    .values({
      environmentId,
      name: 'principal-store-service',
      composeServiceName: 'principal-store-service',
    })
    .returning({ id: service.id })
  const serviceId = insertedService!.id

  const [insertedPrincipal] = await db
    .insert(principal)
    .values({
      organizationId,
      username: 'app_user',
      appliedUsername: 'app_user',
    })
    .returning({ id: principal.id })
  const principalId = insertedPrincipal!.id

  await db.insert(tenancy).values({
    principalId,
    serviceId,
  })

  try {
    await fn({
      db,
      dataEncryptionSecrets,
      serviceId,
      principalId,
      organizationId,
      projectId,
    })
  } finally {
    await db.delete(tenancy).where(eq(tenancy.principalId, principalId))
    await db.delete(principal).where(eq(principal.id, principalId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(grant).where(and(eq(grant.actorId, userId), eq(grant.entityId, organizationId)))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('setPrincipalPassword with password seals as enc and never stores plaintext', async () => {
  await withPrincipalFixtures(async ({ db, dataEncryptionSecrets, principalId }) => {
    const plaintext = 'explicit-principal-secret'
    const result = await setPrincipalPassword(db, dataEncryptionSecrets, principalId, {
      password: plaintext,
    })
    assertEquals(result.plaintext, undefined)

    const rows = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, principalId))
      .limit(1)
    const stored = rows[0]!.password
    assertEquals(typeof stored, 'string')
    assertEquals(stored!.startsWith('tpsecret.'), true)
    assertEquals(stored!.includes(plaintext), false)
    assertEquals(await decryptSecret(dataEncryptionSecrets, stored!), plaintext)
  })
})

test('setPrincipalPassword generate:true returns plaintext once and stores enc', async () => {
  await withPrincipalFixtures(async ({ db, dataEncryptionSecrets, principalId }) => {
    const result = await setPrincipalPassword(db, dataEncryptionSecrets, principalId, {
      generate: true,
    })
    assertEquals(typeof result.plaintext, 'string')
    assertEquals((result.plaintext?.length ?? 0) > 0, true)

    const rows = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, principalId))
      .limit(1)
    const stored = rows[0]!.password
    assertEquals(typeof stored, 'string')
    assertEquals(stored!.startsWith('tpsecret.'), true)
    assertEquals(stored!.includes(result.plaintext!), false)
    assertEquals(await decryptSecret(dataEncryptionSecrets, stored!), result.plaintext)
  })
})

test('setPrincipalPassword throws when principal id is missing', async () => {
  await withPrincipalFixtures(async ({ db, dataEncryptionSecrets }) => {
    const missingId = crypto.randomUUID()

    await assertRejects(
      () =>
        setPrincipalPassword(db, dataEncryptionSecrets, missingId, {
          password: 'stale-principal-secret',
        }),
      Error,
      'Principal not found'
    )

    await assertRejects(
      () =>
        setPrincipalPassword(db, dataEncryptionSecrets, missingId, {
          generate: true,
        }),
      Error,
      'Principal not found'
    )
  })
})

test('isServerPrincipalUsernameTaken is org-scoped and case-insensitive', async () => {
  await withPrincipalFixtures(async ({ db, organizationId, projectId }) => {
    const [inserted] = await db
      .insert(principal)
      .values({
        organizationId,
        username: 'AppUser',
        appliedUsername: 'AppUser',
        projectId,
        metadata: { home: '/srv/users/AppUser' },
      })
      .returning({ id: principal.id })
    const createdId = inserted!.id

    try {
      assertEquals(await isServerPrincipalUsernameTaken(db, organizationId, 'appuser'), true)
      assertEquals(await isServerPrincipalUsernameTaken(db, organizationId, '  APPUSER  '), true)
      assertEquals(await isServerPrincipalUsernameTaken(db, organizationId, 'otheruser'), false)
      assertEquals(
        await isServerPrincipalUsernameTaken(db, organizationId, 'appuser', createdId),
        false
      )
    } finally {
      await db.delete(principal).where(eq(principal.id, createdId))
    }
  })
})

test('principal names are one pool per organization, shared with user logins', async () => {
  await withPrincipalFixtures(async ({ db, organizationId }) => {
    const insertPool = async (values: {
      username: string
      appliedUsername: string
      projectId?: string
      metadata?: Record<string, unknown>
    }) => {
      const [row] = await db
        .insert(principal)
        .values({ organizationId, ...values })
        .returning({ id: principal.id })
      return row!.id
    }
    const ids: string[] = []
    try {
      // No project at all: visible to the server check through organization_id.
      ids.push(
        await insertPool({
          username: 'orphan',
          appliedUsername: 'orphan_x1y2z3a4b5c',
        })
      )
      assertEquals(await isServerPrincipalUsernameTaken(db, organizationId, 'ORPHAN'), true)
      assertEquals(
        await isServerPrincipalUsernameTaken(db, organizationId, 'orphan_x1y2z3a4b5c'),
        true
      )
      // The fixture's principal `app_user` is in the same pool.
      assertEquals(await isServerPrincipalUsernameTaken(db, organizationId, 'app_user'), true)
      assertEquals(await isManagedUsernameTaken(db, [organizationId], 'orphan'), true)
      assertEquals(await isManagedUsernameTaken(db, [organizationId], 'free_name'), false)

      // The index backs the check: a second pool row with the same typed or
      // applied name is refused by the database, case-insensitively.
      const typedDup = await insertPool({
        username: 'Orphan',
        appliedUsername: 'orphan_other',
      }).then(
        () => null,
        (err: unknown) => err
      )
      assertEquals(isUniqueViolationOn(typedDup, 'uniq_principal_organization_username'), true)
      const appliedDup = await insertPool({
        username: 'other',
        appliedUsername: 'ORPHAN_X1Y2Z3A4B5C',
      }).then(
        () => null,
        (err: unknown) => err
      )
      assertEquals(
        isUniqueViolationOn(appliedDup, 'uniq_principal_organization_applied_username'),
        true
      )
    } finally {
      if (ids.length > 0) await db.delete(principal).where(inArray(principal.id, ids))
    }
  })
})

test('isManagedUsernameTaken scopes by server-owning org not create chain', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('managed username tests')
    return
  }
  const db = createDenoDb()
  const [orgA] = await db
    .insert(organization)
    .values({ name: 'Managed Username Org A' })
    .returning({ id: organization.id })
  const [orgB] = await db
    .insert(organization)
    .values({ name: 'Managed Username Org B' })
    .returning({ id: organization.id })
  const organizationIdA = orgA!.id
  const organizationIdB = orgB!.id
  const now = new Date().toISOString()
  const [srvA] = await db
    .insert(server)
    .values({
      organizationId: organizationIdA,
      name: 'srv-a',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'ws', organizationId: organizationIdA })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      name: 'p',
      workspaceId: ws!.id,
      organizationId: organizationIdA,
      metadata: { type: 'managed', code: 'postgres' },
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ name: 'e', projectId: proj!.id, serverId: srvA!.id })
    .returning({ id: environment.id })
  const [m] = await db
    .insert(managed)
    .values({
      environmentId: env!.id,
      serverId: srvA!.id,
      name: 'pg',
      engine: 'postgres',
      status: 'ready',
    })
    .returning({ id: managed.id })
  await db.insert(replica).values({
    managedId: m!.id,
    serverId: srvA!.id,
    role: 'primary',
    ordinal: 1,
  })
  const [prin] = await db
    .insert(principal)
    .values({
      organizationId: organizationIdA,
      username: 'SharedUser',
      appliedUsername: 'SharedUser',
    })
    .returning({ id: principal.id })

  try {
    assertEquals(await isManagedUsernameTaken(db, [organizationIdA], 'shareduser'), true)
    assertEquals(await isManagedUsernameTaken(db, [organizationIdB], 'shareduser'), false)
    assertEquals(await isManagedUsernameTaken(db, [organizationIdA], 'shareduser', prin!.id), false)
  } finally {
    await db.delete(principal).where(eq(principal.id, prin!.id))
    await db.delete(replica).where(eq(replica.managedId, m!.id))
    await db.delete(managed).where(eq(managed.id, m!.id))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(server).where(eq(server.id, srvA!.id))
    await db.delete(organization).where(eq(organization.id, organizationIdA))
    await db.delete(organization).where(eq(organization.id, organizationIdB))
  }
})

test('resolveManagedAppliedUsername suffixes when short name taken', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('managed username tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Managed Root Suffix Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const now = new Date().toISOString()
  const [srv] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'srv',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'ws', organizationId })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      name: 'p',
      workspaceId: ws!.id,
      organizationId,
      metadata: { type: 'managed', code: 'postgres' },
    })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ name: 'e', projectId: proj!.id, serverId: srv!.id })
    .returning({ id: environment.id })
  const managedId = crypto.randomUUID()
  await db.insert(managed).values({
    id: managedId,
    environmentId: env!.id,
    serverId: srv!.id,
    name: 'pg',
    engine: 'postgres',
    status: 'ready',
  })
  await db.insert(replica).values({
    managedId,
    serverId: srv!.id,
    role: 'primary',
    ordinal: 1,
  })
  // The cluster's own root login holds the bare engine admin name.
  await db
    .insert(login)
    .values({
      recipe: 'app',
      managedId,
      role: 'root',
      username: 'postgres',
      appliedUsername: 'postgres',
    })

  await db
    .insert(login)
    .values({
      recipe: 'app',
      managedId,
      role: 'user',
      username: 'webuser',
      appliedUsername: 'webuser_x1',
    })

  try {
    // A user login takes part in the organization's name pool; the cluster's
    // root login does not.
    assertEquals(await isServerPrincipalUsernameTaken(db, organizationId, 'webuser'), true)
    assertEquals(await isServerPrincipalUsernameTaken(db, organizationId, 'webuser_x1'), true)
    assertEquals(await isServerPrincipalUsernameTaken(db, organizationId, 'postgres'), false)

    const identifier = { pattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/, maxLength: 63 }
    const free = await resolveManagedAppliedUsername(db, [organizationId], 'app_root', identifier, {
      scheme: 'plain',
    })
    assertEquals(free, 'app_root')

    const taken = await resolveManagedAppliedUsername(
      db,
      [organizationId],
      'postgres',
      identifier,
      { scheme: 'plain' }
    )
    assertMatch(taken, /^postgres_[a-z0-9]{11}$/)

    const suffixed = await resolveManagedAppliedUsername(
      db,
      [organizationId],
      'app_root',
      identifier,
      { scheme: 'partial' }
    )
    assertMatch(suffixed, /^app_root_[a-z0-9]{11}$/)

    // random: no trace of the typed name, still a valid engine identifier.
    const random = await resolveManagedAppliedUsername(
      db,
      [organizationId],
      'app_root',
      identifier,
      { scheme: 'random' }
    )
    assertMatch(random, /^[a-z][a-z0-9]{11}$/)
    assertEquals(identifier.pattern.test(random), true)
  } finally {
    await db.delete(login).where(eq(login.managedId, managedId))
    await db.delete(replica).where(eq(replica.managedId, managedId))
    await db.delete(managed).where(eq(managed.id, managedId))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('createPrincipal and replaceTenancies write expected tenancy edges', async () => {
  await withPrincipalFixtures(async ({ db, organizationId, serviceId }) => {
    const [secondService] = await db
      .insert(service)
      .values({
        name: 'principal-store-service-2',
        environmentId: (
          await db
            .select({ environmentId: service.environmentId })
            .from(service)
            .where(eq(service.id, serviceId))
            .limit(1)
        )[0]!.environmentId,
        composeServiceName: 'principal-store-service-2',
      })
      .returning({ id: service.id })
    const secondServiceId = secondService!.id

    let createdId: string | undefined
    try {
      createdId = await createPrincipal(
        db,
        {
          organizationId,
          username: 'created_user',
        },
        [serviceId]
      )

      let edges = await db
        .select({ serviceId: tenancy.serviceId })
        .from(tenancy)
        .where(eq(tenancy.principalId, createdId))
      assertEquals(
        edges.map((row) => row.serviceId).toSorted((a, b) => a.localeCompare(b)),
        [serviceId]
      )

      await replaceTenancies(db, createdId, [secondServiceId])
      edges = await db
        .select({ serviceId: tenancy.serviceId })
        .from(tenancy)
        .where(eq(tenancy.principalId, createdId))
      assertEquals(
        edges.map((row) => row.serviceId).toSorted((a, b) => a.localeCompare(b)),
        [secondServiceId]
      )

      await replaceTenancies(db, createdId, [serviceId, secondServiceId])
      edges = await db
        .select({ serviceId: tenancy.serviceId })
        .from(tenancy)
        .where(eq(tenancy.principalId, createdId))
      assertEquals(
        edges.map((row) => row.serviceId).toSorted((a, b) => a.localeCompare(b)),
        [serviceId, secondServiceId].toSorted((a, b) => a.localeCompare(b))
      )
    } finally {
      if (createdId) {
        await db.delete(tenancy).where(eq(tenancy.principalId, createdId))
        await db.delete(principal).where(eq(principal.id, createdId))
      }
      await db.delete(service).where(eq(service.id, secondServiceId))
    }
  })
})

test('ensureComposePrincipal follows the org default scheme and stores it', async () => {
  await withPrincipalFixtures(async ({ db, organizationId, projectId }) => {
    const scenarios = [
      { options: null, alias: 'wpuser', scheme: 'partial', shape: /^wpuser_[a-z0-9]{11}$/ },
      {
        options: { randomizedPrincipalUsernames: false },
        alias: 'plainuser',
        scheme: 'plain',
        shape: /^plainuser$/,
      },
      {
        options: { principalNameScheme: 'random' },
        alias: 'randuser',
        scheme: 'random',
        shape: /^[a-z][a-z0-9]{11}$/,
      },
    ] as const
    const ids: string[] = []
    try {
      for (const scenario of scenarios) {
        await db
          .update(organization)
          .set({ options: scenario.options })
          .where(eq(organization.id, organizationId))
        const { principalId } = await ensureComposePrincipal(db, {
          organizationId,
          projectId,
          alias: scenario.alias,
        })
        ids.push(principalId)
        const [row] = await db
          .select({
            username: principal.username,
            appliedUsername: principal.appliedUsername,
            options: principal.options,
          })
          .from(principal)
          .where(eq(principal.id, principalId))
        assertEquals(row?.username, scenario.alias)
        assertMatch(row?.appliedUsername ?? '', scenario.shape)
        assertEquals((row?.options as { nameScheme: string }).nameScheme, scenario.scheme)
      }
      // Re-running a deploy (idempotent by alias) keeps the stored system name
      // even after the org default changed.
      const [first] = await db
        .select({ appliedUsername: principal.appliedUsername })
        .from(principal)
        .where(eq(principal.id, ids[0]!))
      const again = await ensureComposePrincipal(db, {
        organizationId,
        projectId,
        alias: 'wpuser',
      })
      assertEquals(again, { principalId: ids[0], created: false })
      const [afterRow] = await db
        .select({ appliedUsername: principal.appliedUsername })
        .from(principal)
        .where(eq(principal.id, ids[0]!))
      assertEquals(afterRow?.appliedUsername, first?.appliedUsername)
    } finally {
      await db.delete(principal).where(inArray(principal.id, ids))
    }
  })
})
