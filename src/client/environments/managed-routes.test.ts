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
import { emptyComposeDocument } from '../../lib/compose/index.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import {
  environment,
  grant,
  managed,
  member,
  organization,
  principal,
  project,
  server,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { getCatalogEntry, readManagedEngineOptions } from '../projects/catalog/index.ts'
import { registerEnvironmentManagedRoutes } from './managed-routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function composeWithPostgresService(): ComposeDocument {
  return {
    version: 1,
    data: {
      services: {
        postgres: { image: 'postgres:16' },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  }
}

async function createManagedRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerEnvironmentManagedRoutes(app, { secrets, runtime: 'deno' })
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

async function withManagedFixtures(
  options: {
    withManageGrant?: boolean
    withPlacement?: boolean
    projectKind?: 'managed-postgres' | 'docker-compose'
    foreignServer?: boolean
  },
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    workspaceId: string
    projectId: string
    environmentId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping environment managed route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const withManageGrant = options.withManageGrant !== false
  const withPlacement = options.withPlacement !== false
  const projectKind = options.projectKind ?? 'managed-postgres'
  const foreignServer = options.foreignServer === true

  const db = createDenoDb()
  const { app, secrets } = await createManagedRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Managed Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  let foreignOrgId: string | null = null
  if (foreignServer) {
    const [foreignOrg] = await db
      .insert(organization)
      .values({ displayName: 'Managed Route Foreign Org' })
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

  await db.insert(member).values({ organizationId, userId })
  if (withManageGrant) {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
      allow: true,
    })
  }

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Managed Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId: foreignServer ? foreignOrgId! : organizationId,
      displayName: 'Managed Route Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const catalogEntry = getCatalogEntry('postgres')
  if (!catalogEntry) throw new TypeError('missing postgres catalog entry')
  const engineOptions = readManagedEngineOptions(catalogEntry)

  const [insertedProject] = await db
    .insert(project)
    .values(
      projectKind === 'managed-postgres'
        ? {
          displayName: 'Managed Postgres Project',
          workspaceId,
          metadata: { type: 'managed', code: 'postgres' },
          options: {
            compose: catalogEntry.compose,
            ...(engineOptions ?? {}),
          },
        }
        : {
          displayName: 'Compose Project',
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
      displayName: 'production',
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
      userId,
      organizationId,
      workspaceId,
      projectId,
      environmentId,
      serverId,
    })
  } finally {
    await db.delete(managed).where(eq(managed.environmentId, environmentId))
    await db.delete(principal).where(eq(principal.projectId, projectId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    if (foreignOrgId) {
      await db.delete(organization).where(eq(organization.id, foreignOrgId))
    }
  }
}

test('POST /environments/:id/managed/provision is forbidden without manage grant', async () => {
  await withManagedFixtures({ withManageGrant: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/managed/provision`, {
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

test('POST /environments/:id/managed/provision requires placement pin', async () => {
  await withManagedFixtures({ withPlacement: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/managed/provision`, {
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

test('POST /environments/:id/managed/provision 404s when pinned server is foreign', async () => {
  await withManagedFixtures({ foreignServer: true }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/managed/provision`, {
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

test('POST /environments/:id/managed/provision rejects docker-compose projects', async () => {
  await withManagedFixtures({ projectKind: 'docker-compose' }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/environments/${environmentId}/managed/provision`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    assertEquals(res.status, 400)
    assertEquals(await res.json(), { error: 'not_managed_environment' })
  })
})

test('managed provision happy path is idempotent and GET reflects state', async () => {
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

    const before = await app.request(`/environments/${environmentId}/managed`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(before.status, 200)
    assertEquals(await before.json(), { managed: null })

    const first = await app.request(`/environments/${environmentId}/managed/provision`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(first.status, 200)
    const firstBody = await first.json() as {
      ok: boolean
      alreadyProvisioned?: boolean
      managed: {
        id: string
        environmentId: string
        engine: string
        status: string
        port: number
        serverId: string
        host: string
      }
    }
    assertEquals(firstBody.ok, true)
    assertEquals(firstBody.alreadyProvisioned, undefined)
    assertEquals(firstBody.managed.environmentId, environmentId)
    assertEquals(firstBody.managed.engine, 'postgres')
    assertEquals(firstBody.managed.status, 'ready')
    assertEquals(firstBody.managed.port, 5432)
    assertEquals(firstBody.managed.serverId, serverId)
    assertEquals(firstBody.managed.host, '127.0.0.1')

    const responseText = JSON.stringify(firstBody)
    assertEquals(responseText.includes('tpsecret.'), false)

    const principals = await db
      .select({ id: principal.id, password: principal.password })
      .from(principal)
      .where(eq(principal.projectId, projectId))
    assertEquals(principals.length, 1)
    assertEquals(principals[0]!.password?.startsWith('tpsecret.'), true)

    const second = await app.request(`/environments/${environmentId}/managed/provision`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    assertEquals(second.status, 200)
    const secondBody = await second.json() as {
      ok: boolean
      alreadyProvisioned?: boolean
      managed: { id: string }
    }
    assertEquals(secondBody.ok, true)
    assertEquals(secondBody.alreadyProvisioned, true)
    assertEquals(secondBody.managed.id, firstBody.managed.id)

    const principalsAfter = await db
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.projectId, projectId))
    assertEquals(principalsAfter.length, 1)

    const after = await app.request(`/environments/${environmentId}/managed`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    assertEquals(after.status, 200)
    const afterBody = await after.json() as { managed: { id: string } | null }
    assertEquals(afterBody.managed?.id, firstBody.managed.id)
  })
})
