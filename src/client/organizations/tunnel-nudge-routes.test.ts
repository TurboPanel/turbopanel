/**
 * The request handlers that change what forwarding tables are built from send
 * the tables before they answer: a site's names edited, a site made or deleted,
 * a server taken out of a datacenter. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { grant, hosting, user } from '../../db/schema.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { nudgeTunnelRoutes } from '../../features/tunnels/nudge.ts'
import { registerDatacenterRoutes } from '../datacenters/routes.ts'
import { registerHostingRoutes } from '../hostings/routes.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import {
  NAME,
  sentTo,
  tableOf,
  withScenario,
} from '../../features/tunnels/nudge-scenario.test.support.ts'
import type { Scenario } from '../../features/tunnels/nudge-scenario.test.support.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Api = (path: string, method: string, body?: unknown) => Promise<Response>

/** The handlers behind a signed-in manager, with the queue and secrets a send needs. */
async function withApi(s: Scenario, fn: (api: Api) => Promise<void>): Promise<void> {
  const sessionSecrets = await deriveSecretsConfig(s.deps.secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', s.db)
    c.set('commandQueue', s.deps.commandQueue)
    c.set('secretsConfig', s.deps.secretsConfig)
    c.set('dataEncryptionSecrets', s.deps.dataEncryptionSecrets)
    return next()
  })
  const opts = { secrets: sessionSecrets, runtime: 'deno' as const, signupEnvOverride: undefined }
  registerHostingRoutes(app, opts)
  registerDatacenterRoutes(app, opts)
  const [u] = await s.db
    .insert(user)
    .values({ email: `nudge-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  await s.db.insert(grant).values({
    entityType: 'organization',
    entityId: s.organizationId,
    actorType: 'user',
    actorId: u!.id,
    permission: 'organization:manage',
  })
  const { token } = await createSession(s.db, u!.id, {})
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, sessionSecrets)}`
  try {
    await fn((path, method, body) =>
      Promise.resolve(
        app.request(path, {
          method,
          headers: {
            cookie,
            [ORG_ID_HEADER]: s.organizationId,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      )
    )
  } finally {
    await s.db.delete(grant).where(eq(grant.actorId, u!.id))
    await s.db.delete(user).where(eq(user.id, u!.id))
  }
}

async function serviceOf(s: Scenario, hostingId: string): Promise<string> {
  const [row] = await s.db
    .select({ serviceId: hosting.serviceId })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
  return row!.serviceId
}

test('editing a site’s names sends the carrier the new table before the answer', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel nudge route tests')
    return
  }
  await withScenario({}, async (s) => {
    await withApi(s, async (api) => {
      const off = await api(`/hostings/${s.hostingAId}`, 'PATCH', { options: { hostnames: [] } })
      assertEquals(off.status, 200)
      const on = await api(`/hostings/${s.hostingBId}`, 'PATCH', { options: { hostnames: [NAME] } })
      assertEquals(on.status, 200)
      const toCarrier = sentTo(s, s.carrierId)
      const latest = await tableOf(s, s.queued.indexOf(toCarrier.at(-1)!))
      assertEquals(latest.routes[0]!.upstreams[0]!.addresses, ['10.95.0.12'])
    })
  })
})

test('deleting a site drops its name from the carrier before the answer', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel nudge route tests')
    return
  }
  await withScenario({}, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    await withApi(s, async (api) => {
      const deleted = await api(`/hostings/${s.hostingAId}`, 'DELETE')
      assertEquals(deleted.status, 200)
      const toCarrier = sentTo(s, s.carrierId)
      assertEquals(toCarrier.length, 2)
      assertEquals((await tableOf(s, s.queued.indexOf(toCarrier[1]!))).routes, [])
    })
  })
})

test('making a site with the name later brings it back to the carrier', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel nudge route tests')
    return
  }
  await withScenario({}, async (s) => {
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    await withApi(s, async (api) => {
      await api(`/hostings/${s.hostingAId}`, 'DELETE')
      const created = await api('/hostings', 'POST', {
        serviceId: await serviceOf(s, s.hostingBId),
        name: 'Shop',
        options: { hostnames: [NAME] },
      })
      assertEquals(created.status, 200)
      const toCarrier = sentTo(s, s.carrierId)
      assertEquals(toCarrier.length, 3)
      const latest = await tableOf(s, s.queued.indexOf(toCarrier[2]!))
      assertEquals(latest.routes[0]!.upstreams[0]!.addresses, ['10.95.0.12'])
    })
  })
})

test('taking a server out of a datacenter tells it to drop its table before the answer', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('tunnel nudge route tests')
    return
  }
  await withScenario({ tunnelPlacement: 'all' }, async (s) => {
    // Every server of the datacenter carries the tunnel, so site B forwards the name to site A.
    await nudgeTunnelRoutes(s.db, s.deps, s.organizationId)
    const before = sentTo(s, s.siteBId)
    assertEquals(before.length, 1)
    assertEquals((await tableOf(s, s.queued.indexOf(before[0]!))).routes.length, 1)
    await withApi(s, async (api) => {
      const removed = await api(`/datacenters/${s.datacenterId}/members/${s.siteBId}`, 'DELETE')
      assertEquals(removed.status, 200)
      const after = sentTo(s, s.siteBId)
      assertEquals(after.length, 2)
      assertEquals((await tableOf(s, s.queued.indexOf(after[1]!))).routes, [])
    })
  })
})
