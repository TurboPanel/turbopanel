import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { datacenter, grant, ip, network, organization, server, user } from '../../db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerServerRoutes } from '../servers/routes.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerDatacenterRoutes } from './routes.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Db = ReturnType<typeof createDenoDb>

function reportedAddress(address: string, cidr: string): Record<string, unknown> {
  return { ips: [{ address, version: 4, scope: 'private', cidr }] }
}

async function insertServer(db: Db, organizationId: string, name: string, address: string) {
  const now = new Date().toISOString()
  const [row] = await db
    .insert(server)
    .values({
      organizationId,
      name,
      metadata: reportedAddress(address, `${address}/24`),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  return row!.id
}

type Placed = { serverId: string; datacenterId: string }

test('servers placed in two datacenters show that placement on the server and the datacenter', async () => {
  if (!dbUrl) return
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  const options = { secrets, runtime: 'deno' as const, signupEnvOverride: undefined }
  registerDatacenterRoutes(app, options)
  registerServerRoutes(app, options)

  const [org] = await db
    .insert(organization)
    .values({ name: 'Placement Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [account] = await db
    .insert(user)
    .values({ email: `placement-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = account!.id
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })

  try {
    const { token } = await createSession(db, userId, {})
    const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
    const headers = {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    }
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await app.request(path, { ...init, headers })
      assertEquals(res.status, 200, `${init.method ?? 'GET'} ${path}`)
      return await res.json()
    }
    const place = async (serverId: string, name: string): Promise<Placed> => {
      const created = (await call('/datacenters', {
        method: 'POST',
        body: JSON.stringify({ name, members: [{ serverId, address: await addressOf(serverId) }] }),
      })) as { id: string }
      return { serverId, datacenterId: created.id }
    }
    const addressOf = async (serverId: string): Promise<string> => {
      const [row] = await db
        .select({ metadata: server.metadata })
        .from(server)
        .where(eq(server.id, serverId))
      const reported = row!.metadata as { ips: Array<{ address: string }> }
      return reported.ips[0]!.address
    }

    const metal = await insertServer(db, organizationId, 'Bare metal', '10.1.0.10')
    const vps = await insertServer(db, organizationId, 'VPS', '10.2.0.10')
    const racked = await place(metal, 'Rack A')
    const cloud = await place(vps, 'Cloud B')

    // The datacenter page lists exactly its own member.
    type Detail = { members: Array<{ serverId: string }> }
    const [rackedDetail, cloudDetail] = (await Promise.all([
      call(`/datacenters/${racked.datacenterId}`),
      call(`/datacenters/${cloud.datacenterId}`),
    ])) as [Detail, Detail]
    assertEquals(
      rackedDetail.members.map((member) => member.serverId),
      [metal]
    )
    assertEquals(
      cloudDetail.members.map((member) => member.serverId),
      [vps]
    )

    // The server page names the datacenter it sits in, and only that one.
    const rackedServer = (await call(`/servers/${metal}`)) as {
      server: { datacenters: Array<{ id: string; name: string | null }> }
    }
    assertEquals(rackedServer.server.datacenters, [{ id: racked.datacenterId, name: 'Rack A' }])
    const cloudServer = (await call(`/servers/${vps}`)) as {
      server: { datacenters: Array<{ id: string; name: string | null }> }
    }
    assertEquals(cloudServer.server.datacenters, [{ id: cloud.datacenterId, name: 'Cloud B' }])

    // The server list agrees.
    const list = (await call('/servers')) as {
      servers: Array<{ id: string; datacenters: Array<{ id: string }> }>
    }
    const byId = new Map(list.servers.map((row) => [row.id, row.datacenters.map((dc) => dc.id)]))
    assertEquals(byId.get(metal), [racked.datacenterId])
    assertEquals(byId.get(vps), [cloud.datacenterId])
  } finally {
    await db.delete(ip).where(eq(ip.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(network).where(eq(network.organizationId, organizationId))
    await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
    await db
      .delete(grant)
      .where(and(eq(grant.actorId, userId), inArray(grant.entityId, [organizationId])))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})
