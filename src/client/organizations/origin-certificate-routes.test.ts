/**
 * Origin certificate routes against a real database and a faked provider:
 * owners and managers only, one healthy certificate per zone, a token added
 * before certificate rights were recorded is checked once, no key ever leaves
 * the server, and an account or token that issued a certificate cannot be
 * removed first. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { audit, badge, carrier, grant, organization, secret, tls, user } from '../../db/schema.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { mintSelfSignedCertificate } from '../../lib/tls/index.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerOrganizationCarrierRoutes } from './carrier-routes.ts'
import { registerOrganizationOriginCertificateRoutes } from './origin-certificate-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>
type Called = { status: number; text: string; body: Record<string, unknown> }

const TOKEN = 'cf-api-token-0123456789abcdefghijklmnopqrstuv'
const ACCOUNT = 'a'.repeat(32)

/** What the faked provider answers for the certificate list. */
const state: { certificates: 'allowed' | 'denied'; issued: number; revoked: string[] } = {
  certificates: 'allowed',
  issued: 0,
  revoked: [],
}

const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const refused = (status: number, message: string) =>
  Response.json({ success: false, errors: [{ code: 1, message }] }, { status })

const fakeProvider: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  const path = url.pathname.replace('/client/v4', '')
  const method = init?.method ?? 'GET'
  if (path === '/accounts') return ok([{ id: ACCOUNT, name: 'Main' }])
  if (path === '/zones') return ok([{ id: 'z1', name: 'example.com' }])
  if (path === '/user/tokens/verify') return ok({ id: 'tok-1', status: 'active' })
  if (path.endsWith('/cfd_tunnel') || path.endsWith('/dns_records')) return ok([])
  if (path === '/certificates' && method === 'GET') {
    return state.certificates === 'allowed' ? ok([]) : refused(403, 'denied')
  }
  if (path === '/certificates' && method === 'POST') {
    const body = JSON.parse(String(init?.body)) as { hostnames: string[] }
    state.issued += 1
    const minted = await mintSelfSignedCertificate(body.hostnames, { validDays: 365 })
    return ok({
      id: `cert-${state.issued}`,
      certificate: minted.certificatePem,
      expires_on: minted.parsed.notAfter
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ' +0000 UTC'),
    })
  }
  if (path.startsWith('/certificates/') && method === 'DELETE') {
    state.revoked.push(path.slice('/certificates/'.length))
    return ok({ id: path.slice('/certificates/'.length) })
  }
  return refused(404, 'not found')
}

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  managerCookie: string
  memberCookie: string
  otherManagerCookie: string
  orgB: string
  carrierId: string
  badgeId: string
}

