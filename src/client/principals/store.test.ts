import { assertEquals, assertRejects } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { deriveEncryptionSecretsConfig } from '../authn/secrets.ts'
import { decryptSecret } from '../authn/data-encryption.ts'
import {
  steward,
  environment,
  grant,
  managed,
  node,
  organization,
  principal,
  project,
  server,
  service,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import {
  createPrincipal,
  isManagedUsernameTaken,
  isServerPrincipalUsernameTaken,
  PRINCIPAL_PROVIDERS,
  replaceStewards,
  resolveAvailableManagedRootUsername,
  SERVER_PRINCIPAL_PROVIDER,
  setPrincipalPassword,
} from './store.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

async function withPrincipalFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    dataEncryptionSecrets: Awaited<
      ReturnType<typeof deriveEncryptionSecretsConfig>
    >
    serviceId: string
    principalId: string
    organizationId: string
    projectId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping principal store tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
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
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      name: 'Principal Store Env',
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
      kind: 'database',
      provider: 'postgres',
      username: 'app_user',
    })
    .returning({ id: principal.id })
  const principalId = insertedPrincipal!.id

  await db.insert(steward).values({
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
    await db.delete(steward).where(eq(steward.principalId, principalId))
    await db.delete(principal).where(eq(principal.id, principalId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
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
  await withPrincipalFixtures(async ({
    db,
    dataEncryptionSecrets,
    principalId,
  }) => {
    const plaintext = 'explicit-principal-secret'
    const result = await setPrincipalPassword(
      db,
      dataEncryptionSecrets,
      principalId,
      { password: plaintext },
    )
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
  await withPrincipalFixtures(async ({
    db,
    dataEncryptionSecrets,
    principalId,
  }) => {
    const result = await setPrincipalPassword(
      db,
      dataEncryptionSecrets,
      principalId,
      { generate: true },
    )
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
    assertEquals(
      await decryptSecret(dataEncryptionSecrets, stored!),
      result.plaintext,
    )
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
      'Principal not found',
    )

    await assertRejects(
      () =>
        setPrincipalPassword(db, dataEncryptionSecrets, missingId, {
          generate: true,
        }),
      Error,
      'Principal not found',
    )
  })
})

test('PRINCIPAL_PROVIDERS contains server not pam', () => {
  assertEquals(PRINCIPAL_PROVIDERS.has('server'), true)
  assertEquals(PRINCIPAL_PROVIDERS.has('pam'), false)
  assertEquals(SERVER_PRINCIPAL_PROVIDER, 'server')
})

test('isServerPrincipalUsernameTaken is org-scoped and case-insensitive', async () => {
  await withPrincipalFixtures(async ({ db, organizationId, projectId }) => {
    const [inserted] = await db
      .insert(principal)
      .values({
        kind: 'system',
        provider: SERVER_PRINCIPAL_PROVIDER,
        username: 'AppUser',
        projectId,
        metadata: { home: '/srv/users/AppUser' },
      })
      .returning({ id: principal.id })
    const createdId = inserted!.id

    try {
      assertEquals(
        await isServerPrincipalUsernameTaken(db, organizationId, 'appuser'),
        true,
      )
      assertEquals(
        await isServerPrincipalUsernameTaken(db, organizationId, '  APPUSER  '),
        true,
      )
      assertEquals(
        await isServerPrincipalUsernameTaken(db, organizationId, 'otheruser'),
        false,
      )
      assertEquals(
        await isServerPrincipalUsernameTaken(
          db,
          organizationId,
          'appuser',
          createdId,
        ),
        false,
      )
    } finally {
      await db.delete(principal).where(eq(principal.id, createdId))
    }
  })
})

test('isManagedUsernameTaken scopes by server-owning org not create chain', async () => {
  if (!dbUrl) {
    console.warn('Skipping managed username tests: TURBOPANEL_DATABASE_URL not set')
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
  await db.insert(node).values({
    managedId: m!.id,
    serverId: srvA!.id,
    role: 'primary',
    ordinal: 1,
  })
  const [prin] = await db
    .insert(principal)
    .values({
      kind: 'database',
      provider: 'postgres',
      username: 'SharedUser',
      managedId: m!.id,
    })
    .returning({ id: principal.id })

  try {
    assertEquals(
      await isManagedUsernameTaken(db, [organizationIdA], 'shareduser'),
      true,
    )
    assertEquals(
      await isManagedUsernameTaken(db, [organizationIdB], 'shareduser'),
      false,
    )
    assertEquals(
      await isManagedUsernameTaken(db, [organizationIdA], 'shareduser', prin!.id),
      false,
    )
  } finally {
    await db.delete(principal).where(eq(principal.id, prin!.id))
    await db.delete(node).where(eq(node.managedId, m!.id))
    await db.delete(managed).where(eq(managed.id, m!.id))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(server).where(eq(server.id, srvA!.id))
    await db.delete(organization).where(eq(organization.id, organizationIdA))
    await db.delete(organization).where(eq(organization.id, organizationIdB))
  }
})

test('resolveAvailableManagedRootUsername suffixes when preferred taken', async () => {
  if (!dbUrl) {
    console.warn('Skipping managed username tests: TURBOPANEL_DATABASE_URL not set')
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
  await db.insert(node).values({
    managedId,
    serverId: srv!.id,
    role: 'primary',
    ordinal: 1,
  })
  const [prin] = await db
    .insert(principal)
    .values({
      kind: 'database',
      provider: 'postgres',
      username: 'postgres',
      managedId,
    })
    .returning({ id: principal.id })

  try {
    const identifier = { pattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/, maxLength: 63 }
    const free = await resolveAvailableManagedRootUsername(
      db,
      [organizationId],
      'app_root',
      managedId,
      identifier,
    )
    assertEquals(free, 'app_root')

    const taken = await resolveAvailableManagedRootUsername(
      db,
      [organizationId],
      'postgres',
      managedId,
      identifier,
    )
    const hex = managedId.replaceAll('-', '').slice(0, 8).toLowerCase()
    assertEquals(taken, `postgres_${hex}`)
  } finally {
    await db.delete(principal).where(eq(principal.id, prin!.id))
    await db.delete(node).where(eq(node.managedId, managedId))
    await db.delete(managed).where(eq(managed.id, managedId))
    await db.delete(environment).where(eq(environment.id, env!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(server).where(eq(server.id, srv!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
})

test('createPrincipal and replaceStewards write expected steward edges', async () => {
  await withPrincipalFixtures(async ({ db, serviceId }) => {
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
          kind: 'database',
          provider: 'postgres',
          username: 'created_user',
        },
        [serviceId],
      )

      let edges = await db
        .select({ serviceId: steward.serviceId })
        .from(steward)
        .where(eq(steward.principalId, createdId))
      assertEquals(edges.map((row) => row.serviceId).toSorted((a, b) => a.localeCompare(b)), [
        serviceId,
      ])

      await replaceStewards(db, createdId, [secondServiceId])
      edges = await db
        .select({ serviceId: steward.serviceId })
        .from(steward)
        .where(eq(steward.principalId, createdId))
      assertEquals(edges.map((row) => row.serviceId).toSorted((a, b) => a.localeCompare(b)), [
        secondServiceId,
      ])

      await replaceStewards(db, createdId, [serviceId, secondServiceId])
      edges = await db
        .select({ serviceId: steward.serviceId })
        .from(steward)
        .where(eq(steward.principalId, createdId))
      assertEquals(
        edges.map((row) => row.serviceId).toSorted((a, b) => a.localeCompare(b)),
        [serviceId, secondServiceId].toSorted((a, b) => a.localeCompare(b)),
      )
    } finally {
      if (createdId) {
        await db.delete(steward).where(eq(steward.principalId, createdId))
        await db.delete(principal).where(eq(principal.id, createdId))
      }
      await db.delete(service).where(eq(service.id, secondServiceId))
    }
  })
})
