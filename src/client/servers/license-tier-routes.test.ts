/**
 * `PUT /servers/:id/license-tier` against a real database: an organization
 * owner puts a server on a tier with a free seat, is refused 409
 * `no_free_seat` when every seat there is held, and releases a license with
 * `null`. No other server's tier ever moves, and nothing is bought. Skips
 * without TURBOPANEL_DATABASE_URL.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  audit,
  grant,
  license,
  organization,
  payer,
  server,
  subscription,
  subscriptionItem,
  tier,
  user,
} from '../../db/schema.ts'
import { createLicense } from '../../features/licenses/license.ts'
import { getTierByLabel, insertTier } from '../../features/tiers/tier-records.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerServerLicenseTierRoutes } from './license-tier-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  organizationId: string
  cookie: string
  s1: string
  s3: string
  /** Licensed, on S1. */
  serverOnS1: string
  /** Licensed, on S3. */
  serverOnS3: string
  /** Licensed, no tier yet. */
  serverNoTier: string
}

async function ensureTier(db: Db, label: string, created: string[]): Promise<string> {
  const existing = await getTierByLabel(db, label)
  if (existing) return existing.id
  const row = await insertTier(db, {
    label,
    providerProductId: `prod_license_tier_${label.toLowerCase()}`,
    priceCents: null,
    currency: null,
  })
  created.push(row.id)
  return row.id
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('license tier route tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerServerLicenseTierRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })

  const now = new Date().toISOString()
  const createdTiers: string[] = []
  const [org] = await db
    .insert(organization)
    .values({ name: 'License Tier Route Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  let userId: string | null = null
  let payerId: string | null = null
  let subscriptionId: string | null = null
  try {
    const [userRow] = await db
      .insert(user)
      .values({
        email: `license-tier-${crypto.randomUUID()}@example.com`,
        isEmailVerified: true,
        role: 'user',
      })
      .returning({ id: user.id })
    userId = userRow!.id
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:own',
    })
    const { token } = await createSession(db, userId, {})
    const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`

    const s1 = await ensureTier(db, 'S1', createdTiers)
    const s3 = await ensureTier(db, 'S3', createdTiers)
    const [payerRow] = await db
      .insert(payer)
      .values({
        organizationId,
        provider: 'stripe',
        providerCustomerId: `cus_license_tier_${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: payer.id })
    payerId = payerRow!.id
    const [subRow] = await db
      .insert(subscription)
      .values({
        payerId,
        providerSubscriptionId: `sub_license_tier_${crypto.randomUUID()}`,
        status: 'active',
        providerStatus: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: subscription.id })
    subscriptionId = subRow!.id
    // Two S1 seats (one free) and one S3 seat (held).
    for (const [tierId, quantity] of [
      [s1, 2],
      [s3, 1],
    ] as const) {
      await db.insert(subscriptionItem).values({
        subscriptionId,
        tierId,
        providerItemId: `si_license_tier_${crypto.randomUUID()}`,
        providerPriceId: `price_license_tier_${crypto.randomUUID()}`,
        quantity,
        createdAt: now,
        updatedAt: now,
      })
    }

    const licensedServer = async (assignedTierId: string | null, createdAt: string) => {
      const [row] = await db
        .insert(server)
        .values({
          organizationId,
          name: `license-tier-${crypto.randomUUID().slice(0, 8)}`,
          createdAt,
          updatedAt: createdAt,
          statusChangedAt: createdAt,
          assignedTierId,
        })
        .returning({ id: server.id })
      const { licenseId } = await createLicense(db, { organizationId, name: 'License Tier' })
      await db
        .update(license)
        .set({ serverId: row!.id, updatedAt: now })
        .where(eq(license.id, licenseId))
      return row!.id
    }

    await fn({
      db,
      app,
      organizationId,
      cookie,
      s1,
      s3,
      serverOnS1: await licensedServer(s1, '2026-09-01T00:00:00.000Z'),
      serverOnS3: await licensedServer(s3, '2026-09-02T00:00:00.000Z'),
      serverNoTier: await licensedServer(null, '2026-09-03T00:00:00.000Z'),
    })
  } finally {
    await db.delete(audit).where(eq(audit.organizationId, organizationId))
    await db.delete(license).where(eq(license.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    if (subscriptionId) {
      await db.delete(subscriptionItem).where(eq(subscriptionItem.subscriptionId, subscriptionId))
      await db.delete(subscription).where(eq(subscription.id, subscriptionId))
    }
    if (payerId) await db.delete(payer).where(eq(payer.id, payerId))
    if (userId) {
      await db.delete(grant).where(eq(grant.actorId, userId))
      await db.delete(user).where(eq(user.id, userId))
    }
    if (createdTiers.length > 0) await db.delete(tier).where(inArray(tier.id, createdTiers))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

async function putTier(
  f: Fixture,
  serverId: string,
  tierId: string | null
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await f.app.request(`/servers/${serverId}/license-tier`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      Cookie: f.cookie,
      [ORG_ID_HEADER]: f.organizationId,
    },
    body: JSON.stringify({ tierId }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function tiersOf(f: Fixture): Promise<Record<string, string | null>> {
  const rows = await f.db
    .select({ id: server.id, assignedTierId: server.assignedTierId })
    .from(server)
    .where(eq(server.organizationId, f.organizationId))
  return Object.fromEntries(rows.map((row) => [row.id, row.assignedTierId]))
}

test('PUT /servers/:id/license-tier gives a server a free seat and moves no other server', async () => {
  await withFixture(async (f) => {
    const assigned = await putTier(f, f.serverNoTier, f.s1)
    assertEquals(assigned.status, 200)
    assertEquals(assigned.body.assignedTierId, f.s1)
    assertEquals(assigned.body.assignedTier, 'S1')
    assertEquals(await tiersOf(f), {
      [f.serverOnS1]: f.s1,
      [f.serverOnS3]: f.s3,
      [f.serverNoTier]: f.s1,
    })
  })
})

test('PUT /servers/:id/license-tier is refused 409 no_free_seat when every seat at the tier is held', async () => {
  await withFixture(async (f) => {
    // The only S3 seat is held by an older server: it is never taken from it.
    const refused = await putTier(f, f.serverOnS1, f.s3)
    assertEquals(refused.status, 409)
    assertEquals(refused.body.code, 'no_free_seat')
    assertEquals(await tiersOf(f), {
      [f.serverOnS1]: f.s1,
      [f.serverOnS3]: f.s3,
      [f.serverNoTier]: null,
    })
  })
})

test('PUT /servers/:id/license-tier with null releases the license and the freed seat stays free', async () => {
  await withFixture(async (f) => {
    const released = await putTier(f, f.serverOnS3, null)
    assertEquals(released.status, 200)
    assertEquals(released.body.assignedTierId, null)
    // Nobody is moved onto the freed S3 seat.
    assertEquals(await tiersOf(f), {
      [f.serverOnS1]: f.s1,
      [f.serverOnS3]: null,
      [f.serverNoTier]: null,
    })
    // A manager can now take it explicitly.
    const taken = await putTier(f, f.serverOnS1, f.s3)
    assertEquals(taken.status, 200)
    assertEquals(await tiersOf(f), {
      [f.serverOnS1]: f.s3,
      [f.serverOnS3]: null,
      [f.serverNoTier]: null,
    })
  })
})

test('PUT /servers/:id/license-tier is refused 422 when the tier is below the server CPU or RAM', async () => {
  await withFixture(async (f) => {
    // 12 physical cores needs S3 by CPU: S1 is a hard no, whatever is free.
    await f.db
      .update(server)
      .set({ metadata: { resources: { cpus: [{ cores: { total: 12 } }] } } })
      .where(eq(server.id, f.serverNoTier))
    const refused = await putTier(f, f.serverNoTier, f.s1)
    assertEquals(refused.status, 422)
    assertEquals(refused.body.code, 'tier_below_required')
    assertEquals(await tiersOf(f), {
      [f.serverOnS1]: f.s1,
      [f.serverOnS3]: f.s3,
      [f.serverNoTier]: null,
    })
  })
})
