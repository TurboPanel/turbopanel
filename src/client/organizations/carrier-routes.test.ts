/**
 * Tunnel provider account and token routes against a real database: owners
 * and managers only, a token is checked with the (faked) provider, sealed in
 * `secret`, and never appears in a response, an audit row or a tunnel table.
 * Skips without TURBOPANEL_DATABASE_URL.
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
import {
  audit,
  badge,
  carrier,
  grant,
  organization,
  secret,
  tunnel,
  user,
} from '../../db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { decryptSecret } from '../../lib/secrets/data-encryption.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerOrganizationCarrierRoutes } from './carrier-routes.ts'

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

/** What the faked provider answers; each test sets the mode. */
type Mode = 'good' | 'no-dns' | 'weak' | 'rejected' | 'echo-token'
const state: { mode: Mode } = { mode: 'good' }

const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const refused = (status: number, message: string) =>
  Response.json({ success: false, errors: [{ code: 1, message }] }, { status })

const fakeProvider: typeof fetch = (input) => {
  const path = new URL(String(input)).pathname.replace('/client/v4', '')
  if (state.mode === 'echo-token') {
    return Promise.resolve(refused(500, `internal failure for Bearer ${TOKEN}`))
  }
  if (state.mode === 'rejected') return Promise.resolve(refused(401, `Invalid token ${TOKEN}`))
  if (path === '/accounts') return Promise.resolve(ok([{ id: ACCOUNT, name: 'Main' }]))
  if (path === '/zones') return Promise.resolve(ok([{ id: 'z1', name: 'example.com' }]))
  if (state.mode === 'weak') return Promise.resolve(refused(403, 'Authentication error'))
  if (path.endsWith('/cfd_tunnel')) return Promise.resolve(ok([]))
  if (path.endsWith('/dns_records')) {
    return Promise.resolve(state.mode === 'no-dns' ? refused(403, 'denied') : ok([]))
  }
  return Promise.resolve(refused(404, 'not found'))
}

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  ownerCookie: string
  managerCookie: string
  memberCookie: string
  otherManagerCookie: string
  secrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
}

