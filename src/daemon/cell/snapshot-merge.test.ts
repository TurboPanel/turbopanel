import { assertEquals } from '@std/assert'
import type { DaemonCellSnapshot } from './contracts.ts'
import { mergeSnapshotPresence } from './snapshot-merge.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const storedBase: DaemonCellSnapshot = {
  serverId: 'srv-merge',
  version: 4,
  updatedAt: '2020-01-02T00:00:00.000Z',
  connected: false,
  connectedAt: '2020-01-01T00:00:00.000Z',
  lastSeenAt: '2020-01-01T00:00:30.000Z',
  lastInboundAt: '2020-01-01T00:00:20.000Z',
  remoteAddress: '203.0.113.10',
  keyLastUsedAt: '2020-01-01T00:00:00.000Z',
  daemonBuild: { commit: 'stored', buildId: 'b1' },
}

test('mergeSnapshotPresence overlays all presence fields from meta', () => {
  const meta: DaemonCellSnapshot = {
    serverId: 'srv-merge',
    version: 4,
    updatedAt: '2020-01-03T00:00:00.000Z',
    connected: true,
    connectedAt: '2020-01-03T00:00:00.000Z',
    lastSeenAt: '2020-01-03T00:00:10.000Z',
    remoteAddress: '203.0.113.11',
  }

  const merged = mergeSnapshotPresence(storedBase, meta)
  assertEquals(merged.connected, true)
  assertEquals(merged.connectedAt, '2020-01-03T00:00:00.000Z')
  assertEquals(merged.lastSeenAt, '2020-01-03T00:00:10.000Z')
  assertEquals(merged.remoteAddress, '203.0.113.11')
  assertEquals(merged.updatedAt, '2020-01-03T00:00:00.000Z')
  // Non-presence fields stay on the stored projection.
  assertEquals(merged.lastInboundAt, storedBase.lastInboundAt)
  assertEquals(merged.keyLastUsedAt, storedBase.keyLastUsedAt)
  assertEquals(merged.daemonBuild, storedBase.daemonBuild)
})

test('mergeSnapshotPresence leaves stored values when meta omits presence fields', () => {
  const meta: DaemonCellSnapshot = {
    serverId: 'srv-merge',
    version: 4,
    updatedAt: '2020-01-01T00:00:00.000Z',
    connected: true,
  }

  const merged = mergeSnapshotPresence(storedBase, meta)
  assertEquals(merged.connected, true)
  assertEquals(merged.connectedAt, storedBase.connectedAt)
  assertEquals(merged.lastSeenAt, storedBase.lastSeenAt)
  assertEquals(merged.remoteAddress, storedBase.remoteAddress)
  assertEquals(merged.updatedAt, storedBase.updatedAt)
})

test('mergeSnapshotPresence does not rewrite updatedAt when meta is not newer', () => {
  const meta: DaemonCellSnapshot = {
    serverId: 'srv-merge',
    version: 4,
    updatedAt: '2020-01-02T00:00:00.000Z',
    connected: true,
  }
  const merged = mergeSnapshotPresence(storedBase, meta)
  assertEquals(merged.updatedAt, '2020-01-02T00:00:00.000Z')
  assertEquals(merged.connected, true)
})

test('mergeSnapshotPresence does not mutate the stored snapshot argument', () => {
  const stored = { ...storedBase }
  const meta: DaemonCellSnapshot = {
    serverId: 'srv-merge',
    version: 4,
    updatedAt: '2020-01-04T00:00:00.000Z',
    connected: true,
    remoteAddress: '203.0.113.99',
  }
  mergeSnapshotPresence(stored, meta)
  assertEquals(stored.connected, false)
  assertEquals(stored.remoteAddress, '203.0.113.10')
  assertEquals(stored.updatedAt, '2020-01-02T00:00:00.000Z')
})
