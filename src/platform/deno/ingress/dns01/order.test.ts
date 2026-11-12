import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, type Db, endDbConnection } from '../../../../db/connection.ts'
import {
  ingressAccount,
  instanceHostname,
  instanceUploadedCertificate,
  setting,
} from '../../../../db/schema.ts'
import {
  INSTANCE_ACME_ACCOUNT_SETTING_KEY,
  type ResolvedInstanceAcmeSettings,
} from '../../../../features/install/instance-acme-settings.ts'
import type { DnsChallengeProvider } from '../../../../features/tls/dns-certificates/dns-provider.ts'
import {
  createFakeCa,
  type FakeCa,
  type FakeCaOptions,
  FAKE_CA_DIRECTORY,
} from '../../../../lib/acme/fake-ca.test.support.ts'
import { decryptSecret, encryptSecret } from '../../../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../../../lib/secrets/secrets.ts'
import type { NotificationContext } from '../../../../features/notifications/events.ts'
import { skipWithoutDatabase } from '../../../../test-fixtures/require-service.test.support.ts'
import { parseTestSecretsConfig } from '../../../../test-fixtures/secrets.ts'
import { DNS01_MAX_ABANDONED_PER_DAY } from './backoff.ts'
import {
  advanceOrder,
  type Dns01Deps,
  loadDns01Row,
  ORDER_TIMEOUT_MS,
  startOrder,
  TXT_WAIT_MS,
} from './order.ts'
import { clearedForRetry } from './state.ts'
import { runDns01Tick } from './tick.ts'

const test = Deno.test.bind(Deno)
const dbUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')

const NOW = new Date('2026-11-01T00:00:00.000Z')
const SERVER = '192.0.2.53'

type World = {
  deps: Dns01Deps
  hostnameId: string
  records: Map<string, string[]>
  sent: NotificationContext[]
  pushes: number[]
  ca: FakeCa
}

async function seed(
  db: Db,
  host: string,
  zone: string
): Promise<{ hostnameId: string; accountId: string }> {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [account] = await db
    .insert(ingressAccount)
    .values({
      provider: 'cloudflare',
      label: 'DNS-01 fixture',
      accountId: 'acct-1',
      zoneIds: ['zone-1'],
      tokenEnvelope: await encryptSecret(secrets, 'cfut_fixtureToken'),
      scopes: {
        tunnels: true,
        dns: true,
        checkedAt: NOW.toISOString(),
        zones: [{ id: 'zone-1', name: zone }],
      },
    })
    .returning({ id: ingressAccount.id })
  const [row] = await db
    .insert(instanceHostname)
    .values({ host: `https://${host}:8443`, source: 'acme-dns-01' })
    .returning({ id: instanceHostname.id })
  return { hostnameId: row!.id, accountId: account!.id }
}

async function world(
  db: Db,
  host: string,
  caOptions: Omit<FakeCaOptions, 'txt'> = {}
): Promise<World> {
  const records = new Map<string, string[]>()
  const ca = createFakeCa({ ...caOptions, txt: (name) => records.get(name) ?? [] })
  const provider: DnsChallengeProvider = {
    lookupCname: () => Promise.resolve(null),
    present: (input) => {
      records.set(input.name, [...(records.get(input.name) ?? []), input.value])
      return Promise.resolve({ zoneId: input.zoneId, recordId: `${input.name}|${input.value}` })
    },
    remove: (ref) => {
      const [name, value] = ref.recordId.split('|')
      records.set(
        name!,
        (records.get(name!) ?? []).filter((item) => item !== value)
      )
      return Promise.resolve()
    },
  }
  const sent: NotificationContext[] = []
  const pushes: number[] = []
  const settings = {
    contactEmail: 'ops@example.com',
    tosAccepted: true,
    directoryUrl: FAKE_CA_DIRECTORY,
    useStaging: false,
  } as ResolvedInstanceAcmeSettings
  const { hostnameId } = await seed(db, host, 'example.com')
  const deps: Dns01Deps = {
    db,
    now: () => NOW,
    random: () => 0.5,
    fetch: ca.fetch,
    dns: {
      caa: () => Promise.resolve([]),
      ns: () => Promise.resolve(['ns1.example.net']),
      addresses: () => Promise.resolve([SERVER]),
      txtAt: (name) => Promise.resolve(records.get(name) ?? []),
    },
    dataEncryption: await deriveEncryptionSecretsConfig(
      parseTestSecretsConfig('deno'),
      'data-encryption'
    ),
    settings,
    challengeProvider: () => Promise.resolve(provider),
    notify: (ctx) => Promise.resolve(void sent.push(ctx)),
    applyToDaemon: () => Promise.resolve(void pushes.push(1)),
    sleep: () => Promise.resolve(),
  }
  return { deps, hostnameId, records, sent, pushes, ca }
}

