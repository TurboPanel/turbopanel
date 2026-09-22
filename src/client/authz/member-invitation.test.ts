import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import {
  grant,
  invitation,
  organization,
  team,
  workspace,
  user,
} from '../../db/schema.ts'
import type { EmailQueue } from '../../features/email/types.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { createSession } from '../authn/session-store.ts'
import { registerAccessRoutes } from '../access/routes.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import {
  defaultInvitationGrants,
  InvitationGrantValidationError,
  materializeInvitationGrants,
} from '../authn/invitation-grants.ts'
import { canManageOrganization } from './service.ts'

const dbUrl = getDatabaseUrl()

async function withTestFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    userId: string
    organizationId: string
    workspaceId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping authz tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()

  const email = `member-test-${crypto.randomUUID()}@example.com`

  const insertedOrg = await db
    .insert(organization)
    .values({ name: 'Member Test Org' })
    .returning({ id: organization.id })

  const organizationId = insertedOrg[0]!.id

  const insertedUser = await db
    .insert(user)
    .values({ email, isEmailVerified: true })
    .returning({ id: user.id })

  const userId = insertedUser[0]!.id


  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ name: 'Test Workspace', organizationId })
    .returning({ id: workspace.id })

  const workspaceId = insertedWorkspace!.id

  try {
    await fn({
      db,
      userId,
      organizationId,
      workspaceId,
    })
  } finally {
    await db.delete(grant).where(eq(grant.actorId, userId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
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

test('default invited member gets organization:manage grant', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const grants = defaultInvitationGrants(organizationId)
    await materializeInvitationGrants(db, userId, grants, organizationId)

    const rows = await db
      .select({ permission: grant.permission })
      .from(grant)
      .where(
        and(
          eq(grant.actorId, userId),
          eq(grant.entityType, 'organization'),
          eq(grant.entityId, organizationId),
        ),
      )

    if (rows.length !== 1) {
      throw new Error(`expected one grant row, got ${rows.length}`)
    }
    if (rows[0]!.permission !== 'organization:manage') {
      throw new Error(`expected organization:manage, got ${rows[0]!.permission}`)
    }
  })
})

test('organization:manage grant allows canManageOrganization', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const grants = defaultInvitationGrants(organizationId)
    await materializeInvitationGrants(db, userId, grants, organizationId)

    const managesOrg = await canManageOrganization(db, userId, organizationId)
    if (!managesOrg) {
      throw new Error('organization:manage grant should allow canManageOrganization')
    }
  })
})

test('invitation grant materialization is idempotent', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const grants = defaultInvitationGrants(organizationId)

    await materializeInvitationGrants(db, userId, grants, organizationId)
    await materializeInvitationGrants(db, userId, grants, organizationId)

    const rows = await db
      .select({ id: grant.id })
      .from(grant)
      .where(
        and(
          eq(grant.actorId, userId),
          eq(grant.entityType, 'organization'),
          eq(grant.entityId, organizationId),
        ),
      )

    if (rows.length !== 1) {
      throw new Error(`expected exactly one grant row after idempotent materialization, got ${rows.length}`)
    }
  })
})

test('invitation grant rejects nonexistent entity id', async () => {
  await withTestFixtures(async ({ db, userId, organizationId }) => {
    const missingEntityId = crypto.randomUUID()

    try {
      await materializeInvitationGrants(
        db,
        userId,
        [
          {
            entityType: 'workspace',
            entityId: missingEntityId,
            permissionKey: 'organization:manage',
          },
        ],
        organizationId,
      )
      throw new Error('expected InvitationGrantValidationError')
    } catch (err) {
      if (!(err instanceof InvitationGrantValidationError)) {
        throw err
      }
      if (err.message !== 'Entity not found') {
        throw new Error(`expected Entity not found, got ${err.message}`)
      }
    }
  })
})

