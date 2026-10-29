/**
 * One Cloudflare account with several API Tokens against a real database and a
 * faked provider: a tunnel-only token with DNS tokens limited to one zone each,
 * overlapping scopes, a token the provider refuses mid-use, a hostname removed
 * after its DNS token went away, tokens rolled or removed, and the daily
 * recheck. Skips without TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { badge, doorway, organization, tunnel } from '../../db/schema.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import type { CredentialReport, TunnelAdapter } from './adapter.ts'
import { runBadgeRecheckSweepTick } from './badge-recheck.ts'
import { dependentsOf, lossOfRemoving } from './badge-dependents.ts'
import { TunnelProviderError, type TunnelErrorCode } from './errors.ts'
import { addDoorway, createTunnel, removeDoorway, TunnelRefusal } from './lifecycle.ts'
import {
  findBadge,
  insertBadge,
  insertCarrier,
  listBadges,
  MAX_BADGES_PER_CARRIER,
  sealToken,
  TunnelLimitError,
  type BadgeRow,
  type CarrierRow,
} from './records.ts'
import type { BadgeCapabilities } from './vocabulary.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test}; keeps Sonar's test detection happy. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>

const ZONE_A = { id: 'zone-a', name: 'example.com' }
const ZONE_B = { id: 'zone-b', name: 'shop.example.org' }
const ACCOUNT = 'acct-1'

/** What the faked provider saw (`operation:token`) and which tokens it refuses for which operation. */
function fakeProvider(refuse: Record<string, TunnelErrorCode> = {}) {
  const calls: string[] = []
  const seen = (op: string, token: string) => {
    calls.push(`${op}:${token}`)
    const code = refuse[`${op}:${token}`]
    if (code) throw new TunnelProviderError(code, `${op} refused`, code === 'forbidden' ? 403 : 401)
  }
  let created = 0
  const adapter: TunnelAdapter = {
    provider: 'cloudflare',
    tokenShapeProblem: () => null,
    discoverAccounts: () =>
      Promise.resolve({
        accounts: [],
        token: { kind: null, id: null, status: null, expiresAt: null },
      }),
    checkCredential: () => Promise.reject(new Error('not used here')),
    createTunnel(token) {
      seen('createTunnel', token)
      created += 1
      return Promise.resolve({ externalId: `ext-new-${created}`, runToken: 'run-token-for-tests' })
    },
    fetchRunToken: () => Promise.resolve('run'),
    rotateRunToken: () => Promise.reject(new Error('unsupported')),
    setRoutes(token) {
      seen('setRoutes', token)
      return Promise.resolve()
    },
    findZone(token) {
      seen('findZone', token)
      return Promise.reject(new TunnelProviderError('zone_not_found', 'no zone', null))
    },
    createDnsName(token, input) {
      seen('createDnsName', token)
      return Promise.resolve({ recordId: `rec-${input.zoneId}` })
    },
    removeDnsName(token) {
      seen('removeDnsName', token)
      return Promise.resolve()
    },
    deleteTunnel(token) {
      seen('deleteTunnel', token)
      return Promise.resolve()
    },
  }
  return { adapter, calls }
}

type World = {
  db: Db
  organizationId: string
  carrier: CarrierRow
  secrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
}

