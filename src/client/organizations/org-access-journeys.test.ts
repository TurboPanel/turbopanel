/**
 * Organization access journeys against a real Postgres, through the real
 * client routes (checklist rows orgs-member-limits, orgs-workspaces,
 * orgs-remove-member, orgs-invite-existing, orgs-invite-cap). Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { assert, assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { createDenoDb } from '../../db/connection.ts'
import {
  account,
  grant,
  invitation,
  notification,
  organization,
  project,
  server,
  session,
  team,
  teammate,
  user,
  workspace,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { createAuthRateLimiter } from '../authn/auth-rate-limit.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createOrganizationForUser } from '../authn/install-state.ts'
import { createSession } from '../authn/session-store.ts'
import { can } from '../authz/index.ts'
import { registerBillingRoutes } from '../billing/routes.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerClientRoutes } from '../routes.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep the alias so analysis sees these suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>
type Role = 'owner' | 'manager' | 'member'

type Person = { userId: string; email: string; cookie: string }

type Fixture = {
  app: Hono<AppEnv>
  db: Db
  organizationId: string
  teamId: string
  serverId: string
  owner: Person
  addPerson: (role: Role | 'outsider') => Promise<Person>
  call: (
    who: Person,
    method: string,
    path: string,
    body?: unknown,
    organizationId?: string
  ) => Promise<Response>
}

const ROLE_GRANT: Record<Role, string | null> = {
  owner: 'organization:own',
  manager: 'organization:manage',
  member: null,
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping org access journeys: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const config = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(config, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(config, 'data-encryption')
  const limiter = createAuthRateLimiter({ defaultPolicy: { limit: 10_000, windowMs: 60_000 } })
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', config)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    c.set('authRateLimiter', limiter)
    c.set('emailQueue', { enqueue: () => Promise.resolve() })
    c.set('platformEnv', { TURBOPANEL_BASE_URL: 'https://panel.example.com' })
    return next()
  })
  registerClientRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
    registerBilling: (client, opts) => registerBillingRoutes(client, opts),
  })

  const userIds: string[] = []
  const cookieFor = async (userId: string): Promise<string> => {
    const { token } = await createSession(db, userId, {})
    return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  }
  const newUser = async (label: string): Promise<{ userId: string; email: string }> => {
    const email = `${label}-${crypto.randomUUID()}@example.com`
    const [row] = await db
      .insert(user)
      .values({ email, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })
    userIds.push(row!.id)
    return { userId: row!.id, email }
  }

  const ownerUser = await newUser('owner')
  const { organizationId, teamId } = await createOrganizationForUser(
    db,
    ownerUser.userId,
    'Journey'
  )
  const [serverRow] = await db
    .insert(server)
    .values({ organizationId, name: `journey-${crypto.randomUUID().slice(0, 8)}` })
    .returning({ id: server.id })
  const owner: Person = { ...ownerUser, cookie: await cookieFor(ownerUser.userId) }

  const addPerson: Fixture['addPerson'] = async (role) => {
    const created = await newUser(role)
    if (role === 'outsider') return { ...created, cookie: await cookieFor(created.userId) }
    await db.insert(teammate).values({ teamId, userId: created.userId })
    const permission = ROLE_GRANT[role]
    if (permission) {
      await db.insert(grant).values({
        entityType: 'organization',
        entityId: organizationId,
        actorType: 'user',
        actorId: created.userId,
        permission,
      })
    }
    return { ...created, cookie: await cookieFor(created.userId) }
  }

  const call: Fixture['call'] = (who, method, path, body, org = organizationId) =>
    Promise.resolve(
      app.request(`${CLIENT_API_PREFIX}${path}`, {
        method,
        headers: {
          cookie: who.cookie,
          origin: 'http://localhost',
          'content-type': 'application/json',
          [ORG_ID_HEADER]: org,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    )

  try {
    await fn({ app, db, organizationId, teamId, serverId: serverRow!.id, owner, addPerson, call })
  } finally {
    await db.delete(notification).where(eq(notification.organizationId, organizationId))
    await db.delete(invitation).where(eq(invitation.teamId, teamId))
    await db.delete(project).where(eq(project.organizationId, organizationId))
    await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(grant).where(inArray(grant.actorId, userIds))
    await db.delete(grant).where(eq(grant.entityId, organizationId))
    await db.delete(teammate).where(inArray(teammate.userId, userIds))
    await db.delete(session).where(inArray(session.userId, userIds))
    await db.delete(account).where(inArray(account.userId, userIds))
    await db.delete(team).where(eq(team.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await db.delete(user).where(inArray(user.id, userIds))
  }
}

/** One owner-gated or manager-gated action a plain member must never complete. */
type Action = { label: string; method: string; path: (fx: Fixture) => string; body?: unknown }

