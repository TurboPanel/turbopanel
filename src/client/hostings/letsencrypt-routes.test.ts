import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, type Db } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import {
  audit,
  environment,
  grant,
  hosting,
  organization,
  project,
  service,
  tls,
  user,
  workspace,
} from '../../db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerHostingRoutes } from './routes.ts'
import { registerHostingLetsEncryptRoutes } from './letsencrypt-routes.ts'
import { runHostingLetsEncryptSweepTick } from './letsencrypt-sweep.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()
const test = Deno.test.bind(Deno)

const pointing = () => Promise.resolve(['203.0.113.7'])
const nowhere = () => Promise.reject(new Error('NXDOMAIN'))

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  organizationId: string
  userId: string
  hostingId: string
  cookie: string
  setLookup: (lookup: () => Promise<string[]>) => void
  call: (method: string, path: string, body?: unknown) => Promise<Response>
  cleanup: () => Promise<void>
}

async function setup(options: {
  acmeEnabled: boolean
  hostingOptions: Record<string, unknown>
  hostingMetadata?: Record<string, unknown>
}): Promise<Fixture> {
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing'
  )
  let lookup: () => Promise<string[]> = pointing
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  const routeOpts = { secrets, runtime: 'deno' as const, signupEnvOverride: undefined }
  registerHostingLetsEncryptRoutes(app, routeOpts, { lookup: () => lookup() })
  registerHostingRoutes(app, routeOpts)

  const [org] = await db
    .insert(organization)
    .values({ name: 'LE Org', options: { acmeEnabled: options.acmeEnabled } })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [u] = await db
    .insert(user)
    .values({ email: `le-${crypto.randomUUID()}@example.com`, isEmailVerified: true })
    .returning({ id: user.id })
  const userId = u!.id
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:manage',
  })
  const now = new Date().toISOString()
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS', createdAt: now, updatedAt: now })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: ws!.id, organizationId, name: 'P', createdAt: now, updatedAt: now })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ projectId: proj!.id, name: 'E', createdAt: now, updatedAt: now })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({
      environmentId: env!.id,
      name: 's',
      composeServiceName: 's',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: service.id })
  const [host] = await db
    .insert(hosting)
    .values({
      serviceId: svc!.id,
      name: 'Site',
      options: options.hostingOptions,
      metadata: options.hostingMetadata ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })

  const { token } = await createSession(db, userId, {})
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  return {
    db,
    app,
    organizationId,
    userId,
    hostingId: host!.id,
    cookie,
    setLookup: (next) => {
      lookup = next
    },
    call: async (method, path, body) =>
      app.request(path, {
        method,
        headers: { cookie, [ORG_ID_HEADER]: organizationId, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    async cleanup() {
      await db.delete(audit).where(eq(audit.organizationId, organizationId))
      await db.delete(hosting).where(eq(hosting.id, host!.id))
      await db.delete(tls).where(eq(tls.organizationId, organizationId))
      await db.delete(service).where(eq(service.id, svc!.id))
      await db.delete(environment).where(eq(environment.id, env!.id))
      await db.delete(project).where(eq(project.id, proj!.id))
      await db.delete(workspace).where(eq(workspace.id, ws!.id))
      await db.delete(grant).where(eq(grant.actorId, userId))
      await db.delete(user).where(eq(user.id, userId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    },
  }
}

const PUBLIC_SITE = { hostnames: ['shop.example.com'] }

type CertificateBody = {
  certificate: { state: string; needsDeploy: boolean; dns: { ready: boolean } | null } | null
  needsDeploy: boolean
}

test("PUT use-letsencrypt: 403 while the organization has not allowed Let's Encrypt", async () => {
  if (!dbUrl) return skipWithoutDatabase("hosting Let's Encrypt route tests")
  const f = await setup({ acmeEnabled: false, hostingOptions: PUBLIC_SITE })
  try {
    const res = await f.call('PUT', `/hostings/${f.hostingId}/use-letsencrypt`, {})
    assertEquals(res.status, 403)
    assertEquals(((await res.json()) as { error: string }).error, 'lets_encrypt_not_enabled')
    const got = await f.call('GET', `/hostings/${f.hostingId}`)
    const body = (await got.json()) as {
      hosting: { certificate: { letsEncryptAvailable: boolean; state: string } }
    }
    assertEquals(body.hosting.certificate.state, 'test_certificate')
    assertEquals(body.hosting.certificate.letsEncryptAvailable, false)
  } finally {
    await f.cleanup()
  }
})

test('PUT use-letsencrypt: refuses a local bind and hostings owned by compose', async () => {
  if (!dbUrl) return skipWithoutDatabase("hosting Let's Encrypt route tests")
  const local = await setup({
    acmeEnabled: true,
    hostingOptions: { ...PUBLIC_SITE, bind: 'local' },
  })
  try {
    const res = await local.call('PUT', `/hostings/${local.hostingId}/use-letsencrypt`, {})
    assertEquals(res.status, 400)
    assertEquals(((await res.json()) as { error: string }).error, 'acme_requires_public_bind')
  } finally {
    await local.cleanup()
  }
  const owned = await setup({
    acmeEnabled: true,
    hostingOptions: PUBLIC_SITE,
    hostingMetadata: {
      composeOwned: true,
      composeServiceName: 'web',
      composeRoute: 'shop.example.com /',
    },
  })
  try {
    const res = await owned.call('PUT', `/hostings/${owned.hostingId}/use-letsencrypt`, {})
    assertEquals(res.status, 409)
    assertEquals(((await res.json()) as { error: string }).error, 'hosting_owned_by_compose')
  } finally {
    await owned.cleanup()
  }
})

test('PUT use-letsencrypt: waits for DNS, then the sweep pins it once the name resolves', async () => {
  if (!dbUrl) return skipWithoutDatabase("hosting Let's Encrypt route tests")
  const f = await setup({ acmeEnabled: true, hostingOptions: PUBLIC_SITE })
  try {
    f.setLookup(nowhere)
    const waiting = await f.call('PUT', `/hostings/${f.hostingId}/use-letsencrypt`, {
      wwwRedirect: true,
    })
    assertEquals(waiting.status, 200)
    const waitingBody = (await waiting.json()) as CertificateBody
    assertEquals(waitingBody.certificate?.state, 'waiting_for_dns')
    assertEquals(waitingBody.certificate?.dns?.ready, false)
    assertEquals(waitingBody.needsDeploy, false)
    const [unpinned] = await f.db
      .select({ tlsId: hosting.tlsId })
      .from(hosting)
      .where(eq(hosting.id, f.hostingId))
    assertEquals(unpinned?.tlsId, null)

    const check = await f.call('GET', `/hostings/${f.hostingId}/dns-check`)
    assertEquals(
      ((await check.json()) as { dns: { hostnames: unknown[] } }).dns.hostnames.length,
      2
    )

    // DNS still not ready: the sweep keeps the request.
    const still = await runHostingLetsEncryptSweepTick(f.db, { lookup: nowhere })
    assertEquals(still.pinned, 0)

    const sweep = await runHostingLetsEncryptSweepTick(f.db, { lookup: pointing })
    assertEquals(sweep.pinned, 1)
    const [pinned] = await f.db
      .select({ tlsId: hosting.tlsId, options: hosting.options })
      .from(hosting)
      .where(eq(hosting.id, f.hostingId))
    assertEquals(typeof pinned?.tlsId, 'string')
    assertEquals((pinned?.options as { wwwRedirect?: boolean }).wwwRedirect, true)

    const got = await f.call('GET', `/hostings/${f.hostingId}`)
    const body = (await got.json()) as {
      hosting: { certificate: { state: string; needsDeploy: boolean; wwwRedirect: boolean } }
    }
    assertEquals(body.hosting.certificate.state, 'issuing')
    assertEquals(body.hosting.certificate.needsDeploy, true)
    assertEquals(body.hosting.certificate.wwwRedirect, true)
  } finally {
    await f.cleanup()
  }
})

test('PUT use-letsencrypt: refuses "also redirect www" when the twin name is already a domain', async () => {
  if (!dbUrl) return skipWithoutDatabase("hosting Let's Encrypt route tests")
  const f = await setup({
    acmeEnabled: true,
    hostingOptions: { hostnames: ['example.com', 'www.example.com'] },
  })
  try {
    const res = await f.call('PUT', `/hostings/${f.hostingId}/use-letsencrypt`, {
      wwwRedirect: true,
    })
    assertEquals(res.status, 400)
    const body = (await res.json()) as { error: string; message: string }
    assertEquals(body.error, 'www_redirect_conflict')
    assertEquals(body.message.includes('www.example.com'), true)
    const rows = await f.db
      .select({ id: tls.id })
      .from(tls)
      .where(eq(tls.organizationId, f.organizationId))
    assertEquals(rows.length, 0)

    const without = await f.call('PUT', `/hostings/${f.hostingId}/use-letsencrypt`, {
      wwwRedirect: false,
    })
    assertEquals(without.status, 200)
  } finally {
    await f.cleanup()
  }
})

test('PUT use-letsencrypt: refuses "also redirect www" when another hosting in the environment serves the twin', async () => {
  if (!dbUrl) return skipWithoutDatabase("hosting Let's Encrypt route tests")
  const f = await setup({ acmeEnabled: true, hostingOptions: PUBLIC_SITE })
  const [own] = await f.db
    .select({ serviceId: hosting.serviceId })
    .from(hosting)
    .where(eq(hosting.id, f.hostingId))
  const now = new Date().toISOString()
  const [other] = await f.db
    .insert(hosting)
    .values({
      serviceId: own!.serviceId,
      name: 'Other',
      options: { hostnames: ['www.shop.example.com'] },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: hosting.id })
  try {
    const res = await f.call('PUT', `/hostings/${f.hostingId}/use-letsencrypt`, {
      wwwRedirect: true,
    })
    assertEquals(res.status, 400)
    assertEquals(((await res.json()) as { error: string }).error, 'www_redirect_conflict')
  } finally {
    await f.db.delete(hosting).where(eq(hosting.id, other!.id))
    await f.cleanup()
  }
})

test('PUT use-letsencrypt: pins at once when DNS is ready, and a second click adds nothing', async () => {
  if (!dbUrl) return skipWithoutDatabase("hosting Let's Encrypt route tests")
  const f = await setup({ acmeEnabled: true, hostingOptions: PUBLIC_SITE })
  try {
    const first = await f.call('PUT', `/hostings/${f.hostingId}/use-letsencrypt`, {})
    assertEquals(first.status, 200)
    const firstBody = (await first.json()) as CertificateBody
    assertEquals(firstBody.certificate?.state, 'issuing')
    assertEquals(firstBody.needsDeploy, true)

    await f.call('PUT', `/hostings/${f.hostingId}/use-letsencrypt`, {})
    const rows = await f.db
      .select({ id: tls.id, source: tls.source, status: tls.status })
      .from(tls)
      .where(eq(tls.organizationId, f.organizationId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.source, 'lets_encrypt')
    assertEquals(rows[0]?.status, 'managed')

    // The daemon reports a failure: the same row now reads as renewal failed.
    await f.db
      .update(tls)
      .set({
        metadata: {
          dnsNames: ['shop.example.com'],
          acme: { managedBy: 'caddy', lastError: 'HTTP 404 on challenge' },
        },
      })
      .where(
        inArray(
          tls.id,
          rows.map((r) => r.id)
        )
      )
    const got = await f.call('GET', `/hostings/${f.hostingId}`)
    const body = (await got.json()) as {
      hosting: { certificate: { state: string; lastError: string } }
    }
    assertEquals(body.hosting.certificate.state, 'renewal_failed')
    assertEquals(body.hosting.certificate.lastError, 'HTTP 404 on challenge')

    const list = await f.call('GET', '/hostings')
    const listBody = (await list.json()) as {
      hostings: { certificate: { state: string } | null }[]
    }
    assertEquals(listBody.hostings[0]?.certificate?.state, 'renewal_failed')
  } finally {
    await f.cleanup()
  }
})
