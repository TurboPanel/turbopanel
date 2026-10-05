/**
 * PHP mode policy routes against a real database: owners and managers only
 * (a read-only member and another organization's manager are refused, and
 * another organization's server is not found), unknown modes are refused, and
 * narrowing a policy lists the affected sites without changing them. Skips
 * without TURBOPANEL_DATABASE_URL.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  deployment,
  environment,
  grant,
  organization,
  project,
  server,
  user,
  workspace,
} from '../../db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerPhpModeRoutes } from './php-mode-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  serverA: string
  serverB: string
  environmentA: string
  cookies: Record<'owner' | 'manager' | 'member' | 'otherManager', string>
}

type Called = { status: number; body: Record<string, unknown> }

async function insertUser(db: Db, organizationId: string, permission: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({
      email: `php-modes-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: row!.id,
    permission,
  })
  return row!.id
}

async function insertServer(db: Db, organizationId: string, name: string): Promise<string> {
  const now = new Date().toISOString()
  const [row] = await db
    .insert(server)
    .values({ organizationId, name, createdAt: now, updatedAt: now, statusChangedAt: now })
    .returning({ id: server.id })
  return row!.id
}

/** An environment on `serverId` whose last deploy recorded `blog` on php-fpm. */
async function insertDeployedEnvironment(db: Db, organizationId: string, serverId: string) {
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'PHP Modes Workspace', organizationId })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ name: 'PHP Modes Project', workspaceId: ws!.id, organizationId })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'Production', serverId })
    .returning({ id: environment.id })
  await db.insert(deployment).values({
    environmentId: env!.id,
    serverId,
    options: { secretPlan: [], phpModes: { blog: 'fpm', shop: 'fastcgi' } },
  })
  return { workspaceId: ws!.id, projectId: proj!.id, environmentId: env!.id }
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('php mode route tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerPhpModeRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const orgs = await db
    .insert(organization)
    .values([{ name: 'PHP Modes Org A' }, { name: 'PHP Modes Org B' }])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]
  const userIds: string[] = []
  let deployed: Awaited<ReturnType<typeof insertDeployedEnvironment>> | undefined
  try {
    const ids = {
      owner: await insertUser(db, orgA, 'organization:own'),
      manager: await insertUser(db, orgA, 'organization:manage'),
      member: await insertUser(db, orgA, 'organization:read'),
      otherManager: await insertUser(db, orgB, 'organization:manage'),
    }
    userIds.push(...Object.values(ids))
    const cookie = async (userId: string) => {
      const { token } = await createSession(db, userId, {})
      return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
    }
    const serverA = await insertServer(db, orgA, 'PHP Modes Server A')
    deployed = await insertDeployedEnvironment(db, orgA, serverA)
    await fn({
      db,
      app,
      orgA,
      orgB,
      serverA,
      serverB: await insertServer(db, orgB, 'PHP Modes Server B'),
      environmentA: deployed.environmentId,
      cookies: {
        owner: await cookie(ids.owner),
        manager: await cookie(ids.manager),
        member: await cookie(ids.member),
        otherManager: await cookie(ids.otherManager),
      },
    })
  } finally {
    if (deployed) {
      await db.delete(deployment).where(eq(deployment.environmentId, deployed.environmentId))
      await db.delete(environment).where(eq(environment.id, deployed.environmentId))
      await db.delete(project).where(eq(project.id, deployed.projectId))
      await db.delete(workspace).where(eq(workspace.id, deployed.workspaceId))
    }
    await db.delete(server).where(inArray(server.organizationId, [orgA, orgB]))
    if (userIds.length > 0) {
      await db.delete(grant).where(inArray(grant.actorId, userIds))
      await db.delete(user).where(inArray(user.id, userIds))
    }
    await db.delete(organization).where(inArray(organization.id, [orgA, orgB]))
    await endDbConnection(db)
  }
}

async function call(
  f: Fixture,
  method: 'GET' | 'PUT',
  path: string,
  cookie: string | null,
  body?: unknown,
  orgHeader?: string
): Promise<Called> {
  const res = await f.app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(orgHeader ? { [ORG_ID_HEADER]: orgHeader } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function storedPhpModes(f: Fixture) {
  const [org] = await f.db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, f.orgA))
  const [srv] = await f.db
    .select({ options: server.options })
    .from(server)
    .where(eq(server.id, f.serverA))
  const read = (options: unknown) => (options as { phpModes?: unknown } | null)?.phpModes
  return { organization: read(org?.options), server: read(srv?.options) }
}

