import { assertEquals, assertExists } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  grant,
  license,
  notification,
  organization,
  project,
  server,
  user,
  workspace,
} from '../../db/schema.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import { createLicense } from '../../features/licenses/license.ts'
import { deleteProjectCascade } from '../../features/projects/project-delete.ts'
import { resolveServerId } from '../../features/servers/server-registry.ts'
import { mapSequential } from '../../lib/sequential.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerOrganizationRoutes } from '../organizations/routes.ts'
import { registerServerRoutes } from './routes.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Db = ReturnType<typeof createDenoDb>

/** A daemon-cell registry that only records which servers were purged. */
function createPurgeRecordingRegistry(): DaemonCellRegistry & { purgedIds: string[] } {
  const purgedIds: string[] = []
  const purge = (serverId: string): Promise<void> => {
    purgedIds.push(serverId)
    return Promise.resolve()
  }
  return {
    purgedIds,
    getCell: (serverId: string) => ({ purge: () => purge(serverId) }) as never,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge,
  }
}

function randomMachineKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

type FleetCtx = {
  db: Db
  app: Hono<AppEnv>
  cookie: string
  organizationId: string
  userId: string
  serverId: string
  registry: ReturnType<typeof createPurgeRecordingRegistry>
}

/** Drop what enrolling a licensed server writes (system hierarchy), then the org itself. */
async function cleanUpOrganization(db: Db, organizationId: string): Promise<void> {
  const workspaces = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.organizationId, organizationId))
  const projects = await db
    .select({ id: project.id })
    .from(project)
    .where(eq(project.organizationId, organizationId))
  await mapSequential(projects, (row) => deleteProjectCascade(db, row.id))
  await mapSequential(workspaces, (row) => db.delete(workspace).where(eq(workspace.id, row.id)))
  await db.update(license).set({ serverId: null }).where(eq(license.organizationId, organizationId))
  await db.delete(notification).where(eq(notification.organizationId, organizationId))
  await db.delete(server).where(eq(server.organizationId, organizationId))
  await db.delete(license).where(eq(license.organizationId, organizationId))
  await db.delete(grant).where(eq(grant.entityId, organizationId))
}

