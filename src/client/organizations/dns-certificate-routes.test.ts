/**
 * The DNS-certificate routes against a real database. The control plane no
 * longer orders these certificates: starting, checking and retrying an order
 * are refused for every signed-in caller, and the list still shows the
 * certificates already made, for owners and managers of the organization only,
 * with nothing private. Skips
 * without TURBOPANEL_DATABASE_URL.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { audit, carrier, grant, organization, tls, user } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { startDnsCertificate } from '../../features/tls/dns-certificates/issuance.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { toPublicTlsRow } from '../tls/routes-helpers.ts'
import { buildDnsCertContext } from '../tls/dns-certificate-context.ts'
import {
  ORDERING_OFF_ERROR,
  ORDERING_OFF_MESSAGE,
  registerOrganizationDnsCertificateRoutes,
} from './dns-certificate-routes.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>
type Called = { status: number; text: string; body: Record<string, unknown> }

const ACCOUNT = 'a'.repeat(32)

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  carrierId: string
  managerCookie: string
  memberCookie: string
  otherManagerCookie: string
  /** A certificate made before ordering was turned off, in organization A. */
  certificateId: string
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

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('dns certificate route tests')
    return
  }
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
  registerOrganizationDnsCertificateRoutes(app, {
    secrets: sessionSecrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  const orgs = await db
    .insert(organization)
    .values([
      { name: 'Dns Org A', isAcmeEnabled: true },
      { name: 'Dns Org B', isAcmeEnabled: true },
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
    const started = await startDnsCertificate(buildDnsCertContext(db, { secrets }), {
      organizationId: orgA,
      carrierId: c!.id,
      names: ['a.example.com'],
      zones: [{ id: 'z1', name: 'example.com' }],
      staging: true,
    })
    assertEquals(started.kind, 'created')
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
      certificateId: (started as { id: string }).id,
    })
  } finally {
    await db.delete(tls).where(inArray(tls.organizationId, [orgA, orgB]))
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

const orderPaths = (f: Fixture, orgId: string) => [
  `/organizations/${orgId}/dns-certificates`,
  `/organizations/${orgId}/dns-certificates/${f.certificateId}/check`,
  `/organizations/${orgId}/dns-certificates/${f.certificateId}/retry`,
]

test('every route needs a session, and the list is for the organization’s owners and managers only', () =>
  withFixture(async (f) => {
    const list = `/organizations/${f.orgA}/dns-certificates`
    for (const path of [list, ...orderPaths(f, f.orgA)]) {
      for (const method of path === list ? ['GET', 'POST'] : ['POST']) {
        assertEquals((await call(f, method, path, null, {})).status, 401, `${method} ${path}`)
      }
    }
    assertEquals((await call(f, 'GET', list, f.memberCookie)).status, 403)
    assertEquals((await call(f, 'GET', list, f.otherManagerCookie)).status, 403)
  }))

test('starting, checking and retrying an order are refused in plain words and change nothing', () =>
  withFixture(async (f) => {
    const [before] = await f.db.select().from(tls).where(eq(tls.id, f.certificateId))
    for (const cookie of [f.managerCookie, f.memberCookie, f.otherManagerCookie]) {
      for (const path of orderPaths(f, f.orgA)) {
        const refused = await call(f, 'POST', path, cookie, {
          carrierId: f.carrierId,
          names: ['b.example.com'],
        })
        assertEquals(
          [refused.status, refused.body.error, refused.body.message],
          [422, ORDERING_OFF_ERROR, ORDERING_OFF_MESSAGE],
          path
        )
      }
    }
    const rows = await f.db.select().from(tls).where(eq(tls.organizationId, f.orgA))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]!.metadata, before!.metadata)
    assertEquals(
      (await f.db.select().from(audit).where(eq(audit.organizationId, f.orgA))).length,
      0
    )
  }))

test('the list still shows a certificate made earlier and shows nothing private', () =>
  withFixture(async (f) => {
    const path = `/organizations/${f.orgA}/dns-certificates`
    const listed = await call(f, 'GET', path, f.managerCookie)
    assertEquals(listed.status, 200, listed.text)
    const certificates = listed.body.certificates as Record<string, unknown>[]
    assertEquals(certificates.length, 1)
    const shown = certificates[0]!
    assertEquals(
      [shown.id, shown.names, shown.warning, shown.renewAt, shown.nextAttemptAt],
      // An order left open is not said to keep working; the issued case is in the host-free test.
      [f.certificateId, ['a.example.com'], null, null, null]
    )
    for (const secretWord of ['accountKey', 'dnsCert', 'pendingKey', 'privateKey', 'BEGIN']) {
      assert(!listed.text.includes(secretWord), secretWord)
    }
    // The generic library view of the row carries no private state either.
    const [row] = await f.db.select().from(tls).where(eq(tls.id, f.certificateId))
    const library = JSON.stringify(toPublicTlsRow(row as never))
    assertStringIncludes(library, 'dns-01')
    assert(
      !library.includes('accountKey') &&
        !library.includes('dnsCert') &&
        !library.includes('records')
    )
    // Another organization sees none of it.
    const other = await call(
      f,
      'GET',
      `/organizations/${f.orgB}/dns-certificates`,
      f.otherManagerCookie
    )
    assertEquals(other.body.certificates, [])
  }))