async function cleanup(db: Db, hostnameId: string): Promise<void> {
  const [row] = await db.select().from(instanceHostname).where(eq(instanceHostname.id, hostnameId))
  await db.delete(instanceHostname).where(eq(instanceHostname.id, hostnameId))
  if (row?.uploadedCertId) {
    await db
      .delete(instanceUploadedCertificate)
      .where(eq(instanceUploadedCertificate.id, row.uploadedCertId))
  }
  await db.delete(ingressAccount).where(eq(ingressAccount.label, 'DNS-01 fixture'))
  await db.delete(setting).where(eq(setting.key, INSTANCE_ACME_ACCOUNT_SETTING_KEY))
}

test('a DNS-01 order goes from idle to issued and stores a sealed acme-dns-01 pair', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host)
  try {
    const started = await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assert(!('ok' in started))
    assertEquals(started.stage, 'waiting-dns')
    assertEquals(w.records.get(`_acme-challenge.${host}`)?.length, 1)

    const validating = await advanceOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(validating.stage, 'validating')
    const again = await advanceOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(again.stage, 'issued')

    const row = (await loadDns01Row(db, w.hostnameId))!
    assert(row.uploadedCertId)
    const [cert] = await db
      .select()
      .from(instanceUploadedCertificate)
      .where(eq(instanceUploadedCertificate.id, row.uploadedCertId))
    assertEquals(cert?.kind, 'acme-dns-01')
    assertEquals(cert?.dnsNames, [host])
    assert((await decryptSecret(w.deps.dataEncryption, cert!.keyPem)).includes('PRIVATE KEY'))
    assertEquals(w.records.get(`_acme-challenge.${host}`), [])
    assertEquals(w.pushes.length, 1)
    assert(row.state.renewAt)
    assertEquals(row.state.order, null)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('a name outside the connected zones backs off with one alert', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const w = await world(db, `panel-${crypto.randomUUID().slice(0, 8)}.other.org`)
  try {
    const first = await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assert(!('ok' in first))
    assertEquals(first.stage, 'backoff')
    assertEquals(first.lastError?.cause, 'zone-not-on-provider')
    await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(w.sent.length, 1)
    const [row] = await db
      .select()
      .from(instanceHostname)
      .where(eq(instanceHostname.id, w.hostnameId))
    assert(row?.acmeLastError?.includes('not on a connected Cloudflare account'))
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('an order is refused while the authority limit pauses the name', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const w = await world(db, `panel-${crypto.randomUUID().slice(0, 8)}.example.com`)
  try {
    const row = (await loadDns01Row(db, w.hostnameId))!
    const paused = { ...row, state: { ...row.state, stopUntil: '2026-11-02T00:00:00.000Z' } }
    const result = await startOrder(w.deps, paused)
    assert('ok' in result)
    assert(result.error.includes('Nov 2, 2026, 00:00 UTC'), result.error)
    assertEquals(result.error.includes('T00:00'), false)
    const recent = [10, 20, 30, 40].map((min) =>
      new Date(NOW.getTime() - min * 60_000).toISOString()
    )
    const busy = await startOrder(w.deps, { ...row, state: { ...row.state, attemptTimes: recent } })
    assert('ok' in busy)
    assert(busy.error.includes('last hour'))
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('a preflight lookup failure backs off without using the hourly start budget', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const w = await world(db, `panel-${crypto.randomUUID().slice(0, 8)}.example.com`)
  try {
    const deps = { ...w.deps, dns: { ...w.deps.dns, addresses: () => Promise.resolve([]) } }
    const prior = [10, 20].map((min) => new Date(NOW.getTime() - min * 60_000).toISOString())
    const row = (await loadDns01Row(db, w.hostnameId))!
    const failed = await startOrder(deps, { ...row, state: { ...row.state, attemptTimes: prior } })
    assert(!('ok' in failed))
    assertEquals(failed.stage, 'backoff')
    assertEquals(failed.lastError?.cause, 'dns-lookup')
    assertEquals(failed.attemptTimes, prior)
    assertEquals([failed.attempts, failed.lookupFailures], [0, 1])
    assertEquals((await loadDns01Row(db, w.hostnameId))!.state.attemptTimes, prior)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('waiting for the record records dns-lookup when no authoritative server answers', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host)
  try {
    const started = await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assert(!('ok' in started))
    assertEquals(started.stage, 'waiting-dns')
    const later = new Date(NOW.getTime() + TXT_WAIT_MS + 60_000)
    const unreachable: Dns01Deps = {
      ...w.deps,
      now: () => later,
      dns: { ...w.deps.dns, txtAt: () => Promise.reject(new Error('network unreachable')) },
    }
    const failed = await advanceOrder(unreachable, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(failed.stage, 'backoff')
    assertEquals(failed.lastError?.cause, 'dns-lookup')
    assertEquals([failed.attempts, failed.lookupFailures], [0, 1])
    // An order was opened, so its start still counts against the hourly budget.
    assertEquals(failed.attemptTimes, [NOW.toISOString()])
    // The order and its record are kept for the next start; nothing was given up.
    assertEquals(failed.order?.url, started.order?.url)
    assertEquals(w.records.get(`_acme-challenge.${host}`)?.length, 1)
    assertEquals(w.ca.deactivated, [])
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('the tick drives a new acme-dns-01 name to issued and pushes the fallback once at expiry', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const w = await world(db, `panel-${crypto.randomUUID().slice(0, 8)}.example.com`)
  try {
    for (let i = 0; i < 3; i++) await runDns01Tick(w.deps)
    const issued = (await loadDns01Row(db, w.hostnameId))!
    assertEquals(issued.state.stage, 'issued')
    assertEquals(w.pushes.length, 1)

    const later = new Date(Date.parse(issued.notAfter!) + 60_000)
    const expired = { ...w.deps, now: () => later }
    await runDns01Tick(expired)
    await runDns01Tick(expired)
    assertEquals((await loadDns01Row(db, w.hostnameId))!.state.expiryApplied, true)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

/** The deps a minute after the record wait ran out, with no authoritative server reachable. */
function unreachableLater(deps: Dns01Deps): Dns01Deps {
  const later = new Date(NOW.getTime() + TXT_WAIT_MS + 60_000)
  return {
    ...deps,
    now: () => later,
    dns: { ...deps.dns, txtAt: () => Promise.reject(new Error('network unreachable')) },
  }
}

/** The deps a minute after the record wait ran out, with every server answering without the record. */
function invisibleLater(deps: Dns01Deps): Dns01Deps {
  const later = new Date(NOW.getTime() + TXT_WAIT_MS + 60_000)
  return { ...deps, now: () => later, dns: { ...deps.dns, txtAt: () => Promise.resolve([]) } }
}

test('an order dropped without its record being seen has its authorization deactivated', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host)
  try {
    await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    const invisible = invisibleLater(w.deps)
    const failed = await advanceOrder(invisible, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(failed.lastError?.cause, 'txt-not-visible')
    assertEquals(failed.order, null)
    assertEquals(w.ca.deactivated.length, 1)
    assertEquals(failed.abandonedTimes, [invisible.now().toISOString()])
    assertEquals(w.records.get(`_acme-challenge.${host}`), [])
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('a refused deactivation is tolerated and keeps the stored cause', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host, { refuseDeactivation: true })
  try {
    await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    const invisible = invisibleLater(w.deps)
    const failed = await advanceOrder(invisible, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(failed.stage, 'backoff')
    assertEquals(failed.lastError?.cause, 'txt-not-visible')
    assertEquals(w.ca.deactivated, [])
    assertEquals(failed.abandonedTimes.length, 1)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('a record that fails to publish abandons the order it opened', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const w = await world(db, `panel-${crypto.randomUUID().slice(0, 8)}.example.com`)
  try {
    const provider = await w.deps.challengeProvider({} as never)
    let probes = 0
    const failing: Dns01Deps = {
      ...w.deps,
      // The preflight probe write passes; the challenge record write fails.
      challengeProvider: () =>
        Promise.resolve({
          ...provider,
          present: (input) =>
            ++probes === 1 ? provider.present(input) : Promise.reject(new Error('write failed')),
        }),
    }
    const failed = await startOrder(failing, (await loadDns01Row(db, w.hostnameId))!)
    assert(!('ok' in failed))
    assertEquals(failed.stage, 'backoff')
    assertEquals(w.ca.orders.length, 1)
    assertEquals(w.ca.deactivated.length, 1)
    assertEquals(failed.abandonedTimes.length, 1)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('an unreachable nameserver keeps the order, and the next start picks it up again', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host)
  try {
    const started = await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assert(!('ok' in started))
    const kept = await advanceOrder(
      unreachableLater(w.deps),
      (await loadDns01Row(db, w.hostnameId))!
    )
    assertEquals(kept.stage, 'backoff')
    assertEquals(kept.lastError?.cause, 'dns-lookup')
    assertEquals(kept.order?.url, started.order?.url)
    assertEquals(w.records.get(`_acme-challenge.${host}`)?.length, 1)
    assertEquals(w.ca.deactivated, [])

    const resumedAt = new Date(NOW.getTime() + 2 * 60 * 60_000)
    const resumed = await startOrder(
      { ...w.deps, now: () => resumedAt },
      (await loadDns01Row(db, w.hostnameId))!
    )
    assert(!('ok' in resumed))
    assertEquals(resumed.stage, 'waiting-dns')
    assertEquals(resumed.order?.url, started.order?.url)
    assertEquals(resumed.order?.startedAt, resumedAt.toISOString())
    assertEquals(w.ca.orders.length, 1)

    const later = { ...w.deps, now: () => resumedAt }
    const validating = await advanceOrder(later, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(validating.stage, 'validating')
    const issued = await advanceOrder(later, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(issued.stage, 'issued')
    assertEquals(w.ca.issued.length, 1)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('a kept order past its time is deactivated and a new order opens', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host, { authzExpires: '2026-11-01T01:00:00Z' })
  try {
    await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    await advanceOrder(unreachableLater(w.deps), (await loadDns01Row(db, w.hostnameId))!)
    const again = await startOrder(
      { ...w.deps, now: () => new Date(NOW.getTime() + 2 * 60 * 60_000) },
      (await loadDns01Row(db, w.hostnameId))!
    )
    assert(!('ok' in again))
    assertEquals(again.stage, 'waiting-dns')
    assertEquals(w.ca.orders.length, 2)
    assertEquals(w.ca.deactivated.length, 1)
    assertEquals(again.abandonedTimes.length, 1)
    // Only the new order's record is left.
    assertEquals(w.records.get(`_acme-challenge.${host}`)?.length, 1)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('the daily cap stops new orders but still runs the preflight, and Retry lifts it', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const w = await world(db, `panel-${crypto.randomUUID().slice(0, 8)}.example.com`)
  try {
    const abandonedTimes = Array.from({ length: DNS01_MAX_ABANDONED_PER_DAY }, (_, i) =>
      new Date(NOW.getTime() - (i + 1) * 60 * 60_000).toISOString()
    )
    const row = (await loadDns01Row(db, w.hostnameId))!
    const full = { ...row, state: { ...row.state, abandonedTimes } }
    const capped = await startOrder(w.deps, full)
    assert(!('ok' in capped))
    assertEquals(capped.stage, 'backoff')
    assertEquals(capped.order, null)
    assertEquals(capped.attemptTimes, [])
    assertEquals(capped.nextAttemptAt, new Date(NOW.getTime() + 60 * 60_000).toISOString())
    assert(capped.lastError?.detail.includes('Retry'))
    assertEquals(capped.lastError?.cause, 'order-cap')
    assertEquals(w.ca.orders.length, 0)
    // Holding new orders back is told to the operator once, like any other failure.
    assertEquals(
      w.sent.map((ctx) => ctx.cause),
      ['order-cap']
    )

    // The preflight still runs while capped: a lookup failure is recorded as such.
    const noAddresses = { ...w.deps, dns: { ...w.deps.dns, addresses: () => Promise.resolve([]) } }
    const lookup = await startOrder(noAddresses, (await loadDns01Row(db, w.hostnameId))!)
    assert(!('ok' in lookup))
    assertEquals(lookup.lastError?.cause, 'dns-lookup')
    assertEquals(w.ca.orders.length, 0)

    const stored = (await loadDns01Row(db, w.hostnameId))!
    const retried = await startOrder(w.deps, { ...stored, state: clearedForRetry(stored.state) })
    assert(!('ok' in retried))
    assertEquals(retried.stage, 'waiting-dns')
    assertEquals(w.ca.orders.length, 1)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('a refused order is mapped as before and deactivates nothing', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const w = await world(db, `panel-${crypto.randomUUID().slice(0, 8)}.example.com`, {
    rateLimitOrders: true,
  })
  try {
    const failed = await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assert(!('ok' in failed))
    assertEquals(failed.lastError?.cause, 'acme-error')
    assert(failed.stopUntil)
    assertEquals(w.ca.deactivated, [])
    assertEquals(failed.abandonedTimes, [])
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('an order the authority does not finish validating in time is deactivated', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host, { holdValidation: true })
  try {
    await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    const validating = await advanceOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(validating.stage, 'validating')
    const later = new Date(NOW.getTime() + ORDER_TIMEOUT_MS + 60_000)
    const late = { ...w.deps, now: () => later }
    const failed = await advanceOrder(late, (await loadDns01Row(db, w.hostnameId))!)
    assertEquals(failed.lastError?.cause, 'acme-error')
    assertEquals(failed.order, null)
    // The answered authorization is still pending at the authority, which accepts deactivating it.
    assertEquals(w.ca.deactivated.length, 1)
    assertEquals(failed.abandonedTimes, [later.toISOString()])
    assertEquals(w.records.get(`_acme-challenge.${host}`), [])
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('a kept order given up before a new order that fails is given up once', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host, { authzExpires: '2026-11-01T01:00:00Z', ordersBeforeFailure: 1 })
  try {
    await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    await advanceOrder(unreachableLater(w.deps), (await loadDns01Row(db, w.hostnameId))!)
    const failed = await startOrder(
      { ...w.deps, now: () => new Date(NOW.getTime() + 2 * 60 * 60_000) },
      (await loadDns01Row(db, w.hostnameId))!
    )
    assert(!('ok' in failed))
    assertEquals(failed.stage, 'backoff')
    assertEquals(failed.order, null)
    assertEquals(w.ca.orders.length, 1)
    assertEquals(w.ca.deactivationAsked.length, 1)
    assertEquals(w.ca.deactivated.length, 1)
    assertEquals(failed.abandonedTimes.length, 1)
    assertEquals(w.records.get(`_acme-challenge.${host}`), [])
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('a kept order whose record cannot be removed is still given up once', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host, { authzExpires: '2026-11-01T01:00:00Z' })
  try {
    await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    await advanceOrder(unreachableLater(w.deps), (await loadDns01Row(db, w.hostnameId))!)
    const provider = await w.deps.challengeProvider({} as never)
    let calls = 0
    const failed = await startOrder(
      {
        ...w.deps,
        now: () => new Date(NOW.getTime() + 2 * 60 * 60_000),
        // The preflight gets the provider; removing the kept order's record then fails.
        challengeProvider: () =>
          ++calls === 2 ? Promise.reject(new Error('provider down')) : Promise.resolve(provider),
      },
      (await loadDns01Row(db, w.hostnameId))!
    )
    assert(!('ok' in failed))
    assertEquals(failed.stage, 'backoff')
    assertEquals(failed.order, null)
    assertEquals(w.ca.orders.length, 1)
    assertEquals(w.ca.deactivationAsked.length, 1)
    assertEquals(failed.abandonedTimes.length, 1)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})

test('a kept order whose authorization cannot be read right now stays kept', async () => {
  if (!dbUrl) return skipWithoutDatabase('DNS-01 order tests')
  const db = createDenoDb()
  const host = `panel-${crypto.randomUUID().slice(0, 8)}.example.com`
  const w = await world(db, host)
  try {
    const started = await startOrder(w.deps, (await loadDns01Row(db, w.hostnameId))!)
    assert(!('ok' in started))
    await advanceOrder(unreachableLater(w.deps), (await loadDns01Row(db, w.hostnameId))!)

    w.ca.failAuthzReads(1)
    const busyAt = new Date(NOW.getTime() + 2 * 60 * 60_000)
    const busy = await startOrder(
      { ...w.deps, now: () => busyAt },
      (await loadDns01Row(db, w.hostnameId))!
    )
    assert(!('ok' in busy))
    assertEquals(busy.stage, 'backoff')
    assertEquals(busy.order?.url, started.order?.url)
    assertEquals(w.ca.orders.length, 1)
    assertEquals(w.ca.deactivationAsked, [])
    assertEquals(busy.abandonedTimes, [])
    assertEquals(w.records.get(`_acme-challenge.${host}`)?.length, 1)

    const resumedAt = new Date(NOW.getTime() + 3 * 60 * 60_000)
    const resumed = await startOrder(
      { ...w.deps, now: () => resumedAt },
      (await loadDns01Row(db, w.hostnameId))!
    )
    assert(!('ok' in resumed))
    assertEquals(resumed.stage, 'waiting-dns')
    assertEquals(resumed.order?.url, started.order?.url)
    assertEquals(w.ca.orders.length, 1)
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})
