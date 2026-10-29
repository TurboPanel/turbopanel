/**
 * The DNS-certificate routes against a real database, an in-memory authority
 * and a faked DNS host: owners and managers only, the organization's Let's
 * Encrypt switch, names and zones checked first, an order that is started,
 * carried on and reused, and nothing private in a response. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { audit, badge, carrier, grant, organization, secret, tls, user } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createFakeCa } from '../../lib/acme/fake-ca.test.support.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { parseOptionalTlsId } from '../hostings/routes-helpers.ts'
import { toPublicTlsRow } from '../tls/routes-helpers.ts'
import { registerOrganizationDnsCertificateRoutes } from './dns-certificate-routes.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>
type Called = { status: number; text: string; body: Record<string, unknown> }

const ACCOUNT = 'a'.repeat(32)
const TOKEN = 'cf-dns-token-0123456789abcdefghijklmnopqrstuv'

/** A DNS host that holds TXT records and answers the zone lookups. */
function fakeProvider() {
  const records = new Map<string, { name: string; content: string }>()
  let n = 0
  const handler: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/client/v4', '')
    const method = init?.method ?? 'GET'
    const ok = (result: unknown) => Promise.resolve(Response.json({ success: true, result }))
    if (path === '/zones') return ok([{ id: 'z1', name: 'example.com', account: { id: ACCOUNT } }])
    if (path === '/zones/z1/dns_records' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string; content: string }
      n += 1
      records.set(`rec${n}`, body)
      return ok({ id: `rec${n}` })
    }
    if (path.startsWith('/zones/z1/dns_records/') && method === 'DELETE') {
      records.delete(path.split('/').pop()!)
      return ok({ id: 'gone' })
    }
    if (path === '/zones/z1/dns_records') {
      // A TXT read-back lists the records at the name, as the real host does.
      const name = url.searchParams.get('name')
      const wanted = url.searchParams.get('type') === 'TXT' && name
      return ok(wanted ? [...records.values()].filter((r) => r.name === name) : [])
    }
    return Promise.resolve(
      Response.json({ success: false, errors: [{ message: 'nope' }] }, { status: 404 })
    )
  }
  const txt = (name: string) =>
    [...records.values()].filter((r) => r.name === name).map((r) => r.content)
  return { handler, records, txt }
}

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  carrierId: string
  managerCookie: string
  memberCookie: string
  otherManagerCookie: string
  provider: ReturnType<typeof fakeProvider>
}

