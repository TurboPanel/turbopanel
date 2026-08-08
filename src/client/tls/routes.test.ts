import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../authn/secrets.ts'
import { grant, member, organization, tls, user } from '../../lib/db/schema.ts'
import { mintSelfSignedCertificate } from '../../lib/tls/index.ts'
import type { TlsMetadata } from '../../lib/tls/types.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerTlsRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function createTlsTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerTlsRoutes(app, { secrets, runtime: 'deno' })
  return { app, secrets }
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

async function withTlsFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping tls route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets } = await createTlsTestApp(db)

  const [orgRow] = await db
    .insert(organization)
    .values({ name: 'TLS Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = orgRow!.id

  const [userRow] = await db
    .insert(user)
    .values({
      email: `tls-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = userRow!.id

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:own',
    allow: true,
  })

  try {
    await fn({ db, app, secrets, userId, organizationId })
  } finally {
    await db.delete(tls).where(eq(tls.organizationId, organizationId))
    await db.delete(grant).where(eq(grant.actorId, userId))
    await db.delete(member).where(eq(member.userId, userId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('POST /tls lets_encrypt pending cert appears in list and detail with empty fingerprint', async () => {
  await withTlsFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    }

    const createRes = await app.request('/tls', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'lets_encrypt',
        name: 'Pending LE',
        hostnames: ['pending.example.com'],
        challengeType: 'http-01',
      }),
    })
    assertEquals(createRes.status, 200)
    const created = await createRes.json() as { ok: true; id: string }
    assertEquals(created.ok, true)

    const [row] = await db
      .select({ fingerprintSha256: tls.fingerprintSha256 })
      .from(tls)
      .where(eq(tls.id, created.id))
      .limit(1)
    assertEquals(row?.fingerprintSha256, null)

    const listRes = await app.request('/tls', { headers })
    assertEquals(listRes.status, 200)
    const listBody = await listRes.json() as {
      tls: Array<{ id: string; metadata: TlsMetadata }>
    }
    const listed = listBody.tls.find((entry) => entry.id === created.id)
    assertEquals(listed !== undefined, true)
    assertEquals(listed?.metadata.status, 'pending')
    assertEquals(listed?.metadata.fingerprintSha256, '')
    assertEquals(listed?.metadata.dnsNames, ['pending.example.com'])
    assertEquals(listed?.metadata.acme?.challengeType, 'http-01')

    const detailRes = await app.request(`/tls/${created.id}`, { headers })
    assertEquals(detailRes.status, 200)
    const detailBody = await detailRes.json() as { tls: { metadata: TlsMetadata } }
    assertEquals(detailBody.tls.metadata.status, 'pending')
    assertEquals(detailBody.tls.metadata.fingerprintSha256, '')
    assertEquals(detailBody.tls.metadata.dnsNames, ['pending.example.com'])
  })
})

test('POST /tls returns 409 tls_fingerprint_conflict for duplicate fingerprint', async () => {
  await withTlsFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      cookie,
      [ORG_ID_HEADER]: organizationId,
      'content-type': 'application/json',
    }

    const material = await mintSelfSignedCertificate(['dup.example.com'])
    const body = JSON.stringify({
      source: 'upload',
      name: 'Dup fingerprint',
      certificatePem: material.certificatePem,
      privateKeyPem: material.privateKeyPem,
    })

    const first = await app.request('/tls', { method: 'POST', headers, body })
    assertEquals(first.status, 200)

    const second = await app.request('/tls', { method: 'POST', headers, body })
    assertEquals(second.status, 409)
    const conflict = await second.json() as { error: string }
    assertEquals(conflict.error, 'tls_fingerprint_conflict')
  })
})