async function withFleetFixtures(fn: (ctx: FleetCtx) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping fleet verification tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const registry = createPurgeRecordingRegistry()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', registry)
    return next()
  })
  const routeOpts = { secrets, runtime: 'deno' as const, signupEnvOverride: undefined }
  registerServerRoutes(app, routeOpts)
  registerOrganizationRoutes(app, routeOpts)

  const [org] = await db
    .insert(organization)
    .values({ name: 'Fleet Verification Org' })
    .returning({ id: organization.id })
  const [person] = await db
    .insert(user)
    .values({
      email: `fleet-verify-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: org!.id,
    actorType: 'user',
    actorId: person!.id,
    permission: 'organization:manage',
  })
  const now = new Date().toISOString()
  const [enrolled] = await db
    .insert(server)
    .values({ organizationId: org!.id, name: 'Delete Me', createdAt: now, updatedAt: now })
    .returning({ id: server.id })
  const { token } = await createSession(db, person!.id, {})
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`

  try {
    await fn({
      db,
      app,
      cookie,
      organizationId: org!.id,
      userId: person!.id,
      serverId: enrolled!.id,
      registry,
    })
  } finally {
    try {
      await cleanUpOrganization(db, org!.id)
      await db.delete(user).where(eq(user.id, person!.id))
      await db.delete(organization).where(eq(organization.id, org!.id))
    } finally {
      await endDbConnection(db)
    }
  }
}

function request(ctx: FleetCtx, method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    ctx.app.request(path, {
      method,
      headers: {
        Cookie: ctx.cookie,
        [ORG_ID_HEADER]: ctx.organizationId,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  )
}

test('deleting a server fires server.deleted to the managers, frees its license and purges its daemon cell', async () => {
  await withFleetFixtures(async (ctx) => {
    const { licenseId } = await createLicense(ctx.db, { organizationId: ctx.organizationId })
    await ctx.db
      .update(license)
      .set({ serverId: ctx.serverId, updatedAt: new Date().toISOString() })
      .where(eq(license.id, licenseId))

    const res = await request(ctx, 'DELETE', `/servers/${ctx.serverId}`)
    assertEquals(res.status, 200)

    const inbox = await ctx.db
      .select({ context: notification.context })
      .from(notification)
      .where(and(eq(notification.userId, ctx.userId), eq(notification.event, 'server.deleted')))
    assertEquals(inbox.length, 1)
    assertEquals((inbox[0]!.context as { serverName?: string }).serverName, 'Delete Me')

    const [licenseRow] = await ctx.db
      .select({ revokedAt: license.revokedAt })
      .from(license)
      .where(eq(license.id, licenseId))
    assertExists(licenseRow?.revokedAt)
    assertEquals(ctx.registry.purgedIds.includes(ctx.serverId), true)
    const remaining = await ctx.db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, ctx.serverId))
    assertEquals(remaining.length, 0)
  })
})

interface ServerDetailBody {
  server: {
    sshPort: number
    sshPortSource: string | null
    ntpDefaults: { servers?: string[] } | null
    ntpDefaultsSource: string | null
  }
}

test("organization host defaults set in the console apply to a server with none of its own, and the server's own value wins", async () => {
  await withFleetFixtures(async (ctx) => {
    const put = await request(ctx, 'PUT', `/organizations/${ctx.organizationId}/host-defaults`, {
      sshPort: 2222,
      ntp: { servers: ['time.example.org'] },
    })
    assertEquals(put.status, 200)

    const inherited = (
      (await (await request(ctx, 'GET', `/servers/${ctx.serverId}`)).json()) as ServerDetailBody
    ).server
    assertEquals(inherited.sshPort, 2222)
    assertEquals(inherited.sshPortSource, 'organization')
    assertEquals(inherited.ntpDefaults?.servers, ['time.example.org'])
    assertEquals(inherited.ntpDefaultsSource, 'organization')

    await ctx.db
      .update(server)
      .set({ options: { sshPort: 2200 } })
      .where(eq(server.id, ctx.serverId))
    const own = (
      (await (await request(ctx, 'GET', `/servers/${ctx.serverId}`)).json()) as ServerDetailBody
    ).server
    assertEquals(own.sshPort, 2200)
    assertEquals(own.sshPortSource, 'server')
    // Only the port was overridden: the NTP default is still inherited.
    assertEquals(own.ntpDefaultsSource, 'organization')
  })
})

test('re-enrolling the same host with the same license resolves the same server and creates no duplicate', async () => {
  await withFleetFixtures(async (ctx) => {
    // The fixture server is deleted first so this test owns the only server in the org.
    await ctx.db.delete(server).where(eq(server.id, ctx.serverId))
    const { licenseId, licenseToken } = await createLicense(ctx.db, {
      organizationId: ctx.organizationId,
      name: 'Reenroll License',
    })
    const identity = {
      hostname: `reenroll-${crypto.randomUUID()}`,
      machineKey: randomMachineKey(),
      licenseId,
      licenseToken,
    }

    const first = await resolveServerId(ctx.db, identity)
    assertEquals(typeof first, 'string')

    // The installer ran again: same machine and license, the server id the daemon
    // kept on disk, a changed hostname.
    const second = await resolveServerId(ctx.db, {
      ...identity,
      serverId: first!,
      hostname: `${identity.hostname}-renamed`,
    })
    assertEquals(second, first)

    // The same license without that identity is a different install, not a re-run.
    assertEquals(
      await resolveServerId(ctx.db, { ...identity, machineKey: randomMachineKey() }),
      null
    )

    const rows = await ctx.db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.organizationId, ctx.organizationId))
    assertEquals(
      rows.map((row) => row.id),
      [first]
    )
    const [bound] = await ctx.db
      .select({ serverId: license.serverId })
      .from(license)
      .where(eq(license.id, licenseId))
    assertEquals(bound?.serverId, first)
  })
})
