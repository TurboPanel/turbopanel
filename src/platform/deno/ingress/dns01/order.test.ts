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
import { createFakeCa, FAKE_CA_DIRECTORY } from '../../../../lib/acme/fake-ca.test.support.ts'
import { decryptSecret, encryptSecret } from '../../../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../../../lib/secrets/secrets.ts'
import type { NotificationContext } from '../../../../features/notifications/events.ts'
import { skipWithoutDatabase } from '../../../../test-fixtures/require-service.test.support.ts'
import { parseTestSecretsConfig } from '../../../../test-fixtures/secrets.ts'
import { advanceOrder, type Dns01Deps, loadDns01Row, startOrder } from './order.ts'

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
    .values({ host: `https://${host}:8443`, source: 'dns-01' })
    .returning({ id: instanceHostname.id })
  return { hostnameId: row!.id, accountId: account!.id }
}

async function world(db: Db, host: string): Promise<World> {
  const records = new Map<string, string[]>()
  const ca = createFakeCa({ txt: (name) => records.get(name) ?? [] })
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
  return { deps, hostnameId, records, sent, pushes }
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

test('a DNS-01 order goes from idle to issued and stores a sealed dns-01 pair', async () => {
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
    assertEquals(cert?.kind, 'dns-01')
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
    assert(result.error.includes('2026-11-02'))
  } finally {
    await cleanup(db, w.hostnameId)
    await endDbConnection(db)
  }
})
