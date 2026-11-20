/**
 * The DNS relay against a real database and a faked DNS host: the daemon's
 * `acme-dns-publish` is answered only once the record reads back, a record the
 * token's zone does not cover is refused, a request nobody knows is refused,
 * only the issuing server of an open request may publish, and a remove takes
 * away exactly the records the panel made, by id. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../../db/connection.ts'
import { getDatabaseUrl } from '../../../db/url.ts'
import { organization, server, tls } from '../../../db/schema.ts'
import type { AcmeDnsPublishedMessage } from '../../../contracts/cell-protocol.ts'
import { deriveEncryptionSecretsConfig } from '../../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../../test-fixtures/secrets.ts'
import type { CredentialReport, TunnelAdapter } from '../../tunnels/adapter.ts'
import { TunnelProviderError } from '../../tunnels/errors.ts'
import { insertBadge, insertCarrier, sealToken } from '../../tunnels/records.ts'
import type { DnsChallengeProvider } from '../dns-certificates/dns-provider.ts'
import { readDnsCertState } from '../dns-certificates/order-state.ts'
import {
  checkRecords,
  confirmThroughProvider,
  type DnsRelayDeps,
  handleDnsPublish,
  handleDnsRemove,
} from './dns-relay.ts'
import { newHttpIssuanceState } from './state.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test}; keeps Sonar's test detection happy. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const ZONE = { id: 'zone-1', name: 'example.com' }
const AT = '2026-11-01T12:00:00.000Z'
const REQUEST = 'req_relay_1'

const report: CredentialReport = {
  accounts: [],
  zones: [],
  accountVisible: true,
  capabilities: { tunnels: false, dns: [ZONE], certificates: [] },
  missing: [],
  token: { kind: 'account', id: null, status: 'active', expiresAt: null },
}

/** A DNS host that keeps its records in memory; `visible` decides what reads back. */
function fakeHost(visible: () => boolean) {
  const records = new Map<string, { zoneId: string; name: string; value: string }>()
  let n = 0
  const dns: DnsChallengeProvider = {
    lookupCname: () => Promise.resolve(null),
    present: (input) => {
      n += 1
      const recordId = `rec-${n}`
      records.set(recordId, input)
      return Promise.resolve({ zoneId: input.zoneId, recordId })
    },
    remove: (ref) => {
      records.delete(ref.recordId)
      return Promise.resolve()
    },
    nameservers: () => Promise.resolve(['ns-a.example.net', 'ns-b.example.net']),
    txtValues: ({ name }) =>
      Promise.resolve(
        visible() ? [...records.values()].filter((r) => r.name === name).map((r) => r.value) : []
      ),
  }
  return { dns, records }
}

const adapters = (): TunnelAdapter =>
  ({
    provider: 'cloudflare',
    findZone: () => Promise.resolve({ id: ZONE.id, name: ZONE.name }),
  }) as unknown as TunnelAdapter

type World = {
  deps: DnsRelayDeps
  replies: AcmeDnsPublishedMessage[]
  serverId: string
  otherServerId: string
  rowId: string
  host: ReturnType<typeof fakeHost>
  db: ReturnType<typeof createDenoDb>
}

