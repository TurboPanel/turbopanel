/**
 * `fabric-peers-report` stamping (no Postgres): only the reporter's relays,
 * at most once per 60 s while no peer changes health class, never older than
 * what the row holds, and never touching `appliedPayloadHash`.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  clampObservedAt,
  FABRIC_PEER_REPORT_MIN_INTERVAL_MS,
  FabricPeerReportThrottle,
  handleFabricPeersReport,
  normalizeReportedPeer,
  takeFabricPeersReport,
} from './peer-report.ts'
import { planRelayObservedStamp, type RelayMetadata } from './fabric-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const NOW_MS = Date.parse('2026-10-30T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

type Row = { id: string; serverId: string; metadata: RelayMetadata }

/** Just enough of drizzle for `stampRelayObservedPeers`: one select, row updates. */
function fakeDb(rows: Row[]) {
  const writes: Array<{ id: string; metadata: RelayMetadata }> = []
  let selectedServer: string | undefined
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows.filter((row) => row.serverId === selectedServer)),
      }),
    }),
    update: () => ({
      set: (values: { metadata: RelayMetadata }) => ({
        where: () => {
          writes.push({ id: pendingId.shift() ?? '', metadata: values.metadata })
          return Promise.resolve()
        },
      }),
    }),
  }
  const pendingId: string[] = []
  return {
    db: db as unknown as Db,
    writes,
    selectServer: (serverId: string) => {
      selectedServer = serverId
      pendingId.push(...rows.filter((row) => row.serverId === serverId).map((row) => row.id))
    },
  }
}

test('the in-memory throttle lets one stamp per server through each minute', () => {
  const throttle = new FabricPeerReportThrottle()
  assertEquals(throttle.take('srv-a', NOW_MS), true)
  assertEquals(throttle.take('srv-a', NOW_MS + 30_000), false)
  assertEquals(throttle.take('srv-b', NOW_MS + 30_000), true)
  assertEquals(throttle.take('srv-a', NOW_MS + FABRIC_PEER_REPORT_MIN_INTERVAL_MS), true)
})

test('planRelayObservedStamp throttles, refuses older readings, keeps the hash', () => {
  const options = { nowMs: NOW_MS, minIntervalMs: FABRIC_PEER_REPORT_MIN_INTERVAL_MS }
  const reading = { at: iso(NOW_MS), peers: [{ publicKey: KEY }] }
  const recent = {
    appliedPayloadHash: 'h1',
    observed: { at: iso(NOW_MS - 30_000), peers: [{ publicKey: KEY }] },
  }
  assertEquals(planRelayObservedStamp(recent, reading, options), null)

  const newer = { appliedPayloadHash: 'h1', observed: { at: iso(NOW_MS + 1), peers: [] } }
  assertEquals(planRelayObservedStamp(newer, reading, options), null)

  const old = {
    appliedPayloadHash: 'h1',
    appliedAt: 'x',
    observed: { at: iso(NOW_MS - 61_000), peers: [] },
  }
  const merged = planRelayObservedStamp(old, reading, options)
  assertEquals(merged?.appliedPayloadHash, 'h1')
  assertEquals(merged?.appliedAt, 'x')
  assertEquals(merged?.observed, reading)

  assertEquals(planRelayObservedStamp(null, reading, options)?.observed, reading)
})

test('handleFabricPeersReport stamps only the reporting server, with known fields', async () => {
  const fake = fakeDb([
    { id: 'relay-a', serverId: 'srv-a', metadata: { appliedPayloadHash: 'keep' } },
    { id: 'relay-b', serverId: 'srv-b', metadata: {} },
  ])
  fake.selectServer('srv-a')
  const peer = { publicKey: KEY, health: 'healthy' as const, extra: 'drop me' }
  const outcome = await handleFabricPeersReport(fake.db, {
    reporterServerId: 'srv-a',
    peers: [peer],
    observedAt: iso(NOW_MS - 1_000),
    nowMs: NOW_MS,
  })
  assertEquals(outcome, { stamped: 1 })
  assertEquals(fake.writes.length, 1)
  assertEquals(fake.writes[0]?.id, 'relay-a')
  assertEquals(fake.writes[0]?.metadata.appliedPayloadHash, 'keep')
  assertEquals(fake.writes[0]?.metadata.observed, {
    at: iso(NOW_MS - 1_000),
    peers: [{ publicKey: KEY, health: 'healthy' }],
  })
})

test('a reading stamped within the last minute is not rewritten', async () => {
  const fake = fakeDb([
    {
      id: 'relay-a',
      serverId: 'srv-a',
      metadata: { observed: { at: iso(NOW_MS - 20_000), peers: [{ publicKey: KEY }] } },
    },
  ])
  fake.selectServer('srv-a')
  const outcome = await handleFabricPeersReport(fake.db, {
    reporterServerId: 'srv-a',
    peers: [{ publicKey: KEY }],
    observedAt: iso(NOW_MS),
    nowMs: NOW_MS,
  })
  assertEquals(outcome, { stamped: 0 })
  assertEquals(fake.writes, [])
})

