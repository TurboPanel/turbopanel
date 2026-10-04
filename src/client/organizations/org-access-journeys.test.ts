/**
 * Organization access journeys against a real Postgres, through the real
 * client routes (checklist rows orgs-member-limits, orgs-workspaces,
 * orgs-remove-member, orgs-invite-existing, orgs-invite-cap). Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.ts'
import { assert, assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { createDenoDb } from '../../db/connection.ts'
import {
  account,
  audit,
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
    skipWithoutDatabase('org access journeys')
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
    await db.delete(audit).where(eq(audit.organizationId, organizationId))
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

const membersPath = (orgId: string, userId: string) => `/organizations/${orgId}/members/${userId}`

async function readsOrganization(fx: Fixture, who: Person, orgId = fx.organizationId) {
  const res = await fx.call(who, 'GET', `/organizations/${orgId}`, undefined, orgId)
  return res.status
}

async function listedOrganizationIds(fx: Fixture, who: Person): Promise<string[]> {
  const res = await fx.call(who, 'GET', '/organizations')
  const body = (await res.json()) as { organizations: { id: string }[] }
  return body.organizations.map((o) => o.id)
}

async function rowsFor(fx: Fixture, userId: string) {
  const [teams, grants] = await Promise.all([
    fx.db.select({ id: teammate.id }).from(teammate).where(eq(teammate.userId, userId)),
    fx.db.select({ id: grant.id }).from(grant).where(eq(grant.actorId, userId)),
  ])
  return { teams: teams.length, grants: grants.length }
}

test('removing a member deletes the membership and every grant, refuses their next read, and notifies', async () => {
  await withFixture(async (fx) => {
    const manager = await fx.addPerson('manager')
    const [ws] = await fx.db
      .insert(workspace)
      .values({ organizationId: fx.organizationId, name: 'Scoped' })
      .returning({ id: workspace.id })
    await fx.db.insert(grant).values({
      entityType: 'workspace',
      entityId: ws!.id,
      actorType: 'user',
      actorId: manager.userId,
      permission: 'workspace:manage',
    })
    assertEquals(await readsOrganization(fx, manager), 200)
    assert((await listedOrganizationIds(fx, manager)).includes(fx.organizationId))

    const res = await fx.call(fx.owner, 'DELETE', membersPath(fx.organizationId, manager.userId))
    assertEquals(res.status, 200, await res.clone().text())

    assertEquals(await rowsFor(fx, manager.userId), { teams: 0, grants: 0 })
    // The same signed-in session is refused straight away, and the app is gone from their list.
    assertEquals(await readsOrganization(fx, manager), 404)
    assert(!(await listedOrganizationIds(fx, manager)).includes(fx.organizationId))
    assertEquals(
      (
        await fx.call(manager, 'PUT', `/organizations/${fx.organizationId}/default-timezone`, {
          timezone: 'UTC',
        })
      ).status,
      403
    )
    assertEquals(await readsOrganization(fx, fx.owner), 200, 'the owner keeps access')

    const [note] = await fx.db
      .select({ event: notification.event })
      .from(notification)
      .where(
        and(
          eq(notification.organizationId, fx.organizationId),
          eq(notification.event, 'access.grant_revoked')
        )
      )
    assert(note, 'removal raises the existing access.grant_revoked notification')
    const [auditRow] = await fx.db
      .select({ action: audit.action, targetId: audit.targetId })
      .from(audit)
      .where(and(eq(audit.organizationId, fx.organizationId), eq(audit.action, 'member.remove')))
    assertEquals(auditRow?.targetId, fx.organizationId)
  })
})

test('a manager can remove a plain member but is refused removing an owner', async () => {
  await withFixture(async (fx) => {
    const manager = await fx.addPerson('manager')
    const member = await fx.addPerson('member')
    const secondOwner = await fx.addPerson('owner')

    const refused = await fx.call(
      manager,
      'DELETE',
      membersPath(fx.organizationId, secondOwner.userId)
    )
    assertEquals(refused.status, 403)
    assertEquals((await rowsFor(fx, secondOwner.userId)).grants, 1, 'the owner is untouched')

    const removed = await fx.call(manager, 'DELETE', membersPath(fx.organizationId, member.userId))
    assertEquals(removed.status, 200)
    assertEquals(await readsOrganization(fx, member), 404)
  })
})

test('a plain member cannot remove anyone, an outsider and a bad id get 404, an anonymous caller 401', async () => {
  await withFixture(async (fx) => {
    const member = await fx.addPerson('member')
    const other = await fx.addPerson('member')
    const outsider = await fx.addPerson('outsider')

    const byMember = await fx.call(member, 'DELETE', membersPath(fx.organizationId, other.userId))
    assertEquals(byMember.status, 403)
    assertEquals(await readsOrganization(fx, other), 200)

    const byOutsider = await fx.call(
      outsider,
      'DELETE',
      membersPath(fx.organizationId, other.userId)
    )
    assertEquals(byOutsider.status, 404)
    assertEquals(await readsOrganization(fx, other), 200)

    const notAMember = await fx.call(
      fx.owner,
      'DELETE',
      membersPath(fx.organizationId, outsider.userId)
    )
    assertEquals(notAMember.status, 404)
    assertEquals(
      (await fx.call(fx.owner, 'DELETE', `/organizations/${fx.organizationId}/members/not-a-uuid`))
        .status,
      404
    )

    const anonymous = await fx.app.request(
      `${CLIENT_API_PREFIX}${membersPath(fx.organizationId, other.userId)}`,
      { method: 'DELETE', headers: { origin: 'http://localhost' } }
    )
    assertEquals(anonymous.status, 401)
  })
})

test('the last owner cannot be removed or leave; with a second owner the first can', async () => {
  await withFixture(async (fx) => {
    const byOwner = await fx.call(
      fx.owner,
      'DELETE',
      membersPath(fx.organizationId, fx.owner.userId)
    )
    assertEquals(byOwner.status, 409)
    assertEquals(await byOwner.json(), { error: 'Cannot remove the last owner of an organization' })
    assertEquals(await readsOrganization(fx, fx.owner), 200)

    const second = await fx.addPerson('owner')
    const removed = await fx.call(second, 'DELETE', membersPath(fx.organizationId, fx.owner.userId))
    assertEquals(removed.status, 200)
    assertEquals(await readsOrganization(fx, fx.owner), 404)

    const lastOne = await fx.call(second, 'DELETE', membersPath(fx.organizationId, second.userId))
    assertEquals(lastOne.status, 409)
    assertEquals(await readsOrganization(fx, second), 200)
  })
})

test('a person can leave an organization themselves', async () => {
  await withFixture(async (fx) => {
    const member = await fx.addPerson('member')
    const manager = await fx.addPerson('manager')
    for (const who of [member, manager]) {
      const res = await fx.call(who, 'DELETE', membersPath(fx.organizationId, who.userId))
      assertEquals(res.status, 200, await res.clone().text())
      assertEquals(await readsOrganization(fx, who), 404)
      assert(!(await listedOrganizationIds(fx, who)).includes(fx.organizationId))
    }
  })
})

test('removal is scoped to one organization: another organization keeps the person and its owner cannot reach them', async () => {
  await withFixture(async (fx) => {
    const shared = await fx.addPerson('member')
    const { organizationId: otherOrg, teamId: otherTeam } = await createOrganizationForUser(
      fx.db,
      shared.userId,
      'Elsewhere'
    )
    try {
      // Owner of the first organization cannot remove from, or even see, the other one.
      const cross = await fx.call(
        fx.owner,
        'DELETE',
        membersPath(otherOrg, shared.userId),
        undefined,
        otherOrg
      )
      assertEquals(cross.status, 404)

      const removed = await fx.call(
        fx.owner,
        'DELETE',
        membersPath(fx.organizationId, shared.userId)
      )
      assertEquals(removed.status, 200)
      assertEquals(await readsOrganization(fx, shared), 404)
      assertEquals(
        await readsOrganization(fx, shared, otherOrg),
        200,
        'their own organization is untouched'
      )
      const remaining = await fx.db
        .select({ id: grant.id })
        .from(grant)
        .where(and(eq(grant.actorId, shared.userId), eq(grant.entityId, otherOrg)))
      assertEquals(remaining.length, 1)
    } finally {
      await fx.db.delete(grant).where(eq(grant.entityId, otherOrg))
      await fx.db.delete(teammate).where(eq(teammate.teamId, otherTeam))
      await fx.db.delete(team).where(eq(team.organizationId, otherOrg))
      await fx.db.delete(organization).where(eq(organization.id, otherOrg))
    }
  })
})

test('a removed person can be invited again and accept', async () => {
  await withFixture(async (fx) => {
    const member = await fx.addPerson('manager')
    const [oldInvite] = await fx.db
      .insert(invitation)
      .values({
        userId: fx.owner.userId,
        teamId: fx.teamId,
        email: member.email,
        status: 'accepted',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .returning({ id: invitation.id })
    assertEquals(
      (await fx.call(fx.owner, 'DELETE', membersPath(fx.organizationId, member.userId))).status,
      200
    )

    const stale = await fx.call(member, 'POST', `/invitations/${oldInvite!.id}/accept`)
    assertEquals(stale.status, 410, 'an old accepted invitation does not quietly restore access')
    assertEquals(await readsOrganization(fx, member), 404)

    const created = await fx.call(fx.owner, 'POST', '/invitations', {
      teamId: fx.teamId,
      email: member.email,
    })
    assertEquals(created.status, 200, await created.clone().text())
    const invitationId = ((await created.json()) as { id: string }).id
    assertEquals((await fx.call(member, 'POST', `/invitations/${invitationId}/accept`)).status, 200)
    assertEquals(await readsOrganization(fx, member), 200)
  })
})

type ListedMember = {
  id: string
  name: string | null
  email: string
  role: string
  joinedAt: string
}

async function listMembers(fx: Fixture, who: Person, orgId = fx.organizationId) {
  const res = await fx.call(who, 'GET', `/organizations/${orgId}/members`, undefined, orgId)
  if (res.status !== 200) {
    await res.body?.cancel()
    return { status: res.status, members: [] as ListedMember[], text: '' }
  }
  const text = await res.clone().text()
  const body = (await res.json()) as { members: ListedMember[] }
  return { status: res.status, members: body.members, text }
}

test('the member list shows each person once with their role and date, owners first, and no secrets', async () => {
  await withFixture(async (fx) => {
    const manager = await fx.addPerson('manager')
    const member = await fx.addPerson('member')
    const listed = await listMembers(fx, fx.owner)
    assertEquals(listed.status, 200)
    assertEquals(listed.members.length, 3)
    assertEquals(
      listed.members.map((m) => m.role),
      ['owner', 'manager', 'member']
    )
    const byId = new Map(listed.members.map((m) => [m.id, m]))
    assertEquals(byId.get(fx.owner.userId)?.email, fx.owner.email)
    assertEquals(byId.get(manager.userId)?.email, manager.email)
    assertEquals(byId.get(member.userId)?.role, 'member')
    for (const m of listed.members) {
      assertEquals(Object.keys(m).toSorted(), ['email', 'id', 'joinedAt', 'name', 'role'])
      assert(!Number.isNaN(Date.parse(m.joinedAt)))
    }
    assert(!/password|token|secret|hash/i.test(listed.text))
    const asManager = await listMembers(fx, manager)
    assertEquals(asManager.status, 200)
  })
})

test('the member list is refused to plain members, hidden from outsiders, and needs a session', async () => {
  await withFixture(async (fx) => {
    const member = await fx.addPerson('member')
    const outsider = await fx.addPerson('outsider')
    assertEquals((await listMembers(fx, member)).status, 403)
    assertEquals((await listMembers(fx, outsider)).status, 404)
    const anon = await fx.app.request(
      `${CLIENT_API_PREFIX}/organizations/${fx.organizationId}/members`,
      { headers: { origin: 'http://localhost' } }
    )
    assertEquals(anon.status, 401)
    await anon.body?.cancel()
    const bad = await fx.call(fx.owner, 'GET', '/organizations/not-a-uuid/members')
    assertEquals(bad.status, 404)
    await bad.body?.cancel()
  })
})

test('the member list never leaks across organizations and drops a person once removed', async () => {
  await withFixture(async (fx) => {
    const member = await fx.addPerson('member')
    await withFixture(async (other) => {
      const theirs = await listMembers(other, other.owner)
      assertEquals(theirs.members.length, 1)
      assert(!theirs.members.some((m) => m.id === member.userId))
      assertEquals((await listMembers(fx, other.owner, fx.organizationId)).status, 404)
      assertEquals((await listMembers(other, fx.owner, other.organizationId)).status, 404)
    })
    const removed = await fx.call(fx.owner, 'DELETE', membersPath(fx.organizationId, member.userId))
    assertEquals(removed.status, 200)
    await removed.body?.cancel()
    const after = await listMembers(fx, fx.owner)
    assertEquals(after.members.length, 1)
    assertEquals(after.members[0]?.id, fx.owner.userId)
  })
})
