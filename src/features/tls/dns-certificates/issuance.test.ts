/**
 * DNS-validated certificates end to end against a real database, an in-memory
 * authority and an in-memory DNS host: issuing exact names and a wildcard,
 * reuse, a validation that fails, a rate limit, a renewal and two workers at
 * once. Skips without TURBOPANEL_DATABASE_URL.
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../../db/connection.ts'
import { badge, carrier, organization, secret, tls } from '../../../db/schema.ts'
import { ACME_ACCOUNT_SECRET_PROVIDER } from './account.ts'
import { getDatabaseUrl } from '../../../db/url.ts'
import { createFakeCa } from '../../../lib/acme/fake-ca.test.support.ts'
import { issueLeafCertificate, mintOrganizationCa } from '../../../lib/tls/self-signed.ts'
import { encryptSecret, isSealedEnvelope } from '../../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../../test-fixtures/secrets.ts'
import { skipWithoutDatabase } from '../../../test-fixtures/require-service.test.support.ts'
import { TunnelProviderError } from '../../tunnels/errors.ts'
import type { TunnelAdapterRegistry } from '../../tunnels/registry.ts'
import { DAY_MS, type DnsCertContext, MAX_NEW_PER_DAY, PRESENT_GRACE_MS } from './context.ts'
import type { DnsChallengeProvider } from './dns-provider.ts'
import { advanceDnsCertificate, maintainDnsCertificate, startDnsCertificate } from './issuance.ts'
import { readDnsCertState } from './order-state.ts'
import { runDnsCertificateSweepTick } from './sweep.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type Db = ReturnType<typeof createDenoDb>

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('dns certificate tests')
    return
  }
  const db = createDenoDb()
  try {
    await fn(db)
  } finally {
    await endDbConnection(db)
  }
}

/** A DNS host that remembers its records; `silent` accepts them without publishing. */
function fakeDns(silent = false) {
  const records = new Map<string, { name: string; value: string }>()
  /** Names that are a CNAME to another name. */
  const cnames = new Map<string, string>()
  let n = 0
  const provider: DnsChallengeProvider = {
    lookupCname: (input) => Promise.resolve(cnames.get(input.name) ?? null),
    present: (input) => {
      n += 1
      const id = `rec${n}`
      if (!silent) records.set(id, { name: input.name, value: input.value })
      return Promise.resolve({ zoneId: input.zoneId, recordId: id })
    },
    remove: (ref) => {
      records.delete(ref.recordId)
      return Promise.resolve()
    },
  }
  // A validator follows a CNAME to where the record really is.
  const txt = (name: string) => {
    const at = cnames.get(name) ?? name
    return [...records.values()].filter((r) => r.name === at).map((r) => r.value)
  }
  return { provider, records, cnames, txt }
}

type SetupOptions = {
  silent?: boolean
  rateLimit?: boolean
  processing?: number
  ca?: Partial<Parameters<typeof createFakeCa>[0]>
  /** Zones the account can find for a name outside the certificate's own zones. */
  otherZones?: { id: string; name: string }[]
}