test('invitation grant rejects incompatible permission on existing workspace entity', async () => {
  await withTestFixtures(async ({ db, userId, organizationId, workspaceId }) => {
    try {
      await materializeInvitationGrants(
        db,
        userId,
        [
          {
            entityType: 'workspace',
            entityId: workspaceId,
            permissionKey: 'organization:manage',
          },
        ],
        organizationId,
      )
      throw new Error('expected InvitationGrantValidationError')
    } catch (err) {
      if (!(err instanceof InvitationGrantValidationError)) {
        throw err
      }
      if (
        err.message !==
        'organization:manage may only be granted on organization entities'
      ) {
        throw new Error(`expected permission compatibility rejection, got ${err.message}`)
      }
      if (err.status !== 400) {
        throw new Error(`expected status 400, got ${err.status}`)
      }
    }
  })
})

test('invitation grant rejects cross-organization entity target', async () => {
  await withTestFixtures(async ({ db, userId, workspaceId }) => {
    const otherOrg = await db
      .insert(organization)
      .values({ name: 'Other Org' })
      .returning({ id: organization.id })

    const otherOrganizationId = otherOrg[0]!.id

    try {
      try {
        await materializeInvitationGrants(
          db,
          userId,
          [
            {
              entityType: 'workspace',
              entityId: workspaceId,
              permissionKey: 'organization:manage',
            },
          ],
          otherOrganizationId,
        )
        throw new Error('expected InvitationGrantValidationError')
      } catch (err) {
        if (!(err instanceof InvitationGrantValidationError)) {
          throw err
        }
        if (err.message !== 'Entity must belong to the invitation organization') {
          throw new Error(`expected cross-org rejection, got ${err.message}`)
        }
      }
    } finally {
      await db.delete(organization).where(eq(organization.id, otherOrganizationId))
    }
  })
})

async function withInvitationHttpFixtures(
  permission: 'organization:own' | 'organization:manage',
  fn: (ctx: {
    app: Hono<AppEnv>
    cookie: string
    organizationId: string
    teamId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping authz tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(
    parseTestSecretsConfig('deno'),
    'session-signing',
  )
  const queue: EmailQueue = {
    enqueue: () => Promise.resolve(),
  }
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('emailQueue', queue)
    return next()
  })
  registerAccessRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const [orgRow] = await db
    .insert(organization)
    .values({ name: 'Invite Escalation Org' })
    .returning({ id: organization.id })
  const organizationId = orgRow!.id
  const [userRow] = await db
    .insert(user)
    .values({
      email: `invite-escalation-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = userRow!.id
  const [teamRow] = await db
    .insert(team)
    .values({ name: 'Invite Team', organizationId })
    .returning({ id: team.id })
  const teamId = teamRow!.id

  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission,
  })

  const { token } = await createSession(db, userId, {})
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`

  try {
    await fn({ app, cookie, organizationId, teamId })
  } finally {
    await db.delete(invitation).where(eq(invitation.teamId, teamId))
    await db.delete(grant).where(eq(grant.actorId, userId))
    await db.delete(team).where(eq(team.id, teamId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('manager passing grants gets 403 grants_require_owner', async () => {
  await withInvitationHttpFixtures('organization:manage', async ({
    app,
    cookie,
    organizationId,
    teamId,
  }) => {
    const res = await app.request('/invitations', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        teamId,
        email: `mgr-${crypto.randomUUID()}@example.com`,
        grants: [
          {
            entityType: 'organization',
            entityId: organizationId,
            permissionKey: 'organization:own',
          },
        ],
      }),
    })
    if (res.status !== 403) {
      throw new TypeError(`expected 403 grants_require_owner, got ${res.status}`)
    }
    const body = await res.json() as { error: string }
    if (body.error !== 'grants_require_owner') {
      throw new TypeError(`expected grants_require_owner, got ${body.error}`)
    }
  })
})

test('owner passing grants succeeds', async () => {
  await withInvitationHttpFixtures('organization:own', async ({
    app,
    cookie,
    organizationId,
    teamId,
  }) => {
    const res = await app.request('/invitations', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        teamId,
        email: `owner-${crypto.randomUUID()}@example.com`,
        grants: [
          {
            entityType: 'organization',
            entityId: organizationId,
            permissionKey: 'organization:manage',
          },
        ],
      }),
    })
    if (res.status !== 200) {
      throw new TypeError(`expected 200 creating owner invitation, got ${res.status}`)
    }
    const body = await res.json() as { ok: boolean; id: string }
    if (!body.ok || !body.id) {
      throw new TypeError('owner invitation response missing id')
    }
  })
})