async function insertUser(db: Db, organizationId: string, permission: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({ email: `dc-${crypto.randomUUID()}@example.com`, isEmailVerified: true, role: 'user' })
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
  options: { acmeEnabled?: boolean; badge?: boolean },
  fn: (f: Fixture) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('dns certificate route tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const sessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const secrets = await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')
  const provider = fakeProvider()
  const ca = createFakeCa({ txt: provider.txt })
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', secrets)
    return next()
  })
  registerOrganizationDnsCertificateRoutes(
    app,
    { secrets: sessionSecrets, runtime: 'deno', signupEnvOverride: undefined },
    { fetch: provider.handler, acmeFetch: ca.fetch, presentGraceMs: 0 }
  )
  const orgs = await db
    .insert(organization)
    .values([
      { name: 'Dns Org A', options: { acmeEnabled: options.acmeEnabled ?? true } },
      { name: 'Dns Org B', options: { acmeEnabled: true } },
    ])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]
  const userIds: string[] = []
  try {
    const [c] = await db
      .insert(carrier)
      .values({
        organizationId: orgA,
        provider: 'cloudflare',
        name: 'Main',
        externalAccountId: ACCOUNT,
      })
      .returning({ id: carrier.id })
    if (options.badge !== false) {
      const [stored] = await db
        .insert(secret)
        .values({
          organizationId: orgA,
          provider: 'carrier_badge',
          name: 'token',
          secretEnvelope: await encryptSecret(secrets, TOKEN),
        })
        .returning({ id: secret.id })
      await db.insert(badge).values({
        carrierId: c!.id,
        secretId: stored!.id,
        label: 'dns',
        lastFour: TOKEN.slice(-4),
        capabilities: {
          tunnels: false,
          dns: [{ id: 'z1', name: 'example.com' }],
          certificates: [],
        },
      })
    }
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
    await fn({
      db,
      app,
      orgA,
      orgB,
      carrierId: c!.id,
      managerCookie: await cookie(ids.manager),
      memberCookie: await cookie(ids.member),
      otherManagerCookie: await cookie(ids.otherManager),
      provider,
    })
  } finally {
    await db.delete(audit).where(inArray(audit.organizationId, [orgA, orgB]))
    await db.delete(organization).where(inArray(organization.id, [orgA, orgB]))
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('every route refuses a request without a session, a read-only member and another organization', () =>
  withFixture({}, async (f) => {
    const id = crypto.randomUUID()
    const paths: [string, string][] = [
      ['GET', `/organizations/${f.orgA}/dns-certificates`],
      ['POST', `/organizations/${f.orgA}/dns-certificates`],
      ['POST', `/organizations/${f.orgA}/dns-certificates/${id}/check`],
      ['POST', `/organizations/${f.orgA}/dns-certificates/${id}/retry`],
    ]
    for (const [method, path] of paths) {
      assertEquals((await call(f, method, path, null, {})).status, 401, `${method} ${path}`)
      assertEquals(
        (await call(f, method, path, f.memberCookie, {})).status,
        403,
        `${method} ${path}`
      )
      assertEquals(
        (await call(f, method, path, f.otherManagerCookie, {})).status,
        403,
        `${method} ${path}`
      )
    }
  }))

test('names, the account and the organization’s Let’s Encrypt switch are checked before anything starts', () =>
  withFixture({ acmeEnabled: false }, async (f) => {
    const path = `/organizations/${f.orgA}/dns-certificates`
    assertEquals(
      (
        await call(f, 'POST', path, f.managerCookie, {
          carrierId: f.carrierId,
          names: ['bad name'],
        })
      ).body.error,
      'names_invalid'
    )
    assertEquals(
      (await call(f, 'POST', path, f.managerCookie, { names: ['a.example.com'] })).body.error,
      'carrier_invalid'
    )
    const off = await call(f, 'POST', path, f.managerCookie, {
      carrierId: f.carrierId,
      names: ['a.example.com'],
    })
    assertEquals([off.status, off.body.error], [403, 'lets_encrypt_not_enabled'])
    assertEquals((await f.db.select().from(tls).where(eq(tls.organizationId, f.orgA))).length, 0)
  }))

test('a name outside the zones the tokens edit, and an account with no DNS token, are refused in plain words', () =>
  withFixture({}, async (f) => {
    const path = `/organizations/${f.orgA}/dns-certificates`
    const elsewhere = await call(f, 'POST', path, f.managerCookie, {
      carrierId: f.carrierId,
      names: ['a.elsewhere.net'],
    })
    assertEquals([elsewhere.status, elsewhere.body.error], [400, 'zone_not_found'])
    assertEquals(elsewhere.body.hostnames, ['a.elsewhere.net'])
  }))

test('an account without a DNS token cannot start an order', () =>
  withFixture({ badge: false }, async (f) => {
    const none = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/dns-certificates`,
      f.managerCookie,
      {
        carrierId: f.carrierId,
        names: ['a.example.com'],
      }
    )
    assertEquals([none.status, none.body.error], [400, 'no_dns_token'])
  }))

test('an order is started, carried on, finished, reused, and never shows anything private', () =>
  withFixture({}, async (f) => {
    const path = `/organizations/${f.orgA}/dns-certificates`
    const started = await call(f, 'POST', path, f.managerCookie, {
      carrierId: f.carrierId,
      names: ['example.com', '*.example.com'],
      staging: true,
    })
    assertEquals(started.status, 201, started.text)
    const created = started.body.certificate as {
      id: string
      status: string
      names: string[]
      staging: boolean
    }
    assertEquals(
      [created.status, created.staging, created.names],
      ['pending', true, ['example.com', '*.example.com']]
    )

    // The first steps run after the answer; "check now" carries the rest.
    let latest = created as Record<string, unknown>
    for (let i = 0; i < 40 && latest.status !== 'ready'; i += 1) {
      await pause(25)
      const checked = await call(f, 'POST', `${path}/${created.id}/check`, f.managerCookie)
      assertEquals(checked.status, 200, checked.text)
      latest = checked.body.certificate as Record<string, unknown>
    }
    assertEquals(latest.status, 'ready')
    assertEquals(latest.wildcard, true)
    assert(typeof latest.notAfter === 'string')
    assertEquals(f.provider.records.size, 0)

    const listed = await call(f, 'GET', path, f.managerCookie)
    assertEquals((listed.body.certificates as unknown[]).length, 1)
    for (const text of [started.text, listed.text]) {
      assert(!text.includes(TOKEN))
      for (const secretWord of ['accountKey', 'dnsCert', 'pendingKey', 'privateKey', 'BEGIN']) {
        assert(!text.includes(secretWord), secretWord)
      }
    }

    // The same names again reuse the certificate; a covered name does too.
    const again = await call(f, 'POST', path, f.managerCookie, {
      carrierId: f.carrierId,
      names: ['www.example.com'],
      staging: true,
    })
    assertEquals([again.status, again.body.reused], [200, true])
    assertEquals((again.body.certificate as { id: string }).id, created.id)

    // The generic library view of the row carries no private state either.
    const [row] = await f.db.select().from(tls).where(eq(tls.id, created.id))
    const shown = JSON.stringify(toPublicTlsRow(row as never))
    assertStringIncludes(shown, 'dns-01')
    assert(
      !shown.includes('accountKey') && !shown.includes('dnsCert') && !shown.includes('records')
    )

    // A Test Certificate is named so, and cannot be pinned to a site.
    assertStringIncludes(row!.name ?? '', 'Test Certificate')
    const jsonContext = { json: (b: unknown, status?: number) => Response.json(b, { status }) }
    const pinned = await parseOptionalTlsId(jsonContext as never, f.db, f.orgA, created.id)
    assertEquals(pinned.kind, 'error')
    if (pinned.kind === 'error') {
      assertEquals(pinned.response.status, 400)
      assertEquals(((await pinned.response.json()) as { error: string }).error, 'tls_pin_staging')
    }

    // Retry is for a certificate that gave up.
    assertEquals(
      (await call(f, 'POST', `${path}/${created.id}/retry`, f.managerCookie)).status,
      409
    )
  }))

test('another organization cannot see or move on a certificate', () =>
  withFixture({}, async (f) => {
    const path = `/organizations/${f.orgA}/dns-certificates`
    const started = await call(f, 'POST', path, f.managerCookie, {
      carrierId: f.carrierId,
      names: ['a.example.com'],
      staging: true,
    })
    const id = (started.body.certificate as { id: string }).id
    const other = `/organizations/${f.orgB}/dns-certificates`
    assertEquals((await call(f, 'GET', other, f.otherManagerCookie)).body.certificates, [])
    assertEquals((await call(f, 'POST', `${other}/${id}/check`, f.otherManagerCookie)).status, 404)
    assertEquals((await call(f, 'POST', `${other}/${id}/retry`, f.otherManagerCookie)).status, 404)
  }))