async function setup(db: Db, options: SetupOptions = {}) {
  const [org] = await db
    .insert(organization)
    .values({ name: `Dns Org ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [c] = await db
    .insert(carrier)
    .values({ organizationId, provider: 'cloudflare', name: 'Main', externalAccountId: 'acct' })
    .returning({ id: carrier.id })
  const [stored] = await db
    .insert(secret)
    .values({
      organizationId,
      provider: 'carrier_badge',
      name: 'token',
      secretEnvelope: await encryptSecret(secrets, 'dns-token-value'),
    })
    .returning({ id: secret.id })
  await db.insert(badge).values({
    carrierId: c!.id,
    secretId: stored!.id,
    label: 'dns',
    lastFour: 'alue',
    capabilities: {
      tunnels: false,
      dns: [{ id: 'zone-1', name: 'example.com' }],
      certificates: [],
    },
  })
  const dns = fakeDns(options.silent)
  const ca = createFakeCa({
    txt: dns.txt,
    rateLimitOrders: options.rateLimit,
    processingPolls: options.processing,
    ...options.ca,
  })
  const clock = { now: new Date() }
  const renewed: string[] = []
  const ctx: DnsCertContext = {
    db,
    secrets,
    adapters: (() => ({
      findZone: (_token: string, input: { hostname: string }) => {
        const zone = (options.otherZones ?? []).find(
          (z) => input.hostname === z.name || input.hostname.endsWith(`.${z.name}`)
        )
        return zone
          ? Promise.resolve(zone)
          : Promise.reject(new TunnelProviderError('zone_not_found', 'no such zone', null))
      },
    })) as unknown as TunnelAdapterRegistry,
    dns: () => dns.provider,
    acmeFetch: ca.fetch,
    now: () => clock.now,
    onRenewed: (id) => {
      renewed.push(id)
      return Promise.resolve()
    },
  }
  const input = (names: string[]) => ({
    organizationId,
    carrierId: c!.id,
    names,
    zones: [{ id: 'zone-1', name: 'example.com' }],
    staging: true,
  })
  return { ctx, dns, ca, clock, renewed, input, organizationId }
}

const tick = (clock: { now: Date }, ms: number) => {
  clock.now = new Date(clock.now.getTime() + ms)
}

async function rowOf(db: Db, id: string) {
  const [row] = await db.select().from(tls).where(eq(tls.id, id))
  return row!
}

test('a wildcard and its apex are ordered, validated by two records at one name, issued and cleaned up', () =>
  withDb(async (db) => {
    const s = await setup(db)
    const started = await startDnsCertificate(s.ctx, s.input(['example.com', '*.example.com']))
    assertEquals(started.kind, 'created')
    const id = (started as { id: string }).id
    assertEquals((await rowOf(db, id)).status, 'pending')

    assertEquals(await advanceDnsCertificate(s.ctx, id), 'waiting')
    // Two records now sit at the same name, one per challenge.
    assertEquals(s.dns.txt('_acme-challenge.example.com').length, 2)
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'waiting')
    assertEquals(s.ca.issued.length, 0)

    tick(s.clock, PRESENT_GRACE_MS + 1000)
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'issued')
    const row = await rowOf(db, id)
    assertEquals(row.status, 'ready')
    assert(row.certificatePem?.includes('BEGIN CERTIFICATE'))
    assert(isSealedEnvelope(row.privateKeyPem ?? ''))
    assertEquals(s.dns.records.size, 0)
    assertEquals(s.ca.issued, [['example.com', '*.example.com']])
    const state = readDnsCertState(row.metadata)
    assertEquals(state?.order, null)
    const acme = (row.metadata as { acme: { stage: string; managedBy: string; staging: boolean } })
      .acme
    assertEquals([acme.stage, acme.managedBy, acme.staging], ['issued', 'panel', true])
  }))

test('a certificate that already covers the names is reused, and a running order is not doubled', () =>
  withDb(async (db) => {
    const s = await setup(db)
    const first = await startDnsCertificate(s.ctx, s.input(['example.com', '*.example.com']))
    const id = (first as { id: string }).id
    assertEquals(
      (await startDnsCertificate(s.ctx, s.input(['example.com', '*.example.com']))).kind,
      'existing'
    )
    await advanceDnsCertificate(s.ctx, id)
    tick(s.clock, PRESENT_GRACE_MS + 1000)
    await advanceDnsCertificate(s.ctx, id)
    const again = await startDnsCertificate(s.ctx, s.input(['www.example.com']))
    assertEquals(again, { kind: 'reused', id })
    // A name the wildcard does not cover (two labels deep) gets its own certificate.
    const deep = await startDnsCertificate(s.ctx, s.input(['a.b.example.com']))
    assertEquals(deep.kind, 'created')
  }))

test('a validation that fails removes its records, waits, and gives up after three orders', () =>
  withDb(async (db) => {
    const s = await setup(db, { silent: true })
    const id = ((await startDnsCertificate(s.ctx, s.input(['example.com']))) as { id: string }).id
    for (const attempt of [1, 2, 3]) {
      assertEquals(await advanceDnsCertificate(s.ctx, id), 'waiting')
      tick(s.clock, PRESENT_GRACE_MS + 1000)
      assertEquals(await advanceDnsCertificate(s.ctx, id), 'failed')
      const row = await rowOf(db, id)
      assertEquals(readDnsCertState(row.metadata)?.attempts, attempt)
      assertEquals(s.dns.records.size, 0)
      if (attempt < 3) {
        assertEquals(row.status, 'pending')
        // Too early: nothing is tried while the wait runs.
        assertEquals(await advanceDnsCertificate(s.ctx, id), 'backoff')
        tick(s.clock, 5 * 3_600_000)
      }
    }
    const last = await rowOf(db, id)
    assertEquals(last.status, 'failed')
    const lastError = (last.metadata as { acme: { lastError?: string } }).acme.lastError ?? ''
    assert(lastError.length > 0)
    assertEquals(lastError.includes('dns-token-value'), false)
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'failed')
  }))

test('a rate limit is waited out for as long as the authority said and is not counted as giving up', () =>
  withDb(async (db) => {
    const s = await setup(db, { rateLimit: true })
    const id = ((await startDnsCertificate(s.ctx, s.input(['example.com']))) as { id: string }).id
    for (let i = 0; i < 4; i += 1) {
      assertEquals(await advanceDnsCertificate(s.ctx, id), 'failed')
      tick(s.clock, 11 * 60_000)
    }
    const row = await rowOf(db, id)
    assertEquals(row.status, 'pending')
    assertEquals(s.dns.records.size, 0)
    assert((row.metadata as { acme: { lastError: string } }).acme.lastError.includes('wait'))
  }))

test('a renewal signs with a new key, swaps the pair at the end and tells the sites', () =>
  withDb(async (db) => {
    const s = await setup(db, { processing: 1 })
    const id = ((await startDnsCertificate(s.ctx, s.input(['example.com']))) as { id: string }).id
    await advanceDnsCertificate(s.ctx, id)
    tick(s.clock, PRESENT_GRACE_MS + 1000)
    // The authority keeps the order processing for one poll.
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'waiting')
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'issued')
    const first = await rowOf(db, id)
    // Nothing to do while the certificate is far from its end.
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'waiting')
    assertEquals(s.ca.issued.length, 1)

    tick(s.clock, 80 * DAY_MS)
    await db
      .update(tls)
      .set({ notAfter: new Date(s.clock.now.getTime() + 10 * DAY_MS).toISOString() })
      .where(eq(tls.id, id))
    const only = { organizationId: s.organizationId }
    assertEquals((await runDnsCertificateSweepTick(s.ctx, only)).advanced, 1)
    const during = await rowOf(db, id)
    assertEquals(during.status, 'ready')
    assertEquals(during.privateKeyPem, first.privateKeyPem)
    tick(s.clock, PRESENT_GRACE_MS + 1000)
    await runDnsCertificateSweepTick(s.ctx, only)
    await runDnsCertificateSweepTick(s.ctx, only)
    const after = await rowOf(db, id)
    assertNotEquals(after.privateKeyPem, first.privateKeyPem)
    assertNotEquals(after.fingerprintSha256, first.fingerprintSha256)
    assertEquals(s.renewed, [id])
    assertEquals(s.dns.records.size, 0)
  }))

test('two workers at once: one steps, the other is told the certificate is busy', () =>
  withDb(async (db) => {
    const s = await setup(db)
    const id = ((await startDnsCertificate(s.ctx, s.input(['example.com']))) as { id: string }).id
    const outcomes = await Promise.all([
      advanceDnsCertificate(s.ctx, id),
      advanceDnsCertificate(s.ctx, id),
    ])
    assert(outcomes.includes('busy'))
    assert(outcomes.includes('waiting'))
  }))

test('an organization can start only so many new certificates a day', () =>
  withDb(async (db) => {
    const s = await setup(db)
    for (let i = 0; i < MAX_NEW_PER_DAY; i += 1) {
      assertEquals(
        (await startDnsCertificate(s.ctx, s.input([`n${i}.example.com`]))).kind,
        'created'
      )
    }
    assertEquals(await startDnsCertificate(s.ctx, s.input(['one-more.example.com'])), {
      kind: 'limit',
    })
  }))

test('a CNAME at the challenge name is followed: the record goes where it points', () =>
  withDb(async (db) => {
    const s = await setup(db)
    s.dns.cnames.set('_acme-challenge.example.com', 'validation.example.com')
    const id = ((await startDnsCertificate(s.ctx, s.input(['example.com']))) as { id: string }).id
    await advanceDnsCertificate(s.ctx, id)
    const names = [...s.dns.records.values()].map((r) => r.name)
    assertEquals(names, ['validation.example.com'])
    tick(s.clock, PRESENT_GRACE_MS + 1000)
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'issued')
    assertEquals(s.dns.records.size, 0)
  }))

test('a CNAME to a zone the account cannot edit stops the order in plain words and writes nothing', () =>
  withDb(async (db) => {
    const s = await setup(db)
    s.dns.cnames.set('_acme-challenge.example.com', 'v.elsewhere.net')
    const id = ((await startDnsCertificate(s.ctx, s.input(['example.com']))) as { id: string }).id
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'failed')
    assertEquals(s.dns.records.size, 0)
    const note = ((await rowOf(db, id)).metadata as { acme: { lastError: string } }).acme.lastError
    assertStringIncludes(note, '_acme-challenge.example.com points to v.elsewhere.net')
    assertStringIncludes(note, 'Remove that CNAME')
  }))

test('a leftover record is removed by its own id once old enough, and nothing else in the zone is touched', () =>
  withDb(async (db) => {
    const s = await setup(db)
    const id = ((await startDnsCertificate(s.ctx, s.input(['example.com']))) as { id: string }).id
    // Someone else's record at the very same name, and one of ours an interrupted request left.
    s.dns.records.set('theirs', { name: '_acme-challenge.example.com', value: 'not-ours' })
    s.dns.records.set('ours', { name: '_acme-challenge.example.com', value: 'left-behind' })
    const row = await rowOf(db, id)
    const state = readDnsCertState(row.metadata)!
    const old = new Date(s.clock.now.getTime() - 3 * 3_600_000).toISOString()
    const young = new Date(s.clock.now.getTime() - 60_000).toISOString()
    s.dns.records.set('young', { name: '_acme-challenge.example.com', value: 'new' })
    await db
      .update(tls)
      .set({
        metadata: {
          ...(row.metadata as object),
          dnsCert: {
            ...state,
            records: [
              {
                zoneId: 'zone-1',
                recordId: 'ours',
                name: '_acme-challenge.example.com',
                createdAt: old,
              },
              {
                zoneId: 'zone-1',
                recordId: 'young',
                name: '_acme-challenge.example.com',
                createdAt: young,
              },
            ],
          },
        },
      })
      .where(eq(tls.id, id))
    await maintainDnsCertificate(s.ctx, id)
    assertEquals([...s.dns.records.keys()].sort(), ['theirs', 'young'])
  }))

test('the renewal time follows the authority’s window and falls back to a third of the lifetime', () =>
  withDb(async (db) => {
    const fallback = await setup(db)
    const a = (
      (await startDnsCertificate(fallback.ctx, fallback.input(['example.com']))) as { id: string }
    ).id
    await advanceDnsCertificate(fallback.ctx, a)
    tick(fallback.clock, PRESENT_GRACE_MS + 1000)
    assertEquals(await advanceDnsCertificate(fallback.ctx, a), 'issued')
    const row = await rowOf(db, a)
    const state = readDnsCertState(row.metadata)!
    const notBefore = Date.parse((row.metadata as { notBefore: string }).notBefore)
    const notAfter = Date.parse(row.notAfter!)
    const renewAt = Date.parse(state.renewAt!)
    // The self-signed test certificate has no key identifier, so the authority is not asked.
    assertEquals(fallback.ca.renewalAsked.length, 0)
    assert(Math.abs(renewAt - (notAfter - (notAfter - notBefore) / 3)) < 1000)
  }))

test('a renewal that cannot work is flagged on the certificate, and cleared when the token is back', () =>
  withDb(async (db) => {
    const s = await setup(db)
    const id = ((await startDnsCertificate(s.ctx, s.input(['example.com']))) as { id: string }).id
    await advanceDnsCertificate(s.ctx, id)
    tick(s.clock, PRESENT_GRACE_MS + 1000)
    await advanceDnsCertificate(s.ctx, id)
    await maintainDnsCertificate(s.ctx, id)
    const acmeOf = async () => (await rowOf(db, id)).metadata as { acme: { warning?: string } }
    assertEquals((await acmeOf()).acme.warning, undefined)

    const row = await rowOf(db, id)
    const carrierId = readDnsCertState(row.metadata)!.carrierId
    await db.update(badge).set({ status: 'attention' }).where(eq(badge.carrierId, carrierId))
    await maintainDnsCertificate(s.ctx, id)
    assertStringIncludes((await acmeOf()).acme.warning ?? '', 'can edit DNS for example.com')
    await db.update(badge).set({ status: 'active' }).where(eq(badge.carrierId, carrierId))
    await maintainDnsCertificate(s.ctx, id)
    assertEquals((await acmeOf()).acme.warning, undefined)
  }))

test('the authority’s renewal window sets the renewal time, never later than two days before the end', () =>
  withDb(async (db) => {
    const ca = await mintOrganizationCa({ organizationId: crypto.randomUUID() })
    const window = {
      start: new Date(Date.now() + 20 * DAY_MS),
      end: new Date(Date.now() + 21 * DAY_MS),
    }
    const s = await setup(db, {
      ca: {
        issueCertificate: async (names) =>
          (await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, names)).certificatePem,
        renewalWindow: window,
      },
    })
    const id = ((await startDnsCertificate(s.ctx, s.input(['example.com']))) as { id: string }).id
    await advanceDnsCertificate(s.ctx, id)
    tick(s.clock, PRESENT_GRACE_MS + 1000)
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'issued')
    assertEquals(s.ca.renewalAsked.length, 1)
    const row = await rowOf(db, id)
    const renewAt = Date.parse(readDnsCertState(row.metadata)!.renewAt!)
    const latest = Date.parse(row.notAfter!) - 2 * DAY_MS
    assert(renewAt >= window.start.getTime() - 1000)
    assert(renewAt <= Math.min(window.end.getTime(), latest) + 1000)
    // Not asked again until it is due; then the new answer replaces the time.
    await maintainDnsCertificate(s.ctx, id)
    assertEquals(s.ca.renewalAsked.length, 1)
    tick(s.clock, 7 * 3_600_000)
    await maintainDnsCertificate(s.ctx, id)
    assertEquals(s.ca.renewalAsked.length, 2)
  }))

async function accountRows(db: Db, organizationId: string) {
  const rows = await db.select().from(secret).where(eq(secret.organizationId, organizationId))
  return rows.filter((r) => r.provider === ACME_ACCOUNT_SECRET_PROVIDER)
}

async function issue(s: Awaited<ReturnType<typeof setup>>, names: string[], staging = true) {
  const started = await startDnsCertificate(s.ctx, { ...s.input(names), staging })
  const id = (started as { id: string }).id
  await advanceDnsCertificate(s.ctx, id)
  tick(s.clock, PRESENT_GRACE_MS + 1000)
  assertEquals(await advanceDnsCertificate(s.ctx, id), 'issued')
  return id
}

test('two first orders at once end with one account for the organization, at the authority and in the database', () =>
  withDb(async (db) => {
    const s = await setup(db)
    const a = ((await startDnsCertificate(s.ctx, s.input(['a.example.com']))) as { id: string }).id
    const b = ((await startDnsCertificate(s.ctx, s.input(['b.example.com']))) as { id: string }).id
    const outcomes = await Promise.all([
      advanceDnsCertificate(s.ctx, a),
      advanceDnsCertificate(s.ctx, b),
    ])
    assertEquals(outcomes, ['waiting', 'waiting'])
    const rows = await accountRows(db, s.organizationId)
    assertEquals(
      rows.map((r) => r.name),
      ['staging']
    )
    assert(isSealedEnvelope(rows[0]!.secretEnvelope))
    assertEquals(s.ca.accounts.size, 1)
    assertEquals(
      (rows[0]!.metadata as { accountUrl: string }).accountUrl,
      [...s.ca.accounts.keys()][0]
    )
  }))

test('later orders and renewals use the same account, and staging and production never share one', () =>
  withDb(async (db) => {
    const s = await setup(db)
    const first = await issue(s, ['a.example.com'])
    const second = await issue(s, ['b.example.com'])
    assertEquals(s.ca.accounts.size, 1)
    assertEquals((await accountRows(db, s.organizationId)).length, 1)

    // A renewal of the first certificate orders on the same account.
    await db
      .update(tls)
      .set({ notAfter: new Date(s.clock.now.getTime() + DAY_MS).toISOString() })
      .where(eq(tls.id, first))
    const only = { organizationId: s.organizationId }
    await runDnsCertificateSweepTick(s.ctx, only)
    tick(s.clock, PRESENT_GRACE_MS + 1000)
    await runDnsCertificateSweepTick(s.ctx, only)
    assertEquals(s.ca.accounts.size, 1)
    assertNotEquals(second, first)

    // The production directory has its own account.
    await issue(s, ['c.example.com'], false)
    assertEquals(s.ca.accounts.size, 2)
    assertEquals((await accountRows(db, s.organizationId)).map((r) => r.name).sort(), [
      'production',
      'staging',
    ])
  }))

test('an account the authority has switched off is registered again once, and the order goes on', () =>
  withDb(async (db) => {
    const s = await setup(db)
    await issue(s, ['a.example.com'])
    const before = (await accountRows(db, s.organizationId))[0]!
    s.ca.deactivateAccounts()
    const second = await issue(s, ['b.example.com'])
    const after = (await accountRows(db, s.organizationId))[0]!
    assertEquals((await rowOf(db, second)).status, 'ready')
    assertEquals(s.ca.accounts.size, 2)
    assertNotEquals(after.secretEnvelope, before.secretEnvelope)
    assertNotEquals(
      (after.metadata as { accountUrl: string }).accountUrl,
      (before.metadata as { accountUrl: string }).accountUrl
    )
  }))

test('an account that is refused even after registering again fails the order with a clear reason', () =>
  withDb(async (db) => {
    const s = await setup(db, { ca: { alwaysDeactivated: true } })
    // The first order registers the account (no kid is used yet) and then trips on its first signed request.
    const id = ((await startDnsCertificate(s.ctx, s.input(['a.example.com']))) as { id: string }).id
    assertEquals(await advanceDnsCertificate(s.ctx, id), 'failed')
    const note = ((await rowOf(db, id)).metadata as { acme: { lastError: string } }).acme.lastError
    assertStringIncludes(note, "no longer accepts this organization's account")
    assertEquals(s.dns.records.size, 0)
  }))