const OWNER_ONLY: Action[] = [
  { label: 'add a server license', method: 'POST', path: () => '/licenses', body: { name: 'x' } },
  { label: 'start billing checkout', method: 'POST', path: () => '/billing/checkout', body: {} },
  {
    label: 'open host-level compose features',
    method: 'PUT',
    path: (fx) => `/organizations/${fx.organizationId}/compose-privileged-fields`,
    body: { enabled: true },
  },
]

const MANAGER_AND_UP: Action[] = [
  { label: 'start a fleet update', method: 'POST', path: () => '/servers/updates', body: {} },
  {
    label: 'rename a server',
    method: 'PATCH',
    path: (fx) => `/servers/${fx.serverId}`,
    body: { name: 'renamed-by-member' },
  },
  { label: 'delete a server', method: 'DELETE', path: (fx) => `/servers/${fx.serverId}` },
]

async function statusesFor(fx: Fixture, who: Person, actions: Action[]): Promise<number[]> {
  const responses = await Promise.all(
    actions.map((action) => fx.call(who, action.method, action.path(fx), action.body))
  )
  return responses.map((res) => res.status)
}

test('a plain member is refused server management, billing, fleet updates and host-level compose', async () => {
  await withFixture(async (fx) => {
    const member = await fx.addPerson('member')
    const everything = [...OWNER_ONLY, ...MANAGER_AND_UP]
    const statuses = await statusesFor(fx, member, everything)
    everything.forEach((action, index) => {
      assertEquals(statuses[index], 403, `member must get 403 to: ${action.label}`)
    })

    const [row] = await fx.db
      .select({ name: server.name })
      .from(server)
      .where(eq(server.id, fx.serverId))
    assert(row, 'the refused delete must not have removed the server')
    assert(row.name !== 'renamed-by-member', 'the refused rename must not have changed the server')
  })
})

test('a manager is refused the owner-only actions, and an owner is not', async () => {
  await withFixture(async (fx) => {
    const manager = await fx.addPerson('manager')
    const managerStatuses = await statusesFor(fx, manager, OWNER_ONLY)
    OWNER_ONLY.forEach((action, index) => {
      assertEquals(managerStatuses[index], 403, `manager must get 403 to: ${action.label}`)
    })

    const ownerStatuses = await statusesFor(fx, fx.owner, OWNER_ONLY)
    OWNER_ONLY.forEach((action, index) => {
      assert(ownerStatuses[index] !== 403, `owner must pass the guard for: ${action.label}`)
    })
  })
})

test('workspaces: create, rename, delete when empty; a non-empty workspace is refused and keeps its project', async () => {
  await withFixture(async (fx) => {
    const created = await fx.call(fx.owner, 'POST', '/workspaces', { name: 'Journey Space' })
    assertEquals(created.status, 200, await created.clone().text())
    const { id } = (await created.json()) as { id: string }

    const renamed = await fx.call(fx.owner, 'PATCH', `/workspaces/${id}`, { name: 'Renamed Space' })
    assertEquals(renamed.status, 200)
    const named = await fx.db
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, id))
    assertEquals(named[0]?.name, 'Renamed Space')

    const [inserted] = await fx.db
      .insert(project)
      .values({ workspaceId: id, organizationId: fx.organizationId, name: 'kept-project' })
      .returning({ id: project.id })
    const blocked = await fx.call(fx.owner, 'DELETE', `/workspaces/${id}`)
    assertEquals(blocked.status, 409)
    const stillThere = await fx.db
      .select({ id: project.id })
      .from(project)
      .where(eq(project.id, inserted!.id))
    assertEquals(stillThere.length, 1, 'refusing the delete must keep the project grouped')

    await fx.db.delete(project).where(eq(project.id, inserted!.id))
    const emptied = await fx.call(fx.owner, 'DELETE', `/workspaces/${id}`)
    assertEquals(emptied.status, 200)
    const gone = await fx.db
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.id, id))
    assertEquals(gone.length, 0)
  })
})