async function insertUser(db: Db, organizationId: string, permission: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({ email: `oc-${crypto.randomUUID()}@example.com`, isEmailVerified: true, role: 'user' })
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

async function withFixture(
  fn: (f: Fixture) => Promise<void>,
  options: { certificateRights?: boolean } = {}
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('origin certificate route tests')
    return
  }
  state.certificates = 'allowed'
  state.issued = 0
  state.revoked = []
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const sessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const secrets = await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', secrets)
    return next()
  })
  const routeOpts = {
    secrets: sessionSecrets,
    runtime: 'deno' as const,
    signupEnvOverride: undefined,
  }
  registerOrganizationCarrierRoutes(app, routeOpts, fakeProvider)
  registerOrganizationOriginCertificateRoutes(app, routeOpts, fakeProvider)
  const orgs = await db
    .insert(organization)
    .values([{ name: 'Origin Route Org A' }, { name: 'Origin Route Org B' }])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]
  const userIds: string[] = []
  try {
    const ids = {
      manager: await insertUser(db, orgA, 'organization:manage'),
      member: await insertUser(db, orgA, 'organization:read'),
      otherManager: await insertUser(db, orgB, 'organization:manage'),
    }
    userIds.push(...Object.values(ids))
    const cookie = async (userId: string) => {
      const { token } = await createSession(db, userId, {})
      return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, sessionSecrets)}`
    }
    const [c] = await db
      .insert(carrier)
      .values({
        organizationId: orgA,
        provider: 'cloudflare',
        name: 'Main',
        externalAccountId: ACCOUNT,
      })
      .returning({ id: carrier.id })
    const [sec] = await db
      .insert(secret)
      .values({
        organizationId: orgA,
        provider: 'carrier_badge',
        name: 'token',
        secretEnvelope: await encryptSecret(secrets, TOKEN),
      })
      .returning({ id: secret.id })
    const rights = options.certificateRights !== false
    const [b] = await db
      .insert(badge)
      .values({
        carrierId: c!.id,
        secretId: sec!.id,
        label: 'Main',
        lastFour: TOKEN.slice(-4),
        capabilities: {
          tunnels: true,
          dns: [],
          certificates: rights ? [{ id: 'z1', name: 'example.com' }] : [],
        },
      })
      .returning({ id: badge.id })
    await fn({
      db,
      app,
      orgA,
      orgB,
      carrierId: c!.id,
      badgeId: b!.id,
      managerCookie: await cookie(ids.manager),
      memberCookie: await cookie(ids.member),
      otherManagerCookie: await cookie(ids.otherManager),
    })
  } finally {
    const orgIds = [orgA, orgB]
    await db.delete(audit).where(inArray(audit.organizationId, orgIds))
    await db.delete(tls).where(inArray(tls.organizationId, orgIds))
    await db.delete(organization).where(inArray(organization.id, orgIds))
    if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds))
    await endDbConnection(db)
  }
}

async function call(
  f: Fixture,
  method: string,
  path: string,
  cookie: string | null,
  body?: unknown
): Promise<Called> {
  const res = await f.app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      [ORG_ID_HEADER]: cookie === f.otherManagerCookie ? f.orgB : f.orgA,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return {
    status: res.status,
    text,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  }
}

const base = (f: Fixture) => `/organizations/${f.orgA}/carriers/${f.carrierId}/origin-certificates`

test('every origin certificate route refuses a request without a session, a plain member and another organization', async () => {
  await withFixture(async (f) => {
    const id = crypto.randomUUID()
    const routes: [string, string][] = [
      ['GET', base(f)],
      ['POST', base(f)],
      ['DELETE', `${base(f)}/${id}`],
    ]
    for (const [method, path] of routes) {
      assertEquals((await call(f, method, path, null, {})).status, 401, `${method} ${path}`)
      assertEquals(
        (await call(f, method, path, f.memberCookie, { zone: 'example.com' })).status,
        403
      )
      const other = await call(f, method, path, f.otherManagerCookie, { zone: 'example.com' })
      assert(other.status === 403 || other.status === 404, `${method} other org: ${other.status}`)
    }
  })
})

test('a manager gets a certificate for a zone, asking again returns it, and it can be revoked', async () => {
  await withFixture(async (f) => {
    const first = await call(f, 'POST', base(f), f.managerCookie, { zone: ' Example.com ' })
    assertEquals(first.status, 201, first.text)
    const cert = first.body.originCertificate as Record<string, unknown>
    assertEquals(cert.zone, 'example.com')
    assertEquals(cert.names, ['example.com', '*.example.com'])
    assertEquals(cert.inUse, false)
    assertEquals(first.body.reused, false)
    // Nothing that looks like a key or the token is returned.
    assert(!first.text.includes('PRIVATE KEY') && !first.text.includes(TOKEN))
    assertEquals(
      Object.keys(cert).some((k) => /key|pem|secret/i.test(k)),
      false
    )

    const again = await call(f, 'POST', base(f), f.managerCookie, { zone: 'example.com' })
    assertEquals(again.status, 200)
    assertEquals(again.body.reused, true)
    assertEquals(state.issued, 1)

    const list = await call(f, 'GET', base(f), f.managerCookie)
    assertEquals((list.body.originCertificates as unknown[]).length, 1)

    const removed = await call(f, 'DELETE', `${base(f)}/${cert.id}`, f.managerCookie)
    assertEquals(removed.status, 200, removed.text)
    assertEquals(state.revoked, ['cert-1'])
    assertEquals(
      ((await call(f, 'GET', base(f), f.managerCookie)).body.originCertificates as unknown[])
        .length,
      0
    )
    assertEquals((await call(f, 'DELETE', `${base(f)}/${cert.id}`, f.managerCookie)).status, 404)
  })
})

test('a token with no certificate rights recorded is checked once and then used', async () => {
  await withFixture(
    async (f) => {
      const res = await call(f, 'POST', base(f), f.managerCookie, { zone: 'example.com' })
      assertEquals(res.status, 201, res.text)
      const [row] = await f.db.select().from(badge).where(eq(badge.id, f.badgeId))
      assertEquals(
        (row!.capabilities as { certificates: { name: string }[] }).certificates.map((z) => z.name),
        ['example.com']
      )
    },
    { certificateRights: false }
  )
})

test('with no token that can manage certificates for the zone nothing is issued', async () => {
  await withFixture(
    async (f) => {
      state.certificates = 'denied'
      const res = await call(f, 'POST', base(f), f.managerCookie, { zone: 'example.com' })
      assertEquals(res.status, 400)
      assertEquals(res.body.error, 'badge_cannot_certify')
      assertEquals(state.issued, 0)
    },
    { certificateRights: false }
  )
})

test('a zone that is not a domain name is refused', async () => {
  await withFixture(async (f) => {
    for (const zone of ['', 'localhost', 'bad zone.com', 42, 'a'.repeat(300) + '.com']) {
      const res = await call(f, 'POST', base(f), f.managerCookie, { zone })
      assertEquals(res.status, 400, String(zone))
      assertEquals(res.body.error, 'origin_certificate_invalid')
    }
    assertEquals(state.issued, 0)
  })
})

test('an account or token that issued a certificate cannot be removed until the certificate is', async () => {
  await withFixture(async (f) => {
    const issued = await call(f, 'POST', base(f), f.managerCookie, { zone: 'example.com' })
    assertEquals(issued.status, 201, issued.text)
    const id = (issued.body.originCertificate as { id: string }).id
    const carrierPath = `/organizations/${f.orgA}/carriers/${f.carrierId}`
    const badgeRes = await call(f, 'DELETE', `${carrierPath}/badges/${f.badgeId}`, f.managerCookie)
    assertEquals(badgeRes.status, 409)
    assertEquals(badgeRes.body.error, 'origin_certificate_in_use')
    const carrierRes = await call(f, 'DELETE', carrierPath, f.managerCookie)
    assertEquals(carrierRes.status, 409)
    assertEquals(carrierRes.body.error, 'origin_certificate_in_use')
    assertEquals((await call(f, 'DELETE', `${base(f)}/${id}`, f.managerCookie)).status, 200)
    assertEquals(
      (await call(f, 'DELETE', `${carrierPath}/badges/${f.badgeId}`, f.managerCookie)).status,
      200
    )
    assertEquals((await call(f, 'DELETE', carrierPath, f.managerCookie)).status, 200)
    assertEquals((await f.db.select().from(carrier).where(eq(carrier.id, f.carrierId))).length, 0)
  })
})