async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('token selection tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [org] = await db
    .insert(organization)
    .values({ name: `Token Org ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  try {
    const carrier = await insertCarrier(db, {
      organizationId: org!.id,
      provider: 'cloudflare',
      name: 'Main',
      externalAccountId: ACCOUNT,
    })
    await fn({ db, organizationId: org!.id, carrier, secrets })
  } finally {
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
}

function reportFor(capabilities: BadgeCapabilities): CredentialReport {
  return {
    accounts: [],
    zones: [],
    accountVisible: true,
    capabilities,
    missing: [],
    token: { kind: 'account', id: null, status: 'active', expiresAt: null },
  }
}

/** Store a token whose secret text is its own label, so the faked provider can tell which one was used. */
async function addToken(
  w: World,
  label: string,
  capabilities: Partial<BadgeCapabilities>,
  extra: { lastCheckedAt?: string; options?: Record<string, unknown> } = {}
): Promise<BadgeRow> {
  const row = await insertBadge(w.db, {
    organizationId: w.organizationId,
    carrier: w.carrier,
    label,
    sealed: await sealToken(w.secrets, label),
    lastFour: label.slice(-4),
    report: reportFor({ tunnels: false, dns: [], certificates: [], ...capabilities }),
  })
  if (extra.lastCheckedAt || extra.options) {
    const [updated] = await w.db
      .update(badge)
      .set({
        ...(extra.lastCheckedAt ? { lastCheckedAt: extra.lastCheckedAt } : {}),
        ...(extra.options ? { options: { ...(row.options as object), ...extra.options } } : {}),
      })
      .where(eq(badge.id, row.id))
      .returning()
    return updated!
  }
  return row
}

async function seedTunnel(w: World, externalId = 'ext-1') {
  const [row] = await w.db
    .insert(tunnel)
    .values({
      organizationId: w.organizationId,
      routingOrganizationId: w.organizationId,
      carrierId: w.carrier.id,
      provider: 'cloudflare',
      name: `web-${crypto.randomUUID().slice(0, 8)}`,
      externalId,
      placement: 'chosen',
      status: 'active',
    })
    .returning()
  return row!
}

async function badgeById(w: World, id: string): Promise<BadgeRow> {
  return (await findBadge(w.db, w.carrier.id, id))!
}

test('a tunnel-only token and DNS tokens limited to one zone each: every call gets its own token', async () => {
  await withWorld(async (w) => {
    await addToken(w, 'tok-tunnel', { tunnels: true })
    await addToken(w, 'tok-dns-a', { dns: [ZONE_A] })
    const dnsB = await addToken(w, 'tok-dns-b', { dns: [ZONE_B] })
    const { adapter, calls } = fakeProvider()
    const t = await seedTunnel(w)
    const made = await addDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, {
      hostname: 'blog.example.com',
      isLocalOnly: true,
    })
    const other = await addDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, {
      hostname: 'www.shop.example.org',
      isLocalOnly: true,
    })
    assert(calls.includes('setRoutes:tok-tunnel'))
    assert(calls.includes('createDnsName:tok-dns-a'))
    assert(calls.includes('createDnsName:tok-dns-b'))
    // The zones were known from the tokens, so the provider was not asked to find them.
    assertEquals(
      calls.filter((c) => c.startsWith('findZone')),
      []
    )
    assertEquals(made.externalDnsRecordId, 'rec-zone-a')
    assertEquals((other.metadata as { zoneId: string; dnsBadgeId: string }).dnsBadgeId, dnsB.id)
  })
})

test('a hostname in no known zone asks the provider with the tunnel token and, without a DNS token for it, is refused before anything is written', async () => {
  await withWorld(async (w) => {
    await addToken(w, 'tok-tunnel', { tunnels: true })
    await addToken(w, 'tok-dns-a', { dns: [ZONE_A] })
    const { adapter, calls } = fakeProvider()
    const t = await seedTunnel(w)
    // The provider finds a zone in this account that no stored token reaches.
    adapter.findZone = (token) => {
      calls.push(`findZone:${token}`)
      return Promise.resolve({ id: 'zone-x', name: 'unknown.dev' })
    }
    const err = await assertRejects(
      () =>
        addDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, {
          hostname: 'app.unknown.dev',
          isLocalOnly: true,
        }),
      TunnelRefusal
    )
    assertEquals(err.code, 'badge_cannot_dns')
    assert(err.message.includes('unknown.dev'), err.message)
    assert(calls.includes('findZone:tok-tunnel'))
    assertEquals(await w.db.select().from(doorway).where(eq(doorway.tunnelId, t.id)), [])
  })
})

test('when no token has DNS rights at all, the refusal says so instead of naming a zone', async () => {
  await withWorld(async (w) => {
    await addToken(w, 'tok-tunnel', { tunnels: true })
    const { adapter } = fakeProvider()
    adapter.findZone = () => Promise.resolve(ZONE_A)
    const t = await seedTunnel(w)
    const err = await assertRejects(
      () =>
        addDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, {
          hostname: 'blog.example.com',
          isLocalOnly: true,
        }),
      TunnelRefusal
    )
    assertEquals(err.code, 'badge_cannot_dns')
    assert(err.message.includes('can edit DNS'), err.message)
  })
})

test('overlapping scopes: the token limited to the zone is used, not the one that reaches many', async () => {
  await withWorld(async (w) => {
    await addToken(w, 'tok-tunnel', { tunnels: true })
    await addToken(
      w,
      'tok-wide',
      { dns: [ZONE_A, ZONE_B] },
      { lastCheckedAt: '2026-10-28T12:00:00.000Z' }
    )
    await addToken(
      w,
      'tok-narrow',
      { dns: [ZONE_A] },
      { lastCheckedAt: '2026-10-01T00:00:00.000Z' }
    )
    const { adapter, calls } = fakeProvider()
    await addDoorway(w.db, { adapter, secrets: w.secrets }, await seedTunnel(w), w.carrier, {
      hostname: 'blog.example.com',
      isLocalOnly: true,
    })
    assert(calls.includes('createDnsName:tok-narrow'))
    assert(!calls.includes('createDnsName:tok-wide'))
  })
})

test('a token the provider refuses to edit with loses that zone, the next token is tried, and the refusal is remembered', async () => {
  await withWorld(async (w) => {
    await addToken(w, 'tok-tunnel', { tunnels: true })
    const readOnly = await addToken(
      w,
      'tok-read',
      { dns: [ZONE_A] },
      { lastCheckedAt: '2026-10-28T12:00:00.000Z' }
    )
    await addToken(
      w,
      'tok-edit',
      { dns: [ZONE_A, ZONE_B] },
      { lastCheckedAt: '2026-10-01T00:00:00.000Z' }
    )
    const { adapter, calls } = fakeProvider({ 'createDnsName:tok-read': 'forbidden' })
    const made = await addDoorway(
      w.db,
      { adapter, secrets: w.secrets },
      await seedTunnel(w),
      w.carrier,
      {
        hostname: 'blog.example.com',
        isLocalOnly: true,
      }
    )
    assertEquals(
      calls.filter((c) => c.startsWith('createDnsName')),
      ['createDnsName:tok-read', 'createDnsName:tok-edit']
    )
    assertEquals(made.status, 'live')
    const after = await badgeById(w, readOnly.id)
    assertEquals((after.capabilities as BadgeCapabilities).dns, [])
    assertEquals(after.status, 'attention')
    const failure = (after.options as { lastFailure: { capability: string; zone: string } })
      .lastFailure
    assertEquals([failure.capability, failure.zone], ['dns', 'example.com'])
  })
})

test('when every token is refused the message names the gap in plain words', async () => {
  await withWorld(async (w) => {
    await addToken(w, 'tok-tunnel', { tunnels: true })
    await addToken(w, 'tok-read', { dns: [ZONE_A] })
    const { adapter } = fakeProvider({ 'createDnsName:tok-read': 'forbidden' })
    const t = await seedTunnel(w)
    const err = await assertRejects(
      () =>
        addDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, {
          hostname: 'blog.example.com',
          isLocalOnly: true,
        }),
      TunnelRefusal
    )
    assertEquals(err.code, 'badge_cannot_dns')
    assert(err.message.includes('read DNS for example.com but refused to change it'), err.message)
    assertEquals(await w.db.select().from(doorway).where(eq(doorway.tunnelId, t.id)), [])
  })
})

test('a token the provider no longer accepts at all is taken out of use', async () => {
  await withWorld(async (w) => {
    const rolled = await addToken(
      w,
      'tok-old',
      { tunnels: true },
      { lastCheckedAt: '2026-10-28T12:00:00.000Z' }
    )
    await addToken(w, 'tok-new', { tunnels: true }, { lastCheckedAt: '2026-10-01T00:00:00.000Z' })
    const { adapter, calls } = fakeProvider({ 'createTunnel:tok-old': 'unauthorized' })
    const made = await createTunnel(
      w.db,
      { adapter, secrets: w.secrets },
      {
        carrier: w.carrier,
        name: 'fallback',
        placement: { placement: 'chosen', serverIds: [], exceptServerIds: [] },
        datacenterId: null,
      }
    )
    assertEquals(
      calls.filter((c) => c.startsWith('createTunnel')),
      ['createTunnel:tok-old', 'createTunnel:tok-new']
    )
    assertEquals(made.status, 'pending')
    const after = await badgeById(w, rolled.id)
    assertEquals(after.status, 'attention')
    assertEquals(after.capabilities, { tunnels: false, dns: [], certificates: [] })
  })
})

test('removing a hostname finds its DNS token first; with none, the route goes, the row waits in attention and a later token finishes it', async () => {
  await withWorld(async (w) => {
    await addToken(w, 'tok-tunnel', { tunnels: true })
    const dns = await addToken(w, 'tok-dns-a', { dns: [ZONE_A] })
    const { adapter, calls } = fakeProvider()
    const t = await seedTunnel(w)
    const made = await addDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, {
      hostname: 'blog.example.com',
      isLocalOnly: true,
    })
    // The only DNS token goes away (rolled): the zone is no longer covered.
    await w.db.update(badge).set({ status: 'attention' }).where(eq(badge.id, dns.id))
    calls.length = 0
    const err = await assertRejects(
      () => removeDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, made),
      TunnelRefusal
    )
    assertEquals(err.code, 'badge_cannot_dns')
    assertEquals(calls, ['setRoutes:tok-tunnel'])
    const [kept] = await w.db.select().from(doorway).where(eq(doorway.id, made.id))
    assertEquals(kept!.status, 'attention')
    assert((kept!.metadata as { warning: string }).warning.includes('blog.example.com'))
    // The route stays down: a later change to the same tunnel does not bring it back.
    await addToken(w, 'tok-dns-b', { dns: [ZONE_B] })
    const sent: string[][] = []
    const setRoutes = adapter.setRoutes
    adapter.setRoutes = (token, input) => {
      sent.push([...input.hostnames])
      return setRoutes(token, input)
    }
    await addDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, {
      hostname: 'www.shop.example.org',
      isLocalOnly: true,
    })
    assertEquals(sent.at(-1), ['www.shop.example.org'])
    // A token that covers the zone again: the retry takes the DNS name away and the row goes.
    await addToken(w, 'tok-dns-new', { dns: [ZONE_A] })
    calls.length = 0
    await removeDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, kept!)
    assertEquals(calls, ['setRoutes:tok-tunnel', 'removeDnsName:tok-dns-new'])
    assertEquals(await w.db.select().from(doorway).where(eq(doorway.id, made.id)), [])
  })
})

test('a zone deleted and added again has a new id: a token for the new id does not remove a name of the old zone', async () => {
  await withWorld(async (w) => {
    await addToken(w, 'tok-tunnel', { tunnels: true })
    await addToken(w, 'tok-dns-new', { dns: [{ id: 'zone-new', name: 'example.com' }] })
    const { adapter } = fakeProvider()
    const t = await seedTunnel(w)
    const [stale] = await w.db
      .insert(doorway)
      .values({
        routingOrganizationId: w.organizationId,
        tunnelId: t.id,
        hostname: 'blog.example.com',
        status: 'live',
        externalDnsRecordId: 'rec-old',
        metadata: { zoneId: 'zone-old' },
      })
      .returning()
    const err = await assertRejects(
      () => removeDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, stale!),
      TunnelRefusal
    )
    assertEquals(err.code, 'badge_cannot_dns')
  })
})

test('what depends on a token is listed: the last tunnel token strands the tunnels, the last DNS token for a zone its hostnames', async () => {
  await withWorld(async (w) => {
    const tunnelToken = await addToken(w, 'tok-tunnel', { tunnels: true })
    const dnsToken = await addToken(w, 'tok-dns-a', { dns: [ZONE_A] })
    const { adapter } = fakeProvider()
    const t = await seedTunnel(w)
    await addDoorway(w.db, { adapter, secrets: w.secrets }, t, w.carrier, {
      hostname: 'blog.example.com',
      isLocalOnly: true,
    })
    const tunnels = await dependentsOf(w.db, w.carrier.id, await lossOfRemoving(w.db, tunnelToken))
    assertEquals(
      tunnels.dependents.map((d) => [d.kind, d.name]),
      [['tunnel', t.name]]
    )
    const hostnames = await dependentsOf(w.db, w.carrier.id, await lossOfRemoving(w.db, dnsToken))
    assertEquals(
      hostnames.dependents.map((d) => [d.kind, d.name, d.zone]),
      [['hostname', 'blog.example.com', 'example.com']]
    )
    // A second token that covers the same things leaves nothing stranded.
    await addToken(w, 'tok-both', { tunnels: true, dns: [ZONE_A] })
    assertEquals(
      (await dependentsOf(w.db, w.carrier.id, await lossOfRemoving(w.db, tunnelToken))).total,
      0
    )
    assertEquals(
      (await dependentsOf(w.db, w.carrier.id, await lossOfRemoving(w.db, dnsToken))).total,
      0
    )
  })
})

test('an account can hold many tokens, up to the limit', async () => {
  await withWorld(async (w) => {
    const report = reportFor({ tunnels: false, dns: [ZONE_A], certificates: [] })
    for (let i = 0; i < MAX_BADGES_PER_CARRIER; i++) {
      await insertBadge(w.db, {
        organizationId: w.organizationId,
        carrier: w.carrier,
        label: `Token ${i}`,
        sealed: 'tpsecret:test',
        lastFour: `${i}`.padStart(4, '0'),
        report,
      })
    }
    assertEquals((await listBadges(w.db, w.carrier.id)).length, 50)
    await assertRejects(
      () =>
        insertBadge(w.db, {
          organizationId: w.organizationId,
          carrier: w.carrier,
          label: 'One too many',
          sealed: 'tpsecret:test',
          lastFour: '9999',
          report,
        }),
      TunnelLimitError
    )
  })
})

test('the daily recheck refreshes old tokens, finds a rolled one, keeps declared zones and leaves recent ones alone', async () => {
  await withWorld(async (w) => {
    const old = '2026-10-01T00:00:00.000Z'
    const declared = await addToken(
      w,
      'tok-declared',
      { dns: [] },
      {
        lastCheckedAt: old,
        options: { declaredZones: [{ id: 'zone-d', name: 'declared.dev' }] },
      }
    )
    const rolled = await addToken(w, 'tok-rolled', { tunnels: true }, { lastCheckedAt: old })
    const outage = await addToken(w, 'tok-outage', { tunnels: true }, { lastCheckedAt: old })
    const recent = await addToken(
      w,
      'tok-recent',
      { tunnels: true },
      { lastCheckedAt: new Date().toISOString() }
    )
    const asked: string[] = []
    const checking: TunnelAdapter = {
      ...fakeProvider().adapter,
      checkCredential(token, scope) {
        asked.push(`${token}:${(scope.declaredZones ?? []).map((z) => z.id).join(',')}`)
        if (token === 'tok-rolled') {
          return Promise.reject(new TunnelProviderError('unauthorized', 'bad token', 401))
        }
        if (token === 'tok-outage') {
          return Promise.reject(new TunnelProviderError('unreachable', 'down', null))
        }
        return Promise.resolve(
          reportFor({
            tunnels: false,
            dns: [{ id: 'zone-d', name: 'declared.dev' }],
            certificates: [],
          })
        )
      },
    }
    const result = await runBadgeRecheckSweepTick(w.db, {
      secrets: w.secrets,
      registry: () => checking,
    })
    assertEquals(result, { checked: 2, attention: 1 })
    assert(asked.includes('tok-declared:zone-d'))
    assert(!asked.some((a) => a.startsWith('tok-recent')))
    const d = await badgeById(w, declared.id)
    assertEquals(
      (d.capabilities as BadgeCapabilities).dns.map((z) => z.id),
      ['zone-d']
    )
    assertEquals(d.status, 'active')
    const r = await badgeById(w, rolled.id)
    assertEquals(r.status, 'attention')
    // An outage says nothing about the token: it keeps its rights and is tried again later, not at once.
    const o = await badgeById(w, outage.id)
    assertEquals(o.status, 'active')
    assertEquals((o.capabilities as BadgeCapabilities).tunnels, true)
    assert(typeof (o.options as { recheckTryAt?: string }).recheckTryAt === 'string')
    asked.length = 0
    await runBadgeRecheckSweepTick(w.db, { secrets: w.secrets, registry: () => checking })
    assert(!asked.some((a) => a.startsWith('tok-outage')))
    assertEquals((await badgeById(w, recent.id)).lastCheckedAt !== old, true)
  })
})

test('a token stored before certificates were probed is rechecked at the next tick and gains its certificate zones', async () => {
  await withWorld(async (w) => {
    const zone = { id: 'zone-c', name: 'cert.example' }
    // Checked a minute ago, but by a check that never looked for certificate rights.
    const stale = await addToken(w, 'tok-stale', { tunnels: true, dns: [zone] })
    const [unstamped] = await w.db
      .update(badge)
      .set({
        lastCheckedAt: new Date().toISOString(),
        options: { kind: 'account', tokenId: null },
      })
      .where(eq(badge.id, stale.id))
      .returning()
    assertEquals((unstamped!.capabilities as BadgeCapabilities).certificates, [])
    const checking: TunnelAdapter = {
      ...fakeProvider().adapter,
      checkCredential: () =>
        Promise.resolve(reportFor({ tunnels: true, dns: [zone], certificates: [zone] })),
    }
    const first = await runBadgeRecheckSweepTick(w.db, {
      secrets: w.secrets,
      registry: () => checking,
    })
    assertEquals(first, { checked: 1, attention: 0 })
    const after = await badgeById(w, stale.id)
    assertEquals((after.capabilities as BadgeCapabilities).certificates, [zone])
    // Now stamped and recent, so the next tick leaves it alone.
    const second = await runBadgeRecheckSweepTick(w.db, {
      secrets: w.secrets,
      registry: () => checking,
    })
    assertEquals(second, { checked: 0, attention: 0 })
  })
})
