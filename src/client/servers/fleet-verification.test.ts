import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertExists } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { WORKSPACE_KIND_USER } from '../../db/workspace-kind.ts'
import {
  environment,
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
import { countReservedLicenseTiers } from '../../features/tiers/tier-records.ts'
import { deleteProjectCascade } from '../../features/projects/project-delete.ts'
import { resolveServerId } from '../../features/servers/server-registry.ts'
import { mapSequential } from '../../lib/sequential.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { seedTierSeats } from '../../test-fixtures/tier-seats.test.support.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerOrganizationRoutes } from '../organizations/routes.ts'
import { SERVER_HAS_BLOCKERS_CODE } from './delete-guards.ts'
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

type PurgeRecordingRegistry = DaemonCellRegistry & {
  purgedIds: string[]
  /** Runs when a cell is purged, to look at the database at that moment. */
  onPurge?: (serverId: string) => Promise<void>
}

/** A daemon-cell registry that only records which servers were purged. */
function createPurgeRecordingRegistry(): PurgeRecordingRegistry {
  const registry: PurgeRecordingRegistry = {
    purgedIds: [],
    getCell: (serverId: string) => ({ purge: () => registry.purge(serverId) }) as never,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: async (serverId: string) => {
      registry.purgedIds.push(serverId)
      await registry.onPurge?.(serverId)
    },
  }
  return registry
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
    skipWithoutDatabase('fleet verification tests')
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

test('deleting a server retires its key in the same step: a daemon still running there cannot enroll again', async () => {
  await withFleetFixtures(async (ctx) => {
    const { licenseId, licenseToken } = await createLicense(ctx.db, {
      organizationId: ctx.organizationId,
    })
    await ctx.db
      .update(license)
      .set({ serverId: ctx.serverId, updatedAt: new Date().toISOString() })
      .where(eq(license.id, licenseId))

    // The first follow-up after the delete transaction is the cell purge: by
    // then the key must already be revoked, so a re-enroll from the host fails.
    const seen: { revoked: boolean; reEnrolled: string | null }[] = []
    ctx.registry.onPurge = async () => {
      const [row] = await ctx.db
        .select({ revokedAt: license.revokedAt })
        .from(license)
        .where(eq(license.id, licenseId))
      const reEnrolled = await resolveServerId(ctx.db, {
        hostname: `still-running-${crypto.randomUUID()}`,
        machineKey: randomMachineKey(),
        licenseId,
        licenseToken,
      })
      seen.push({ revoked: Boolean(row?.revokedAt), reEnrolled })
    }

    const res = await request(ctx, 'DELETE', `/servers/${ctx.serverId}`)
    assertEquals(res.status, 200)
    assertEquals(seen, [{ revoked: true, reEnrolled: null }])
  })
})

/**
 * Enroll a host the way a daemon does (the key latches, the system hierarchy
 * with its not-yet-started ingress row is built) and mark it connected.
 */
async function enrollConnectedServer(
  ctx: FleetCtx,
  tierId?: string
): Promise<{ serverId: string; licenseId: string }> {
  const key = await createLicense(ctx.db, { organizationId: ctx.organizationId, tierId })
  const serverId = await resolveServerId(ctx.db, {
    hostname: `enrolled-${crypto.randomUUID()}`,
    machineKey: randomMachineKey(),
    ...key,
  })
  assertExists(serverId)
  await ctx.db.update(server).set({ isConnected: true }).where(eq(server.id, serverId))
  return { serverId, licenseId: key.licenseId }
}

async function licenseRevoked(ctx: FleetCtx, licenseId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ revokedAt: license.revokedAt })
    .from(license)
    .where(eq(license.id, licenseId))
  return Boolean(row?.revokedAt)
}

async function serverExists(ctx: FleetCtx, serverId: string): Promise<boolean> {
  const rows = await ctx.db.select({ id: server.id }).from(server).where(eq(server.id, serverId))
  return rows.length > 0
}

test('a connected server enrolled with a key that names no tier deletes and its key is revoked', async () => {
  await withFleetFixtures(async (ctx) => {
    const { serverId, licenseId } = await enrollConnectedServer(ctx)

    const res = await request(ctx, 'DELETE', `/servers/${serverId}`)
    assertEquals(res.status, 200)
    assertEquals(await serverExists(ctx, serverId), false)
    assertEquals(await licenseRevoked(ctx, licenseId), true)
    assertEquals(ctx.registry.purgedIds.includes(serverId), true)
  })
})

test('a connected server holding its Add Server tier seat deletes and the seat is free for the next server', async () => {
  await withFleetFixtures(async (ctx) => {
    const seats = await seedTierSeats(ctx.db, ctx.organizationId, 1)
    try {
      const first = await enrollConnectedServer(ctx, seats.tierId)
      const [held] = await ctx.db
        .select({ assigned: server.assignedTierId })
        .from(server)
        .where(eq(server.id, first.serverId))
      assertEquals(held?.assigned, seats.tierId)

      const res = await request(ctx, 'DELETE', `/servers/${first.serverId}`)
      assertEquals(res.status, 200)
      assertEquals(await licenseRevoked(ctx, first.licenseId), true)
      assertEquals((await countReservedLicenseTiers(ctx.db, ctx.organizationId)).size, 0)

      // The only seat came back: the next server added on that tier takes it.
      const next = await enrollConnectedServer(ctx, seats.tierId)
      const [taken] = await ctx.db
        .select({ assigned: server.assignedTierId })
        .from(server)
        .where(eq(server.id, next.serverId))
      assertEquals(taken?.assigned, seats.tierId)
    } finally {
      await cleanUpOrganization(ctx.db, ctx.organizationId)
      await seats.cleanup()
    }
  })
})

test('a connected server that still hosts an app answers which app to remove and keeps its key', async () => {
  await withFleetFixtures(async (ctx) => {
    const { serverId, licenseId } = await enrollConnectedServer(ctx)
    const [space] = await ctx.db
      .insert(workspace)
      .values({ organizationId: ctx.organizationId, name: 'Apps', kind: WORKSPACE_KIND_USER })
      .returning({ id: workspace.id })
    const [app] = await ctx.db
      .insert(project)
      .values({ organizationId: ctx.organizationId, workspaceId: space!.id, name: 'Shop' })
      .returning({ id: project.id })
    await ctx.db.insert(environment).values({ name: 'production', projectId: app!.id, serverId })

    const res = await request(ctx, 'DELETE', `/servers/${serverId}`)
    assertEquals(res.status, 409)
    const body = (await res.json()) as {
      code: string
      blockers?: { kind: string; items?: { projectName?: string }[] }[]
    }
    assertEquals(body.code, SERVER_HAS_BLOCKERS_CODE)
    const apps = body.blockers?.find((row) => row.kind === 'environment')
    assertEquals(apps?.items?.[0]?.projectName, 'Shop')
    assertEquals(await serverExists(ctx, serverId), true)
    assertEquals(await licenseRevoked(ctx, licenseId), false)
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
