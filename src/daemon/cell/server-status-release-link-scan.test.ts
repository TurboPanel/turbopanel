import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import { buildDefaultDaemonStatus } from '../../features/servers/daemon-state.ts'
import type { ServerMetadata } from '../../features/servers/server-metadata.ts'
import { resolveFleetPresence } from './server-status.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const serverId = 'srv-link-scan-status'

function dbWithMetadata(metadata: ServerMetadata | null): Db {
  const status = buildDefaultDaemonStatus()
  const row = {
    id: serverId,
    daemon: { key: undefined },
    metadata,
    hostname: 'host-1',
    machineKey: null,
    osId: null,
    osFamily: null,
    osVersion: null,
    osCodename: null,
    osPrettyName: null,
    osArchitecture: null,
    timezone: null,
    isTimeSyncEnabled: null,
    ntpServers: null,
    ntpLastSyncedAt: null,
    connected: status.connected,
    statusChangedAt: status.statusChangedAt,
  }
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
  } as unknown as Db
}

const registry: DaemonCellRegistry = {
  getCell: () => {
    throw new Error('not used')
  },
  listOnlineServerIds: () => Promise.resolve([]),
  getSnapshots: () => Promise.reject(new Error('not used')),
  purge: () => Promise.resolve(),
}

test('resolveFleetPresence surfaces the stored link scan and bounds what it reads back', async () => {
  const presence = await resolveFleetPresence(
    dbWithMetadata({
      releaseLinkScan: {
        scannedAt: '2026-10-04T00:00:00.000Z',
        findingCount: 1,
        findings: [{ username: 'appuser', serviceId: 'svc-a', releaseId: 'r1', linkCount: 2 }],
      },
    }),
    registry,
    [serverId]
  )
  const scan = presence.get(serverId)?.releaseLinkScan
  assertEquals(scan?.findingCount, 1)
  assertEquals(scan?.findings[0]?.serviceId, 'svc-a')
})

test('resolveFleetPresence reports null until a scan was reported', async () => {
  const presence = await resolveFleetPresence(dbWithMetadata({}), registry, [serverId])
  assertEquals(presence.get(serverId)?.releaseLinkScan, null)
})
