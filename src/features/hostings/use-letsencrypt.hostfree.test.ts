import { assertEquals } from '@std/assert'
import { readPendingLetsEncrypt } from './hosting-certificate.ts'
import type { DnsLookup } from './hosting-dns-check.ts'
import {
  type LetsEncryptHostingRecord,
  type LetsEncryptStore,
  requestLetsEncrypt,
  retryPendingLetsEncrypt,
} from './use-letsencrypt.ts'

const test = Deno.test.bind(Deno)

const NOW = new Date('2026-10-04T12:00:00.000Z')
const SERVER_IP = '203.0.113.7'

type Saved = Parameters<LetsEncryptStore['saveHosting']>
function fakeStore(existing: string | null = null) {
  const saved: Saved[] = []
  const created: string[][] = []
  const store: LetsEncryptStore = {
    expectedAddresses: () => Promise.resolve([SERVER_IP]),
    findManagedCertificate: () => Promise.resolve(existing),
    createManagedCertificate: (_org, names) => {
      created.push([...names])
      return Promise.resolve('tls-new')
    },
    saveHosting: (id, patch) => {
      saved.push([id, patch])
      return Promise.resolve()
    },
  }
  return { store, saved, created }
}

const pointing: DnsLookup = () => Promise.resolve([SERVER_IP])
const nowhere: DnsLookup = () => Promise.reject(new Error('NXDOMAIN'))

function record(overrides: Partial<LetsEncryptHostingRecord> = {}): LetsEncryptHostingRecord {
  return {
    id: 'h1',
    organizationId: 'o1',
    tlsId: null,
    options: { hostnames: ['shop.example.com'] },
    metadata: null,
    ...overrides,
  }
}

test("refuses when the organization has not allowed Let's Encrypt", async () => {
  const { store, saved } = fakeStore()
  const out = await requestLetsEncrypt({
    store,
    lookup: pointing,
    now: NOW,
    hosting: record(),
    acmeEnabled: false,
    wwwRedirect: false,
  })
  assertEquals(out, { ok: false, error: 'lets_encrypt_not_enabled' })
  assertEquals(saved.length, 0)
})

test('refuses a local bind and a non-http hosting', async () => {
  const { store } = fakeStore()
  const base = { store, lookup: pointing, now: NOW, acmeEnabled: true, wwwRedirect: false }
  const local = await requestLetsEncrypt({
    ...base,
    hosting: record({ options: { hostnames: ['a.example.com'], bind: 'local' } }),
  })
  assertEquals(local, { ok: false, error: 'acme_requires_public_bind' })
  const tcp = await requestLetsEncrypt({
    ...base,
    hosting: record({
      options: {
        hostnames: ['a.example.com'],
        protocol: 'tcp',
        ports: [{ published: 1, target: 1 }],
      },
    }),
  })
  assertEquals(tcp, { ok: false, error: 'hosting_not_http' })
})

test('DNS ready: creates the certificate row, pins it, clears any waiting request', async () => {
  const { store, saved, created } = fakeStore()
  const pendingMeta = {
    letsEncryptPending: { requestedAt: NOW.toISOString(), wwwRedirect: false, dns: null },
    keep: 1,
  }
  const out = await requestLetsEncrypt({
    store,
    lookup: pointing,
    now: NOW,
    hosting: record({ metadata: pendingMeta }),
    acmeEnabled: true,
    wwwRedirect: true,
  })
  assertEquals(out.ok && out.outcome, 'pinned')
  assertEquals(created, [['shop.example.com', 'www.shop.example.com']])
  const [id, patch] = saved[0]!
  assertEquals(id, 'h1')
  assertEquals(patch.tlsId, 'tls-new')
  assertEquals(patch.options?.wwwRedirect, true)
  assertEquals(patch.metadata, { keep: 1 })
})

test('clicking again reuses the existing certificate row', async () => {
  const { store, created } = fakeStore('tls-old')
  const out = await requestLetsEncrypt({
    store,
    lookup: pointing,
    now: NOW,
    hosting: record(),
    acmeEnabled: true,
    wwwRedirect: false,
  })
  assertEquals(out.ok && out.outcome === 'pinned' && out.tlsId, 'tls-old')
  assertEquals(created.length, 0)
})

test('DNS not ready: nothing is pinned and the request is remembered with its first time', async () => {
  const { store, saved } = fakeStore()
  const first = await requestLetsEncrypt({
    store,
    lookup: nowhere,
    now: NOW,
    hosting: record(),
    acmeEnabled: true,
    wwwRedirect: false,
  })
  assertEquals(first.ok && first.outcome, 'waiting')
  const patch = saved[0]![1]
  assertEquals(patch.tlsId, undefined)
  const pending = readPendingLetsEncrypt(patch.metadata)
  assertEquals(pending?.requestedAt, NOW.toISOString())
  assertEquals(pending?.dns?.ready, false)

  const later = new Date(NOW.getTime() + 3_600_000)
  await requestLetsEncrypt({
    store,
    lookup: nowhere,
    now: later,
    hosting: record({ metadata: patch.metadata }),
    acmeEnabled: true,
    wwwRedirect: false,
  })
  assertEquals(readPendingLetsEncrypt(saved[1]![1].metadata)?.requestedAt, NOW.toISOString())
})

function waiting(requestedAt: string, wwwRedirect = false) {
  return record({ metadata: { letsEncryptPending: { requestedAt, wwwRedirect, dns: null } } })
}

test('the sweep pins a waiting request once DNS resolves, using the saved www choice', async () => {
  const { store, created } = fakeStore()
  const out = await retryPendingLetsEncrypt({
    store,
    lookup: pointing,
    now: NOW,
    hosting: waiting(NOW.toISOString(), true),
    acmeEnabled: true,
  })
  assertEquals(out, 'pinned')
  assertEquals(created[0], ['shop.example.com', 'www.shop.example.com'])
})

test('the sweep leaves a still-waiting request in place', async () => {
  const { store } = fakeStore()
  const out = await retryPendingLetsEncrypt({
    store,
    lookup: nowhere,
    now: NOW,
    hosting: waiting(NOW.toISOString()),
    acmeEnabled: true,
  })
  assertEquals(out, 'waiting')
})

test('the sweep drops a request older than a week, or one no longer allowed', async () => {
  const old = new Date(NOW.getTime() - 8 * 86_400_000).toISOString()
  const a = fakeStore()
  assertEquals(
    await retryPendingLetsEncrypt({
      store: a.store,
      lookup: pointing,
      now: NOW,
      hosting: waiting(old),
      acmeEnabled: true,
    }),
    'expired'
  )
  assertEquals(readPendingLetsEncrypt(a.saved[0]![1].metadata), null)
  const b = fakeStore()
  assertEquals(
    await retryPendingLetsEncrypt({
      store: b.store,
      lookup: pointing,
      now: NOW,
      hosting: waiting(NOW.toISOString()),
      acmeEnabled: false,
    }),
    'refused'
  )
  assertEquals(b.created.length, 0)
})