async function withWorld(
  options: { visible?: () => boolean; names?: string[]; ended?: boolean },
  fn: (w: World) => Promise<void>
): Promise<void> {
  if (!dbUrl) return skipWithoutDatabase('dns relay tests')
  const db = createDenoDb()
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [org] = await db
    .insert(organization)
    .values({ name: `Relay Org ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const [a] = await db
      .insert(server)
      .values({ organizationId, name: 'issuer' })
      .returning({ id: server.id })
    const [b] = await db
      .insert(server)
      .values({ organizationId, name: 'other' })
      .returning({ id: server.id })
    const carrier = await insertCarrier(db, {
      organizationId,
      provider: 'cloudflare',
      name: 'Main',
      externalAccountId: 'acct-1',
    })
    await insertBadge(db, {
      organizationId,
      carrier,
      label: 'dns-token',
      sealed: await sealToken(secrets, 'dns-token'),
      lastFour: 'oken',
      report,
    })
    const names = options.names ?? ['example.com', '*.example.com']
    const state = newHttpIssuanceState({
      issuingServerId: a!.id,
      requestId: REQUEST,
      startedAt: AT,
      startByAt: '2026-11-01T12:15:00.000Z',
      challenge: 'dns-01',
      orderNames: names,
      endedAt: options.ended ? AT : null,
    })
    const [row] = await db
      .insert(tls)
      .values({
        organizationId,
        name: 'Order',
        source: 'lets_encrypt',
        status: 'automatic',
        metadata: { dnsNames: names, httpCert: state },
      })
      .returning({ id: tls.id })
    const host = fakeHost(options.visible ?? (() => true))
    const replies: AcmeDnsPublishedMessage[] = []
    let clock = Date.parse(AT)
    const deps: DnsRelayDeps = {
      db,
      secrets,
      dns: () => host.dns,
      adapters: adapters as unknown as DnsRelayDeps['adapters'],
      confirm: confirmThroughProvider,
      reply: (m) => {
        replies.push(m)
        return Promise.resolve()
      },
      now: () => new Date(clock),
      sleep: (ms) => {
        clock += ms
        return Promise.resolve()
      },
      readbackTimeoutMs: 20_000,
      readbackPollMs: 5_000,
    }
    await fn({ deps, replies, serverId: a!.id, otherServerId: b!.id, rowId: row!.id, host, db })
  } finally {
    await db.delete(tls).where(eq(tls.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

const publishMessage = (records: { name: string; value: string }[]) =>
  ({ type: 'acme-dns-publish', requestId: REQUEST, records, at: AT }) as const

test('checkRecords accepts the names of the order and refuses everything else', () => {
  const order = ['example.com', '*.example.com']
  const ok = { name: '_acme-challenge.example.com', value: 'abc_DEF-123' }
  assertEquals(checkRecords([ok], order), null)
  assertEquals(checkRecords([ok, { ...ok, value: 'other' }], order), null)
  assert(checkRecords([], order) !== null)
  assert(checkRecords([{ ...ok, name: '_acme-challenge.evil.net' }], order) !== null)
  assert(checkRecords([{ ...ok, name: 'www.example.com' }], order) !== null)
  assert(checkRecords([{ ...ok, value: 'has space' }], order) !== null)
  assert(checkRecords([ok, ok], order) !== null)
})

test('publish answers ok only after the record reads back, and lists the record by id', async () => {
  await withWorld({}, async (w) => {
    await handleDnsPublish(
      w.deps,
      w.serverId,
      publishMessage([{ name: '_acme-challenge.example.com', value: 'tok1' }])
    )
    assertEquals(
      w.replies.map((r) => r.ok),
      [true]
    )
    assertEquals(w.host.records.size, 1)
    const [row] = await w.db.select().from(tls).where(eq(tls.id, w.rowId))
    assertEquals(readDnsCertState(row!.metadata)?.records.length, 1)
  })
})

test('a record that never reads back is answered as an error and removed again', async () => {
  await withWorld({ visible: () => false }, async (w) => {
    await handleDnsPublish(
      w.deps,
      w.serverId,
      publishMessage([{ name: '_acme-challenge.example.com', value: 'tok1' }])
    )
    assertEquals(w.replies.length, 1)
    assertEquals(w.replies[0]!.ok, false)
    assert((w.replies[0]!.error ?? '').length > 0)
    assertEquals(w.host.records.size, 0)
  })
})

test('a name outside every zone the token covers is refused and nothing is written', async () => {
  await withWorld({ names: ['example.org'] }, async (w) => {
    const none = {
      ...w.deps,
      adapters: (() => ({
        findZone: () => Promise.reject(new TunnelProviderError('zone_not_found', 'none', null)),
      })) as unknown as DnsRelayDeps['adapters'],
    }
    await handleDnsPublish(
      none,
      w.serverId,
      publishMessage([{ name: '_acme-challenge.example.org', value: 'tok1' }])
    )
    assertEquals(
      w.replies.map((r) => r.ok),
      [false]
    )
    assertEquals(w.host.records.size, 0)
  })
})

test('an unknown request, another server and a closed request are all refused', async () => {
  await withWorld({}, async (w) => {
    const rec = [{ name: '_acme-challenge.example.com', value: 'tok1' }]
    await handleDnsPublish(w.deps, w.serverId, { ...publishMessage(rec), requestId: 'req_nobody' })
    await handleDnsPublish(w.deps, w.otherServerId, publishMessage(rec))
    assertEquals(
      w.replies.map((r) => r.ok),
      [false, false]
    )
    assertEquals(w.host.records.size, 0)
  })
  await withWorld({ ended: true }, async (w) => {
    await handleDnsPublish(
      w.deps,
      w.serverId,
      publishMessage([{ name: '_acme-challenge.example.com', value: 'tok1' }])
    )
    assertEquals(
      w.replies.map((r) => r.ok),
      [false]
    )
    assertEquals(w.host.records.size, 0)
  })
})

test('remove takes away the records the panel made; another server cannot', async () => {
  await withWorld({}, async (w) => {
    await handleDnsPublish(
      w.deps,
      w.serverId,
      publishMessage([{ name: '_acme-challenge.example.com', value: 'tok1' }])
    )
    const remove = { type: 'acme-dns-remove', requestId: REQUEST, at: AT } as const
    await handleDnsRemove(w.deps, w.otherServerId, remove)
    assertEquals(w.host.records.size, 1)
    await handleDnsRemove(w.deps, w.serverId, remove)
    assertEquals(w.host.records.size, 0)
    const [row] = await w.db.select().from(tls).where(eq(tls.id, w.rowId))
    assertEquals(readDnsCertState(row!.metadata)?.records.length, 0)
  })
})

test('the read-back gets the zone nameservers from the provider', async () => {
  const seen: string[][] = []
  await withWorld({}, async (w) => {
    const deps: DnsRelayDeps = {
      ...w.deps,
      confirm: (input) => {
        return input.dns.nameservers!(input.zoneId).then((ns) => {
          seen.push(ns)
          return true
        })
      },
    }
    await handleDnsPublish(
      deps,
      w.serverId,
      publishMessage([{ name: '_acme-challenge.example.com', value: 'tok1' }])
    )
    assertEquals(w.replies.map((r) => r.ok), [true])
    assertEquals(seen.at(-1), ['ns-a.example.net', 'ns-b.example.net'])
  })
})

test('one deadline covers every record: a slow second read-back cannot start a new wait', async () => {
  let reads = 0
  await withWorld({}, async (w) => {
    const deps: DnsRelayDeps = {
      ...w.deps,
      readbackTimeoutMs: 10_000,
      readbackPollMs: 4_000,
      confirm: () => {
        reads += 1
        return Promise.resolve(false)
      },
    }
    await handleDnsPublish(
      deps,
      w.serverId,
      publishMessage([
        { name: '_acme-challenge.example.com', value: 'tok1' },
        { name: '_acme-challenge.example.com', value: 'tok2' },
      ])
    )
    assertEquals(w.replies.map((r) => r.ok), [false])
    // 10s of budget at a 4s poll is three reads in all, not three per record.
    assert(reads <= 3, `reads ${reads}`)
    assertEquals(w.host.records.size, 0)
  })
})

test('both values of an apex plus wildcard order are listed on the row', async () => {
  await withWorld({}, async (w) => {
    await handleDnsPublish(
      w.deps,
      w.serverId,
      publishMessage([
        { name: '_acme-challenge.example.com', value: 'tok1' },
        { name: '_acme-challenge.example.com', value: 'tok2' },
      ])
    )
    assertEquals(w.replies.map((r) => r.ok), [true])
    assertEquals([...w.host.records.values()].map((r) => r.value).sort(), ['tok1', 'tok2'])
    const [row] = await w.db.select().from(tls).where(eq(tls.id, w.rowId))
    assertEquals(readDnsCertState(row!.metadata)?.records.length, 2)
  })
})
