import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { STEP_UP_WINDOW_MS } from '../authn/step-up.ts'
import { pinRootOrganizationForTest } from '../../test-fixtures/root-organization.test.support.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import {
  audit,
  carrier,
  dnsRecord,
  grant,
  organization,
  server,
  session,
  team,
  teammate,
  tunnel,
  user,
  workspace,
} from '../../db/schema.ts'
import { deleteOrganizationIfClear } from '../../features/organizations/delete-organization.ts'
import { registerOrganizationRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/** Jest/Mocha-shaped alias for {@link Deno.test} (Sonar only recognizes `test()`). */
const test = Deno.test.bind(Deno)

type Db = ReturnType<typeof createDenoDb>
type Role = 'owner' | 'manager' | 'member' | 'stranger' | 'admin' | 'superadmin'

async function build(db: Db) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerOrganizationRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return { app, secrets }
}

/** One organization, one person per role, and a signed-in cookie for each. */
async function withScene(
  fn: (scene: {
    db: Db
    app: Hono<AppEnv>
    orgId: string
    orgName: string
    cookies: Record<Role, string>
    ageSession: (role: Role) => Promise<void>
    del: (role: Role, name?: string | null) => Response | Promise<Response>
  }) => Promise<void>,
  opts: { orgName?: string; scenePinnedAsRoot?: boolean } = {}
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('organization delete route tests')
    return
  }
  const db = createDenoDb()
  const { app, secrets } = await build(db)
  const orgName = opts.orgName ?? `Delete Route Org ${crypto.randomUUID()}`
  const [org] = await db.insert(organization).values({ name: orgName }).returning({
    id: organization.id,
  })
  const orgId = org!.id
  // The root is a pinned id, not a name: pin a stand-in so the scene is never the root,
  // unless the test is about the root itself.
  const [standIn] = opts.scenePinnedAsRoot
    ? []
    : await db
        .insert(organization)
        .values({ name: `Stand-in root ${crypto.randomUUID()}` })
        .returning({ id: organization.id })
  const restoreRoot = await pinRootOrganizationForTest(db, standIn?.id ?? orgId)
  const roles: Role[] = ['owner', 'manager', 'member', 'stranger', 'admin', 'superadmin']
  const userIds = {} as Record<Role, string>
  const cookies = {} as Record<Role, string>
  const tokens = {} as Record<Role, string>
  for (const role of roles) {
    const [u] = await db
      .insert(user)
      .values({
        email: `org-delete-${role}-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: role === 'admin' || role === 'superadmin' ? role : 'user',
      })
      .returning({ id: user.id })
    userIds[role] = u!.id
    const { token } = await createSession(db, u!.id, {})
    tokens[role] = token
    cookies[role] = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  }
  await db.insert(grant).values([
    {
      entityType: 'organization',
      entityId: orgId,
      actorType: 'user',
      actorId: userIds.owner,
      permission: 'organization:own',
    },
    {
      entityType: 'organization',
      entityId: orgId,
      actorType: 'user',
      actorId: userIds.manager,
      permission: 'organization:manage',
    },
  ])
  // A plain member is a real team member, with no grant on the organization.
  const [memberTeam] = await db
    .insert(team)
    .values({ organizationId: orgId, name: 'Members' })
    .returning({ id: team.id })
  await db.insert(teammate).values({ teamId: memberTeam!.id, userId: userIds.member })
  try {
    await fn({
      db,
      app,
      orgId,
      orgName,
      cookies,
      ageSession: async (role) => {
        await db
          .update(session)
          .set({ createdAt: new Date(Date.now() - 2 * STEP_UP_WINDOW_MS).toISOString() })
          .where(eq(session.token, tokens[role]))
      },
      del: (role, name) =>
        app.request(
          `/organizations/${orgId}${name === null ? '' : `?confirmName=${encodeURIComponent(name ?? orgName)}`}`,
          { method: 'DELETE', headers: { Cookie: cookies[role] } }
        ),
    })
  } finally {
    await db.delete(audit).where(eq(audit.targetId, orgId))
    await db.delete(organization).where(eq(organization.id, orgId))
    await restoreRoot()
    if (standIn) await db.delete(organization).where(eq(organization.id, standIn.id))
    await db.delete(user).where(inArray(user.id, Object.values(userIds)))
  }
}

async function orgExists(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, id))
  return rows.length === 1
}

test('the owner deletes the organization and the delete is audited without an organization id', async () => {
  await withScene(async ({ db, orgId, orgName, del }) => {
    const res = await del('owner')
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true, id: orgId })
    assertEquals(await orgExists(db, orgId), false)
    const rows = await db.select().from(audit).where(eq(audit.targetId, orgId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.action, 'organization.delete')
    assertEquals(rows[0]!.organizationId, null)
    assertEquals((rows[0]!.context as { name: string }).name, orgName)
  })
})

test('a platform admin and a superadmin may delete', async () => {
  for (const role of ['admin', 'superadmin'] as const) {
    await withScene(async ({ db, orgId, del }) => {
      const res = await del(role)
      assertEquals(res.status, 200)
      assertEquals(await orgExists(db, orgId), false)
    })
  }
})

test('a manager who is not the owner and a plain team member are refused with 403', async () => {
  await withScene(async ({ db, orgId, del }) => {
    for (const role of ['manager', 'member'] as const) {
      const res = await del(role)
      assertEquals(res.status, 403, role)
      assertEquals(await orgExists(db, orgId), true)
    }
  })
})

test('a stranger gets 404, as on GET, and nothing is deleted', async () => {
  await withScene(async ({ db, orgId, del }) => {
    const res = await del('stranger')
    assertEquals(res.status, 404)
    assertEquals(await orgExists(db, orgId), true)
  })
})

test('no session is 401 and an unknown organization is 404', async () => {
  await withScene(async ({ app, cookies }) => {
    const anon = await app.request(`/organizations/${crypto.randomUUID()}?confirmName=x`, {
      method: 'DELETE',
    })
    assertEquals(anon.status, 401)
    const missing = await app.request(`/organizations/${crypto.randomUUID()}?confirmName=x`, {
      method: 'DELETE',
      headers: { Cookie: cookies.owner },
    })
    assertEquals(missing.status, 404)
  })
})

test('a wrong or missing name is 400 confirm_name_required and nothing is deleted', async () => {
  await withScene(async ({ db, orgId, orgName, del }) => {
    for (const typed of ['wrong', orgName.toUpperCase(), null]) {
      const res = await del('owner', typed)
      assertEquals(res.status, 400)
      assertEquals(((await res.json()) as { error: string }).error, 'confirm_name_required')
    }
    assertEquals(await orgExists(db, orgId), true)
  })
})

test('step-up is always required: an old session gets 403 reauth_required', async () => {
  await withScene(async ({ db, orgId, ageSession, del }) => {
    await ageSession('owner')
    const res = await del('owner')
    assertEquals(res.status, 403)
    const body = (await res.json()) as { error: string; action: string }
    assertEquals(body.error, 'reauth_required')
    assertEquals(body.action, 'organization.delete')
    assertEquals(await orgExists(db, orgId), true)
  })
})

test('step-up applies to a platform admin too', async () => {
  await withScene(async ({ db, orgId, ageSession, del }) => {
    await ageSession('admin')
    assertEquals((await del('admin')).status, 403)
    assertEquals(await orgExists(db, orgId), true)
  })
})

test('a server blocks the delete with 409 organization_has_servers and stays in place', async () => {
  await withScene(async ({ db, orgId, del }) => {
    const now = new Date().toISOString()
    const [srv] = await db
      .insert(server)
      .values({
        organizationId: orgId,
        name: 'Blocking Server',
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
      })
      .returning({ id: server.id })
    for (const role of ['owner', 'admin'] as const) {
      const res = await del(role)
      assertEquals(res.status, 409)
      const body = (await res.json()) as { error: string; code: string; serverCount: number }
      assertEquals(body.error, 'organization_has_servers')
      assertEquals(body.code, 'organization_has_servers')
      assertEquals(body.serverCount, 1)
    }
    assertEquals(await orgExists(db, orgId), true)
    const [kept] = await db.select().from(server).where(eq(server.id, srv!.id))
    assertEquals(kept?.organizationId, orgId)
    // Once the server is gone the delete goes through.
    await db.delete(server).where(eq(server.id, srv!.id))
    assertEquals((await del('owner')).status, 200)
  })
})

test('a tunnel blocks the delete with 409 organization_has_tunnels', async () => {
  await withScene(async ({ db, orgId, del }) => {
    const [car] = await db
      .insert(carrier)
      .values({ organizationId: orgId, name: 'c', provider: 'cloudflare' })
      .returning({ id: carrier.id })
    await db.insert(tunnel).values({
      organizationId: orgId,
      routingOrganizationId: orgId,
      carrierId: car!.id,
      name: 't',
      provider: 'cloudflare',
    })
    const res = await del('owner')
    assertEquals(res.status, 409)
    assertEquals(((await res.json()) as { error: string }).error, 'organization_has_tunnels')
    assertEquals(await orgExists(db, orgId), true)
  })
})

test('a DNS record blocks the delete with 409 organization_has_dns_records', async () => {
  await withScene(async ({ db, orgId, del }) => {
    const [car] = await db
      .insert(carrier)
      .values({ organizationId: orgId, name: 'c', provider: 'cloudflare' })
      .returning({ id: carrier.id })
    await db.insert(dnsRecord).values({
      organizationId: orgId,
      carrierId: car!.id,
      name: 'app.example.net',
      kind: 'CNAME',
      provider: 'cloudflare',
      zoneId: 'zone-1',
      content: 'target.example.net',
    })
    const res = await del('owner')
    assertEquals(res.status, 409)
    assertEquals(((await res.json()) as { error: string }).error, 'organization_has_dns_records')
    assertEquals(await orgExists(db, orgId), true)
  })
})

test('the root organization is never deleted, not even by a platform admin', async () => {
  await withScene(
    async ({ db, orgId, del }) => {
      for (const role of ['owner', 'superadmin'] as const) {
        const res = await del(role)
        assertEquals(res.status, 409)
        assertEquals(((await res.json()) as { error: string }).error, 'root_organization')
      }
      assertEquals(await orgExists(db, orgId), true)
    },
    { scenePinnedAsRoot: true }
  )
})

test('renaming the root, or naming another organization Root Organization, does not move it', async () => {
  await withScene(
    async ({ db, orgId, cookies, app }) => {
      const renamed = `Renamed ${crypto.randomUUID()}`
      await db.update(organization).set({ name: renamed }).where(eq(organization.id, orgId))
      const [lookalike] = await db
        .insert(organization)
        .values({ name: 'Root Organization' })
        .returning({ id: organization.id })
      try {
        const res = await app.request(
          `/organizations/${orgId}?confirmName=${encodeURIComponent(renamed)}`,
          { method: 'DELETE', headers: { Cookie: cookies.superadmin } }
        )
        assertEquals(res.status, 409)
        assertEquals(((await res.json()) as { error: string }).error, 'root_organization')
        assertEquals(await orgExists(db, orgId), true)
        // The look-alike is an ordinary organization: it can be deleted.
        const other = await app.request(
          `/organizations/${lookalike!.id}?confirmName=${encodeURIComponent('Root Organization')}`,
          { method: 'DELETE', headers: { Cookie: cookies.superadmin } }
        )
        assertEquals(other.status, 200)
      } finally {
        await db.delete(organization).where(eq(organization.id, lookalike!.id))
      }
    },
    { scenePinnedAsRoot: true }
  )
})

test('a tunnel on one of its carriers blocks the delete, and so does a record on a carrier', async () => {
  await withScene(async ({ db, orgId, del }) => {
    const [other] = await db
      .insert(organization)
      .values({ name: `Other ${crypto.randomUUID()}` })
      .returning({ id: organization.id })
    try {
      const [car] = await db
        .insert(carrier)
        .values({ organizationId: orgId, name: 'c', provider: 'cloudflare' })
        .returning({ id: carrier.id })
      // Owned by another organization but riding this organization's carrier.
      await db.insert(tunnel).values({
        organizationId: other!.id,
        routingOrganizationId: other!.id,
        carrierId: car!.id,
        name: 't',
        provider: 'cloudflare',
      })
      let res = await del('owner')
      assertEquals(res.status, 409)
      assertEquals(((await res.json()) as { error: string }).error, 'organization_has_tunnels')
      await db.delete(tunnel).where(eq(tunnel.carrierId, car!.id))
      await db.insert(dnsRecord).values({
        organizationId: other!.id,
        carrierId: car!.id,
        name: 'app.example.net',
        kind: 'CNAME',
        provider: 'cloudflare',
        zoneId: 'zone-1',
        content: 'target.example.net',
      })
      res = await del('owner')
      assertEquals(res.status, 409)
      assertEquals(((await res.json()) as { error: string }).error, 'organization_has_dns_records')
      assertEquals(await orgExists(db, orgId), true)
    } finally {
      await db.delete(dnsRecord).where(eq(dnsRecord.organizationId, other!.id))
      await db.delete(organization).where(eq(organization.id, other!.id))
    }
  })
})

test('the guarded delete answers blocked, not a foreign key error, when a server appears first', async () => {
  await withScene(async ({ db, orgId }) => {
    const now = new Date().toISOString()
    await db.insert(server).values({
      organizationId: orgId,
      name: 'Late Server',
      createdAt: now,
      updatedAt: now,
      statusChangedAt: now,
    })
    const result = await deleteOrganizationIfClear(db, orgId, {
      organizationId: null,
      action: 'organization.delete',
      targetType: 'organization',
      targetId: orgId,
    })
    assertEquals(result.status, 'blocked')
    assertEquals(await orgExists(db, orgId), true)
    assertEquals((await db.select().from(audit).where(eq(audit.targetId, orgId))).length, 0)
    await db.delete(server).where(eq(server.organizationId, orgId))
    assertEquals(
      (
        await deleteOrganizationIfClear(db, orgId, {
          organizationId: null,
          action: 'organization.delete',
          targetType: 'organization',
          targetId: orgId,
        })
      ).status,
      'deleted'
    )
    assertEquals(
      (
        await deleteOrganizationIfClear(db, orgId, {
          organizationId: null,
          action: 'organization.delete',
          targetType: 'organization',
          targetId: orgId,
        })
      ).status,
      'not_found'
    )
  })
})

test('a delete removes the permission grants on the organization, its teams, workspaces and projects', async () => {
  await withScene(async ({ db, orgId, del }) => {
    const [ws] = await db
      .insert(workspace)
      .values({ organizationId: orgId, name: 'ws' })
      .returning({ id: workspace.id })
    const [teamRow] = await db
      .select({ id: team.id })
      .from(team)
      .where(eq(team.organizationId, orgId))
    const [bystander] = await db
      .insert(user)
      .values({ email: `org-delete-by-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
      .returning({ id: user.id })
    try {
      const entities = [
        ['workspace', ws!.id],
        ['team', teamRow!.id],
      ] as const
      await db.insert(grant).values(
        entities.map(([entityType, entityId]) => ({
          entityType,
          entityId,
          actorType: 'user',
          actorId: bystander!.id,
          permission: `${entityType}:own`,
        }))
      )
      const before = await db.select().from(grant).where(eq(grant.actorId, bystander!.id))
      assertEquals(before.length, 2)
      assertEquals((await del('owner')).status, 200)
      assertEquals(
        (await db.select().from(grant).where(eq(grant.actorId, bystander!.id))).length,
        0
      )
      assertEquals((await db.select().from(grant).where(eq(grant.entityId, orgId))).length, 0)
    } finally {
      await db.delete(user).where(eq(user.id, bystander!.id))
    }
  })
})