test('a reading from a clock ahead of ours is clamped to the receive time', () => {
  assertEquals(clampObservedAt(iso(NOW_MS + 90_000), NOW_MS), iso(NOW_MS))
  assertEquals(clampObservedAt(iso(NOW_MS - 5_000), NOW_MS), iso(NOW_MS - 5_000))
  assertEquals(clampObservedAt('garbage', NOW_MS), iso(NOW_MS))
})

test('normalizeReportedPeer keeps every known field', () => {
  const full = {
    publicKey: KEY,
    lastHandshakeAt: iso(NOW_MS),
    transferRx: 1,
    transferTx: 2,
    endpoint: '203.0.113.7:51820',
    health: 'stale' as const,
    interface: 'eth0',
  }
  assertEquals(normalizeReportedPeer(full), full)
})

const healthy = [{ publicKey: KEY, health: 'healthy' as const }]
const down = [{ publicKey: KEY, health: 'stale' as const }]

test('the in-memory throttle never holds back a change of health class', () => {
  const throttle = new FabricPeerReportThrottle()
  assertEquals(throttle.take('srv-a', NOW_MS, 'k=healthy'), true)
  assertEquals(throttle.take('srv-a', NOW_MS + 10_000, 'k=healthy'), false)
  assertEquals(throttle.take('srv-a', NOW_MS + 20_000, 'k=stale'), true)
  assertEquals(throttle.take('srv-a', NOW_MS + 30_000, 'k=stale'), false)
  assertEquals(throttle.take('srv-a', NOW_MS + 40_000, 'k=healthy'), true)
})

test('takeFabricPeersReport lets a down report through within the minute', () => {
  const throttle = new FabricPeerReportThrottle()
  const frame = (peers: typeof healthy | typeof down, ms: number) => ({
    peers,
    observedAt: iso(ms),
  })
  assertEquals(takeFabricPeersReport(throttle, 'srv-a', frame(healthy, NOW_MS), NOW_MS), true)
  const sameAt = NOW_MS + 30_000
  assertEquals(takeFabricPeersReport(throttle, 'srv-a', frame(healthy, sameAt), sameAt), false)
  const downAt = NOW_MS + 40_000
  assertEquals(takeFabricPeersReport(throttle, 'srv-a', frame(down, downAt), downAt), true)
})

test('both socket paths gate peer reports by health class', async () => {
  for (const path of ['../../daemon/cell/do.ts', '../../daemon/deno-ws.ts']) {
    const source = await Deno.readTextFile(new URL(path, import.meta.url))
    assertEquals(source.includes('takeFabricPeersReport('), true, path)
    assertEquals(source.includes('fabricPeerReportThrottle.take('), false, path)
  }
})

test('planRelayObservedStamp writes a class change inside the minute', () => {
  const options = { nowMs: NOW_MS, minIntervalMs: FABRIC_PEER_REPORT_MIN_INTERVAL_MS }
  const stored = { observed: { at: iso(NOW_MS - 20_000), peers: healthy } }
  const same = { at: iso(NOW_MS), peers: healthy }
  assertEquals(planRelayObservedStamp(stored, same, options), null)
  const changed = { at: iso(NOW_MS), peers: down }
  assertEquals(planRelayObservedStamp(stored, changed, options)?.observed, changed)
  // An older reading is still refused, even with a different class.
  const older = { at: iso(NOW_MS - 30_000), peers: down }
  assertEquals(planRelayObservedStamp(stored, older, options), null)
})

test('a down report right after a reconcile stamp is stored', async () => {
  const reconciled = { observed: { at: iso(NOW_MS - 10_000), peers: healthy } }
  const fake = fakeDb([{ id: 'relay-a', serverId: 'srv-a', metadata: reconciled }])
  fake.selectServer('srv-a')
  const outcome = await handleFabricPeersReport(fake.db, {
    reporterServerId: 'srv-a',
    peers: down,
    observedAt: iso(NOW_MS),
    nowMs: NOW_MS,
  })
  assertEquals(outcome, { stamped: 1 })
  assertEquals(fake.writes[0]?.metadata.observed, { at: iso(NOW_MS), peers: down })
})

test('a same-class report right after a reconcile stamp is still throttled', async () => {
  const reconciled = { observed: { at: iso(NOW_MS - 10_000), peers: healthy } }
  const fake = fakeDb([{ id: 'relay-a', serverId: 'srv-a', metadata: reconciled }])
  fake.selectServer('srv-a')
  const outcome = await handleFabricPeersReport(fake.db, {
    reporterServerId: 'srv-a',
    peers: healthy,
    observedAt: iso(NOW_MS),
    nowMs: NOW_MS,
  })
  assertEquals(outcome, { stamped: 0 })
  assertEquals(fake.writes, [])
})