async function insertUser(db: Db, organizationId: string, permission: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({
      email: `tc-${crypto.randomUUID()}@example.com`,
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
    skipWithoutDatabase('carrier route tests')
    return
  }
  state.mode = 'good'
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
  registerOrganizationCarrierRoutes(
    app,
    { secrets: sessionSecrets, runtime: 'deno', signupEnvOverride: undefined },
    fakeProvider
  )
  const orgs = await db
    .insert(organization)
    .values([{ name: 'Carrier Org A' }, { name: 'Carrier Org B' }])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]
  const userIds: string[] = []
  try {
    const ids = {
      owner: await insertUser(db, orgA, 'organization:own'),
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
      ownerCookie: await cookie(ids.owner),
      managerCookie: await cookie(ids.manager),
      memberCookie: await cookie(ids.member),
      otherManagerCookie: await cookie(ids.otherManager),
      secrets,
    })
  } finally {
    const orgIds = [orgA, orgB]
    await db.delete(audit).where(inArray(audit.organizationId, orgIds))
    // Carriers cascade to badges; the sealed rows go with the organization.
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

async function createCarrier(f: Fixture): Promise<string> {
  const created = await call(f, 'POST', `/organizations/${f.orgA}/carriers`, f.managerCookie, {
    provider: 'cloudflare',
    name: 'Main Account',
    externalAccountId: ACCOUNT,
  })
  assertEquals(created.status, 201, created.text)
  return (created.body.carrier as { id: string }).id
}

test('every carrier route refuses a request without a session', async () => {
  await withFixture(async (f) => {
    const id = crypto.randomUUID()
    for (const [method, path] of [
      ['GET', `/organizations/${f.orgA}/carriers`],
      ['POST', `/organizations/${f.orgA}/carriers`],
      ['DELETE', `/organizations/${f.orgA}/carriers/${id}`],
      ['GET', `/organizations/${f.orgA}/carriers/${id}/badges`],
      ['POST', `/organizations/${f.orgA}/carriers/${id}/badges`],
      ['DELETE', `/organizations/${f.orgA}/carriers/${id}/badges/${id}`],
      ['POST', `/organizations/${f.orgA}/carriers/${id}/badges/${id}/check`],
    ]) {
      assertEquals((await call(f, method!, path!, null, {})).status, 401, `${method} ${path}`)
    }
  })
})

test("a read-only member and another organization's manager are refused", async () => {
  await withFixture(async (f) => {
    for (const cookie of [f.memberCookie, f.otherManagerCookie]) {
      assertEquals((await call(f, 'GET', `/organizations/${f.orgA}/carriers`, cookie)).status, 403)
      const made = await call(f, 'POST', `/organizations/${f.orgA}/carriers`, cookie, {
        provider: 'cloudflare',
        name: 'Nope',
        externalAccountId: ACCOUNT,
      })
      assertEquals(made.status, 403)
    }
    assertEquals(
      (await f.db.select().from(carrier).where(eq(carrier.organizationId, f.orgA))).length,
      0
    )
  })
})

test('a token is checked, sealed in secret, and never comes back in a response, audit row or tunnel table', async () => {
  await withFixture(async (f) => {
    const carrierId = await createCarrier(f)
    const added = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/carriers/${carrierId}/badges`,
      f.ownerCookie,
      { label: 'Main', token: TOKEN }
    )
    assertEquals(added.status, 201, added.text)
    assert(!added.text.includes(TOKEN))
    const shown = added.body.badge as Record<string, unknown>
    assertEquals(shown.lastFour, TOKEN.slice(-4))
    assertEquals(shown.capabilities, { tunnels: true, dns: true, certificates: false })
    assertEquals(added.body.zones, [{ id: 'z1', name: 'example.com' }])

    const listed = await call(f, 'GET', `/organizations/${f.orgA}/carriers`, f.managerCookie)
    assert(!listed.text.includes(TOKEN))
    assertEquals((listed.body.carriers as { status: string }[])[0]!.status, 'active')

    // The token lives only sealed in `secret`; the sealed text round-trips.
    const badges = await f.db.select().from(badge).where(eq(badge.carrierId, carrierId))
    assertEquals(badges.length, 1)
    const [stored] = await f.db.select().from(secret).where(eq(secret.id, badges[0]!.secretId))
    assertEquals(stored!.provider, 'carrier_badge')
    assert(!stored!.secretEnvelope.includes(TOKEN))
    assertEquals(await decryptSecret(f.secrets, stored!.secretEnvelope), TOKEN)

    const rows = JSON.stringify([
      badges,
      await f.db.select().from(carrier).where(eq(carrier.organizationId, f.orgA)),
      await f.db.select().from(audit).where(eq(audit.organizationId, f.orgA)),
    ])
    assert(!rows.includes(TOKEN))
  })
})

test('a token that cannot do anything useful is refused, names the permission and leaves nothing stored', async () => {
  await withFixture(async (f) => {
    const carrierId = await createCarrier(f)
    state.mode = 'weak'
    const weak = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/carriers/${carrierId}/badges`,
      f.managerCookie,
      { label: 'Weak', token: TOKEN }
    )
    assertEquals(weak.status, 400)
    assertEquals(weak.body.error, 'badge_not_useful')
    assertEquals(weak.body.missing, ['Account · Cloudflare Tunnel · Edit', 'Zone · DNS · Edit'])
    assert(!weak.text.includes(TOKEN))

    // A token with only one permission is accepted, with the other named as missing.
    state.mode = 'no-dns'
    const partial = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/carriers/${carrierId}/badges`,
      f.managerCookie,
      { label: 'Partial', token: TOKEN }
    )
    assertEquals(partial.status, 201, partial.text)
    assertEquals(partial.body.missing, ['Zone · DNS · Edit'])
    assertEquals((await f.db.select().from(badge).where(eq(badge.carrierId, carrierId))).length, 1)
  })
})

test('provider failures are reported without the token', async () => {
  await withFixture(async (f) => {
    const carrierId = await createCarrier(f)
    const path = `/organizations/${f.orgA}/carriers/${carrierId}/badges`
    state.mode = 'rejected'
    const rejected = await call(f, 'POST', path, f.managerCookie, { label: 'Bad', token: TOKEN })
    assertEquals(rejected.status, 400)
    assertEquals(rejected.body.error, 'badge_rejected')
    state.mode = 'echo-token'
    const down = await call(f, 'POST', path, f.managerCookie, { label: 'Down', token: TOKEN })
    assertEquals(down.status, 502)
    for (const res of [rejected, down]) assert(!res.text.includes(TOKEN))
    const auditText = JSON.stringify(await f.db.select().from(audit))
    assert(!auditText.includes(TOKEN))
    assertEquals((await f.db.select().from(badge).where(eq(badge.carrierId, carrierId))).length, 0)
  })
})

test('a re-check updates what the token reaches, and removing a badge or carrier deletes the sealed token', async () => {
  await withFixture(async (f) => {
    const carrierId = await createCarrier(f)
    const base = `/organizations/${f.orgA}/carriers/${carrierId}/badges`
    const added = await call(f, 'POST', base, f.managerCookie, { label: 'Main', token: TOKEN })
    const badgeId = (added.body.badge as { id: string }).id
    state.mode = 'no-dns'
    const checked = await call(f, 'POST', `${base}/${badgeId}/check`, f.managerCookie)
    assertEquals(checked.status, 200, checked.text)
    assertEquals(checked.body.ok, true)
    assertEquals((checked.body.badge as { capabilities: unknown }).capabilities, {
      tunnels: true,
      dns: false,
      certificates: false,
    })
    state.mode = 'rejected'
    const lost = await call(f, 'POST', `${base}/${badgeId}/check`, f.managerCookie)
    assertEquals(lost.status, 200)
    assertEquals(lost.body.ok, false)
    assertEquals((lost.body.badge as { status: string }).status, 'attention')
    assert(!lost.text.includes(TOKEN))

    const [row] = await f.db.select().from(badge).where(eq(badge.id, badgeId))
    const removed = await call(f, 'DELETE', `${base}/${badgeId}`, f.managerCookie)
    assertEquals(removed.status, 200)
    assertEquals((await f.db.select().from(secret).where(eq(secret.id, row!.secretId))).length, 0)

    state.mode = 'good'
    const again = await call(f, 'POST', base, f.managerCookie, { label: 'Again', token: TOKEN })
    assertEquals(again.status, 201)
    const [second] = await f.db.select().from(badge).where(eq(badge.carrierId, carrierId))
    const gone = await call(
      f,
      'DELETE',
      `/organizations/${f.orgA}/carriers/${carrierId}`,
      f.managerCookie
    )
    assertEquals(gone.status, 200)
    assertEquals(
      (await f.db.select().from(secret).where(eq(secret.id, second!.secretId))).length,
      0
    )
    assertEquals((await f.db.select().from(carrier).where(eq(carrier.id, carrierId))).length, 0)
  })
})

test('a carrier that still has tunnels is refused with 409 and keeps its tokens; removing the tunnel lets it go', async () => {
  await withFixture(async (f) => {
    const carrierId = await createCarrier(f)
    const base = `/organizations/${f.orgA}/carriers/${carrierId}`
    const added = await call(f, 'POST', `${base}/badges`, f.managerCookie, {
      label: 'Main',
      token: TOKEN,
    })
    assertEquals(added.status, 201, added.text)
    const [row] = await f.db.select().from(badge).where(eq(badge.carrierId, carrierId))
    const [t] = await f.db
      .insert(tunnel)
      .values({
        organizationId: f.orgA,
        routingOrganizationId: f.orgA,
        carrierId,
        provider: 'cloudflare',
        name: 'web',
      })
      .returning({ id: tunnel.id })
    const refused = await call(f, 'DELETE', base, f.managerCookie)
    assertEquals(refused.status, 409)
    assertEquals(refused.body.error, 'carrier_in_use')
    assertEquals((await f.db.select().from(secret).where(eq(secret.id, row!.secretId))).length, 1)
    await f.db.delete(tunnel).where(eq(tunnel.id, t!.id))
    assertEquals((await call(f, 'DELETE', base, f.managerCookie)).status, 200)
    assertEquals((await f.db.select().from(secret).where(eq(secret.id, row!.secretId))).length, 0)
  })
})
