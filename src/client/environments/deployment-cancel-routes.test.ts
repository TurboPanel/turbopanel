/**
 * `POST /environments/:id/deployments/:deploymentId/cancel` against a real
 * database: managers and owners only (a read-only member and another
 * organization's manager are refused), the cancel is written to the audit
 * trail once, and asking again changes and records nothing. Skips without
 * TURBOPANEL_DATABASE_URL.
 */

import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  audit,
  command,
  deployment,
  environment,
  grant,
  organization,
  project,
  server,
  user,
  workspace,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { emptyComposeDocument } from '../../features/compose/index.ts'
import { createCommandRecord, getCommandRecord } from '../../features/commands/command-records.ts'
import { upsertDeploymentTargets } from '../../features/deploy/deployment-records.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerEnvironmentDeploymentHistoryRoutes } from './deployment-history-routes.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  environmentId: string
  serverId: string
  commandId: string
  managerCookie: string
  memberCookie: string
  otherManagerCookie: string
}

async function insertUser(db: Db, organizationId: string, permission: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({
      email: `cancel-${crypto.randomUUID()}@example.com`,
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

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping deploy-cancel route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerEnvironmentDeploymentHistoryRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const orgs = await db
    .insert(organization)
    .values([{ name: 'Cancel Route Org A' }, { name: 'Cancel Route Org B' }])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]
  const userIds: string[] = []
  let serverId: string | undefined
  try {
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Cancel Route Workspace', organizationId: orgA })
      .returning({ id: workspace.id })
    const [proj] = await db
      .insert(project)
      .values({
        name: 'Cancel Route Project',
        workspaceId: ws!.id,
        organizationId: orgA,
        options: { compose: emptyComposeDocument() },
      })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({
        name: 'Cancel Route Env',
        projectId: proj!.id,
        options: { compose: emptyComposeDocument() },
      })
      .returning({ id: environment.id })
    const now = new Date().toISOString()
    const [srv] = await db
      .insert(server)
      .values({ organizationId: orgA, name: 'cancel-route', createdAt: now, updatedAt: now })
      .returning({ id: server.id })
    serverId = srv!.id
    const record = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: crypto.randomUUID(),
      type: 'environment.deploy',
      payload: { environmentId: env!.id },
      context: { environmentId: env!.id, serverId, generation: 3 },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    await upsertDeploymentTargets(db, {
      environmentId: env!.id,
      targets: [
        {
          serverId,
          desiredGeneration: 3,
          status: 'applying',
          lastCommandId: record.id,
        },
      ],
    })
    const ids = {
      manager: await insertUser(db, orgA, 'organization:manage'),
      member: await insertUser(db, orgA, 'organization:read'),
      otherManager: await insertUser(db, orgB, 'organization:manage'),
    }
    userIds.push(...Object.values(ids))
    const cookie = async (userId: string) => {
      const { token } = await createSession(db, userId, {})
      return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
    }
    await fn({
      db,
      app,
      orgA,
      orgB,
      environmentId: env!.id,
      serverId,
      commandId: record.id,
      managerCookie: await cookie(ids.manager),
      memberCookie: await cookie(ids.member),
      otherManagerCookie: await cookie(ids.otherManager),
    })
  } finally {
    await db.delete(audit).where(inArray(audit.organizationId, [orgA, orgB]))
    if (serverId) await db.delete(command).where(eq(command.serverId, serverId))
    await db.delete(deployment).where(eq(deployment.serverId, serverId ?? crypto.randomUUID()))
    await db.delete(environment).where(eq(environment.name, 'Cancel Route Env'))
    await db.delete(project).where(eq(project.name, 'Cancel Route Project'))
    await db.delete(workspace).where(eq(workspace.name, 'Cancel Route Workspace'))
    await db.delete(server).where(inArray(server.organizationId, [orgA, orgB]))
    await db.delete(organization).where(inArray(organization.id, [orgA, orgB]))
    if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds))
    await endDbConnection(db)
  }
}

async function cancel(
  f: Fixture,
  cookie: string | null,
  orgId: string,
  deploymentId: string = f.commandId
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await f.app.request(
    `/environments/${f.environmentId}/deployments/${deploymentId}/cancel`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [ORG_ID_HEADER]: orgId,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: '{}',
    }
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function auditRows(f: Fixture) {
  return await f.db
    .select({ action: audit.action, targetId: audit.targetId, context: audit.context })
    .from(audit)
    .where(and(eq(audit.organizationId, f.orgA), eq(audit.action, 'deployment.cancel')))
}

test('cancel refuses a request without a session', async () => {
  await withFixture(async (f) => {
    assertEquals((await cancel(f, null, f.orgA)).status, 401)
    assertEquals((await getCommandRecord(f.db, f.commandId))?.status, 'queued')
  })
})

test('cancel is for managers: a read-only member and another organization are refused', async () => {
  await withFixture(async (f) => {
    assertEquals((await cancel(f, f.memberCookie, f.orgA)).status, 403)
    const other = await cancel(f, f.otherManagerCookie, f.orgB)
    assertEquals(other.status, 404)
    assertEquals((await getCommandRecord(f.db, f.commandId))?.status, 'queued')
    assertEquals(await auditRows(f), [])
  })
})

test('a manager cancels a queued deploy, it is audited once, and asking again records nothing', async () => {
  await withFixture(async (f) => {
    const first = await cancel(f, f.managerCookie, f.orgA)
    assertEquals(first.status, 200)
    assertEquals(first.body, {
      ok: true,
      state: 'cancelled',
      environmentId: f.environmentId,
      deploymentId: f.commandId,
    })
    assertEquals((await getCommandRecord(f.db, f.commandId))?.status, 'cancelled')
    const rows = await auditRows(f)
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.targetId, f.environmentId)
    assertEquals((rows[0]?.context as { state: string }).state, 'cancelled')

    const again = await cancel(f, f.managerCookie, f.orgA)
    assertEquals(again.status, 200)
    assertEquals(again.body.state, 'already_cancelled')
    assertEquals((await auditRows(f)).length, 1)
  })
})

test('a deploy that already finished is a 409 and an unknown id a 404', async () => {
  await withFixture(async (f) => {
    await f.db.update(command).set({ status: 'succeeded' }).where(eq(command.id, f.commandId))
    const done = await cancel(f, f.managerCookie, f.orgA)
    assertEquals(done.status, 409)
    assertEquals(done.body, { error: 'deploy_not_cancellable' })
    const missing = await cancel(f, f.managerCookie, f.orgA, crypto.randomUUID())
    assertEquals(missing.status, 404)
    assertEquals(await auditRows(f), [])
  })
})

test('a running deploy on a server with no daemon link answers 503 and changes nothing', async () => {
  await withFixture(async (f) => {
    await f.db.update(command).set({ status: 'sent' }).where(eq(command.id, f.commandId))
    const res = await cancel(f, f.managerCookie, f.orgA)
    assertEquals(res.status, 503)
    assertEquals(res.body, { error: 'daemon_unavailable' })
    assertEquals((await getCommandRecord(f.db, f.commandId))?.status, 'sent')
    assertEquals(await auditRows(f), [])
  })
})