test('revoking a grant refuses the former manager at once and records the access.grant_revoked notification', async () => {
  await withFixture(async (fx) => {
    const manager = await fx.addPerson('manager')
    const [grantRow] = await fx.db
      .select({ id: grant.id })
      .from(grant)
      .where(
        and(
          eq(grant.actorId, manager.userId),
          eq(grant.entityId, fx.organizationId),
          eq(grant.permission, 'organization:manage')
        )
      )
    assertEquals(
      (
        await fx.call(manager, 'PUT', `/organizations/${fx.organizationId}/default-timezone`, {
          timezone: 'UTC',
        })
      ).status !== 403,
      true,
      'a manager can use a manage-level route before the revoke'
    )

    const revoked = await fx.call(fx.owner, 'DELETE', `/access/${grantRow!.id}`)
    assertEquals(revoked.status, 200)

    const after = await fx.call(
      manager,
      'PUT',
      `/organizations/${fx.organizationId}/default-timezone`,
      {
        timezone: 'UTC',
      }
    )
    assertEquals(after.status, 403, 'the same session is refused immediately after the revoke')
    assert(
      !(await can(fx.db, manager.userId, 'organization:manage', 'organization', fx.organizationId))
    )

    const notes = await fx.db
      .select({ event: notification.event })
      .from(notification)
      .where(
        and(
          eq(notification.organizationId, fx.organizationId),
          eq(notification.event, 'access.grant_revoked')
        )
      )
    assert(notes.length >= 1, 'a revoke must raise an access.grant_revoked notification')
  })
})

test('an expired invitation is refused with a plain 410 and adds nobody to the team', async () => {
  await withFixture(async (fx) => {
    const invitee = await fx.addPerson('outsider')
    const [row] = await fx.db
      .insert(invitation)
      .values({
        userId: fx.owner.userId,
        teamId: fx.teamId,
        email: invitee.email,
        status: 'pending',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .returning({ id: invitation.id })

    const res = await fx.call(invitee, 'POST', `/invitations/${row!.id}/accept`)
    assertEquals(res.status, 410)
    assertEquals(await res.json(), { error: 'Invitation expired or already used' })
    const members = await fx.db
      .select({ id: teammate.id })
      .from(teammate)
      .where(and(eq(teammate.teamId, fx.teamId), eq(teammate.userId, invitee.userId)))
    assertEquals(members.length, 0)
  })
})

test('an invited existing account joins with the granted permission and no second account is created', async () => {
  await withFixture(async (fx) => {
    const invitee = await fx.addPerson('outsider')
    const created = await fx.call(fx.owner, 'POST', '/invitations', {
      teamId: fx.teamId,
      email: invitee.email,
      grants: [
        {
          entityType: 'organization',
          entityId: fx.organizationId,
          permissionKey: 'organization:manage',
        },
      ],
    })
    assertEquals(created.status, 200, await created.clone().text())
    const invitationId = ((await created.json()) as { id: string }).id

    const accepted = await fx.call(invitee, 'POST', `/invitations/${invitationId}/accept`)
    assertEquals(accepted.status, 200)
    assertEquals(
      ((await accepted.json()) as { organizationId: string }).organizationId,
      fx.organizationId
    )

    const accounts = await fx.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, invitee.email))
    assertEquals(accounts.length, 1, 'accepting must reuse the existing account')
    const members = await fx.db
      .select({ id: teammate.id })
      .from(teammate)
      .where(and(eq(teammate.teamId, fx.teamId), eq(teammate.userId, invitee.userId)))
    assertEquals(members.length, 1)
    assert(
      await can(fx.db, invitee.userId, 'organization:manage', 'organization', fx.organizationId),
      'the invited permission is in force after accepting'
    )
  })
})
