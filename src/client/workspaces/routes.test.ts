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
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../authn/secrets.ts'
import {
  grant,
  member,
  organization,
  user,
  workspace,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerWorkspaceRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createWorkspaceRoutesTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerWorkspaceRoutes(app, { secrets, runtime: 'deno' })
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

async function withWorkspaceFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping workspace route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createWorkspaceRoutesTestApp(db)

  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Workspace Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({
      email: `workspace-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
    allow: true,
  })

  try {
    await fn({ db, app, secrets, userId, organizationId })
  } finally {
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
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
  }
}

test('POST /workspaces rejects duplicate display names case-insensitively', async () => {
  await withWorkspaceFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const first = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Team Space' }),
    })
    assertEquals(first.status, 200)

    const duplicate = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: '  team space  ' }),
    })
    assertEquals(duplicate.status, 409)
    assertEquals(await duplicate.json(), { error: 'workspace_name_in_use' })
  })
})

test('PATCH /workspaces/:id rejects renaming onto another workspace name', async () => {
  await withWorkspaceFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const createA = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Workspace A' }),
    })
    assertEquals(createA.status, 200)

    const createB = await app.request('/workspaces', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Workspace B' }),
    })
    assertEquals(createB.status, 200)
    const { id: workspaceBId } = await createB.json() as { id: string }

    const rename = await app.request(`/workspaces/${workspaceBId}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'workspace a' }),
    })
    assertEquals(rename.status, 409)
    assertEquals(await rename.json(), { error: 'workspace_name_in_use' })
  })
})