test('php mode routes refuse no session, a plain member and another organization', async () => {
  await withFixture(async (f) => {
    const orgPath = `/organizations/${f.orgA}/php-modes`
    const serverPath = `/servers/${f.serverA}/php-modes`
    const body = { phpModes: ['fpm'] }
    for (const path of [orgPath, serverPath]) {
      for (const method of ['GET', 'PUT'] as const) {
        assertEquals((await call(f, method, path, null, body)).status, 401, `${method} ${path}`)
        const member = await call(f, method, path, f.cookies.member, body, f.orgA)
        assertEquals(member.status, 403, `member ${method} ${path}`)
      }
    }
    // Another organization's manager: forbidden on the org, not found for the server.
    for (const method of ['GET', 'PUT'] as const) {
      const org = await call(f, method, orgPath, f.cookies.otherManager, body, f.orgB)
      assertEquals(org.status, 403, `other org ${method}`)
      const srv = await call(f, method, serverPath, f.cookies.otherManager, body, f.orgB)
      assertEquals(srv.status, 404, `other server ${method}`)
    }
    // A manager cannot reach another organization's server either.
    const foreign = await call(
      f,
      'PUT',
      `/servers/${f.serverB}/php-modes`,
      f.cookies.manager,
      body,
      f.orgA
    )
    assertEquals(foreign.status, 404)
    assertEquals(await storedPhpModes(f), { organization: undefined, server: undefined })
  })
})

test('managers and owners set the policy; unknown modes are refused', async () => {
  await withFixture(async (f) => {
    const orgPath = `/organizations/${f.orgA}/php-modes`
    const serverPath = `/servers/${f.serverA}/php-modes`

    const initial = await call(f, 'GET', orgPath, f.cookies.manager)
    assertEquals(initial.status, 200)
    assertEquals(initial.body.phpModes, null)
    assertEquals((initial.body.engines as Record<string, unknown>).nginx, {
      allowed: ['fastcgi', 'fpm'],
      default: 'fastcgi',
    })

    const bad = await call(f, 'PUT', orgPath, f.cookies.owner, { phpModes: ['cgi'] })
    assertEquals(bad.status, 400)
    assertEquals(bad.body.error, 'invalid_php_modes')

    const org = await call(f, 'PUT', orgPath, f.cookies.owner, {
      phpModes: ['lsphp-detached', 'fpm', 'fastcgi'],
    })
    assertEquals(org.status, 200)
    assertEquals(org.body.phpModes, ['fastcgi', 'fpm', 'lsphp-detached'])

    const srv = await call(f, 'PUT', serverPath, f.cookies.manager, { phpModes: ['fpm'] }, f.orgA)
    assertEquals(srv.status, 200)
    const read = await call(f, 'GET', serverPath, f.cookies.manager, undefined, f.orgA)
    assertEquals(read.body.phpModes, ['fpm'])
    assertEquals(read.body.organizationPhpModes, ['fastcgi', 'fpm', 'lsphp-detached'])
    assertEquals((read.body.engines as Record<string, unknown>).openlitespeed, {
      allowed: ['fpm'],
      default: 'fpm',
    })

    const reset = await call(f, 'PUT', serverPath, f.cookies.manager, { phpModes: null }, f.orgA)
    assertEquals(reset.status, 200)
    assertEquals(await storedPhpModes(f), {
      organization: ['fastcgi', 'fpm', 'lsphp-detached'],
      server: undefined,
    })
  })
})

test('narrowing a policy lists affected sites and leaves them running', async () => {
  await withFixture(async (f) => {
    const narrowed = await call(f, 'PUT', `/organizations/${f.orgA}/php-modes`, f.cookies.manager, {
      phpModes: ['fastcgi'],
    })
    assertEquals(narrowed.status, 200)
    assertEquals(narrowed.body.affectedSites, [
      {
        environmentId: f.environmentA,
        serverId: f.serverA,
        composeServiceName: 'blog',
        mode: 'fpm',
      },
    ])

    const serverNarrowed = await call(
      f,
      'PUT',
      `/servers/${f.serverA}/php-modes`,
      f.cookies.manager,
      { phpModes: ['fpm'] },
      f.orgA
    )
    // Organization offers only fastcgi, server only fpm: both recorded sites are affected.
    assertEquals(
      (serverNarrowed.body.affectedSites as { composeServiceName: string }[])
        .map((site) => site.composeServiceName)
        .sort((a, b) => a.localeCompare(b)),
      ['blog', 'shop']
    )

    // The record a deploy reads back is untouched.
    const [row] = await f.db
      .select({ options: deployment.options })
      .from(deployment)
      .where(eq(deployment.environmentId, f.environmentA))
    assertEquals((row?.options as { phpModes?: unknown }).phpModes, {
      blog: 'fpm',
      shop: 'fastcgi',
    })
  })
})
