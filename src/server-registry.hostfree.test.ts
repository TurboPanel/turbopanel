/**
 * Host-free coverage for server-registry pure helpers + Db-backed paths that
 * can be exercised with a fake (no live Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from './db.ts'
import {
  findServerIdForIdentity,
  getServerLicenseBinding,
  mergeServerMetadataIdentity,
  touchServerMetadata,
} from './server-registry.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '00000000-0000-4000-8000-0000000000c1'
const HEX64 = 'ab'.repeat(32)

function queryResult<T>(rows: T[]) {
  const promise = Promise.resolve(rows)
  return Object.assign(promise, {
    limit: (_n: number) => Promise.resolve(rows),
    orderBy: (..._cols: unknown[]) =>
      Object.assign(Promise.resolve(rows), {
        limit: (_n: number) => Promise.resolve(rows),
      }),
  })
}

test('mergeServerMetadataIdentity ignores invalid timeSync', () => {
  assertEquals(
    mergeServerMetadataIdentity(
      { resources: { cpus: [{ cores: { total: 1 } }] } },
      { timeSync: { timezone: 1 } as never },
    ),
    null,
  )
})

test('touchServerMetadata no-ops when the server row is missing', async () => {
  let updates = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => queryResult([]),
      }),
    }),
    update: () => ({
      set: () => {
        updates += 1
        return { where: () => Promise.resolve(undefined) }
      },
    }),
  } as unknown as Db

  await touchServerMetadata(db, SERVER_ID, { hostname: 'h' })
  assertEquals(updates, 0)
})

test('touchServerMetadata no-ops when identity facts are unchanged', async () => {
  let updates = 0
  const os = {
    family: 'linux' as const,
    id: 'debian',
    version: '13',
  }
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          queryResult([{
            metadata: {},
            hostname: 'host-1',
            machineKey: HEX64,
            osId: 'debian',
            osFamily: 'linux',
            osVersion: '13',
            osCodename: null,
            osPrettyName: null,
            osArchitecture: null,
            timezone: null,
            isTimeSyncEnabled: null,
            ntpServers: null,
            ntpLastSyncedAt: null,
          }]),
      }),
    }),
    update: () => ({
      set: () => {
        updates += 1
        return { where: () => Promise.resolve(undefined) }
      },
    }),
  } as unknown as Db

  await touchServerMetadata(db, SERVER_ID, {
    os,
    hostname: 'host-1',
    machineKey: HEX64,
  })
  assertEquals(updates, 0)
})

test('touchServerMetadata writes hostname and metadata deltas', async () => {
  const patches: Array<Record<string, unknown>> = []
  const db = {
    select: () => ({
      from: () => ({
        // Repin pass (ips changed) loads pins via a `network` join — none here.
        leftJoin: () => ({ where: () => queryResult([]) }),
        where: () =>
          queryResult([{
            metadata: null,
            hostname: null,
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
          }]),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        patches.push(patch)
        return { where: () => Promise.resolve(undefined) }
      },
    }),
  } as unknown as Db

  await touchServerMetadata(db, SERVER_ID, {
    hostname: 'edge-1',
    machineKey: HEX64,
    os: {
      family: 'linux',
      id: 'debian',
      version: '13',
    },
    timeSync: { timezone: 'America/Chicago', ntpEnabled: true },
    resources: {
      ips: [
        { address: '10.0.0.1', version: 4, scope: 'private' },
        { address: '203.0.113.10', version: 4, scope: 'public' },
      ],
    },
  })
  assertEquals(patches.length, 1)
  assertEquals(patches[0]?.hostname, 'edge-1')
  assertEquals(patches[0]?.machineKey, HEX64)
  assertEquals(patches[0]?.osId, 'debian')
  assertEquals(patches[0]?.osFamily, 'linux')
  assertEquals(patches[0]?.osVersion, '13')
  assertEquals(patches[0]?.timezone, 'America/Chicago')
  assertEquals(patches[0]?.isTimeSyncEnabled, true)
  assertEquals(typeof patches[0]?.metadata, 'object')
})

test('touchServerMetadata ignores raw machine-id shaped machineKey', async () => {
  const patches: Array<Record<string, unknown>> = []
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          queryResult([{
            metadata: null,
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
          }]),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        patches.push(patch)
        return { where: () => Promise.resolve(undefined) }
      },
    }),
  } as unknown as Db

  await touchServerMetadata(db, SERVER_ID, {
    machineKey: '0123456789abcdef0123456789abcdef',
  })
  assertEquals(patches.length, 0)
})

test('getServerLicenseBinding returns null when the server is missing', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => queryResult([]),
      }),
    }),
  } as unknown as Db
  assertEquals(await getServerLicenseBinding(db, SERVER_ID), null)
})

test('getServerLicenseBinding prefers an active bound license', async () => {
  let selectCount = 0
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          selectCount += 1
          if ('organizationId' in fields) {
            return queryResult([{
              organizationId: '00000000-0000-4000-8000-000000000099',
            }])
          }
          // Active license select (second call) — revokedAt IS NULL filter.
          if (selectCount === 2) {
            return queryResult([{ id: 'license-active' }])
          }
          return queryResult([{ id: 'license-revoked' }])
        },
      }),
    }),
  } as unknown as Db

  assertEquals(await getServerLicenseBinding(db, SERVER_ID), {
    licenseId: 'license-active',
    organizationId: '00000000-0000-4000-8000-000000000099',
  })
})

test('getServerLicenseBinding surfaces revoked-only latch when no active seat', async () => {
  let selectCount = 0
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          selectCount += 1
          if ('organizationId' in fields) {
            return queryResult([{ organizationId: null }])
          }
          if (selectCount === 2) {
            return queryResult([]) // no active
          }
          return queryResult([{ id: 'license-revoked' }])
        },
      }),
    }),
  } as unknown as Db

  assertEquals(await getServerLicenseBinding(db, SERVER_ID), {
    licenseId: 'license-revoked',
    organizationId: null,
  })
})

test('getServerLicenseBinding returns null licenseId when unbound', async () => {
  let selectCount = 0
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          selectCount += 1
          if ('organizationId' in fields) {
            return queryResult([{
              organizationId: '00000000-0000-4000-8000-000000000099',
            }])
          }
          return queryResult([])
        },
      }),
    }),
  } as unknown as Db

  assertEquals(await getServerLicenseBinding(db, SERVER_ID), {
    licenseId: null,
    organizationId: '00000000-0000-4000-8000-000000000099',
  })
  assertEquals(selectCount >= 2, true)
})

/**
 * Fake `Db` for the repin hook: the server-row select answers every plain
 * `select().from().where()`; the repin pass is detected by its `leftJoin`
 * (`loadDatacenterMembershipPinDetailsForServers`), which returns no pins so
 * nothing else is written.
 */
function createRepinProbeDb(
  serverRow: Record<string, unknown>,
): { db: Db; repinLoads: () => number; updates: () => number } {
  let repinLoads = 0
  let updates = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => queryResult([serverRow]),
        leftJoin: () => ({
          where: () => {
            repinLoads += 1
            return queryResult([])
          },
        }),
      }),
    }),
    update: () => ({
      set: () => {
        updates += 1
        return { where: () => Promise.resolve(undefined) }
      },
    }),
  } as unknown as Db
  return { db, repinLoads: () => repinLoads, updates: () => updates }
}

const REPIN_SERVER_ROW = {
  hostname: 'host-1',
  machineKey: HEX64,
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
}

test('touchServerMetadata runs the repin hook once when resources.ips changed', async () => {
  const probe = createRepinProbeDb({
    ...REPIN_SERVER_ROW,
    metadata: {
      resources: {
        ips: [{ address: '10.0.0.1', version: 4, scope: 'private' }],
      },
    },
  })
  await touchServerMetadata(probe.db, SERVER_ID, {
    resources: {
      ips: [{ address: '10.0.0.2', version: 4, scope: 'private' }],
    },
  })
  assertEquals(probe.updates(), 1)
  assertEquals(probe.repinLoads(), 1)
})

test('touchServerMetadata skips the repin hook when ips are unchanged', async () => {
  const ips = [{ address: '10.0.0.1', version: 4 as const, scope: 'private' as const }]
  const probe = createRepinProbeDb({
    ...REPIN_SERVER_ROW,
    metadata: { resources: { ips } },
  })
  await touchServerMetadata(probe.db, SERVER_ID, {
    resources: { ips },
    hostname: 'host-2',
  })
  assertEquals(probe.updates(), 1)
  assertEquals(probe.repinLoads(), 0)
})

test('touchServerMetadata skips the repin hook on a CPU / docker-only delta', async () => {
  const ips = [{ address: '10.0.0.1', version: 4 as const, scope: 'private' as const }]
  const probe = createRepinProbeDb({
    ...REPIN_SERVER_ROW,
    metadata: { resources: { ips } },
  })
  await touchServerMetadata(probe.db, SERVER_ID, {
    resources: { cpus: [{ cores: { total: 8 } }] },
    docker: { version: '27.0.0' },
  })
  assertEquals(probe.updates(), 1)
  assertEquals(probe.repinLoads(), 0)
})

/**
 * A licensed identity resolves only through its licence binding.
 *
 * The first pass fell through to the hostname/machine-key lookup when a
 * licence was unbound, which is not what `resolveServerId` does — it inserts
 * a new row. Hostname uniqueness is per-organization, so the fall-through
 * matched a *different* org's server, and a brand-new host sharing a hostname
 * with some other org's revoked one would have been told
 * `Server key revoked` — a string on turbopaneld's permanent
 * enrollment-failure list, so the daemon would have stopped trying over a key
 * it never had.
 */
function lookupDb(calls: string[], rows: Record<string, unknown[]>): Db {
  return {
    select: (columns: Record<string, unknown>) => {
      const shape = Object.keys(columns).sort().join(',')
      calls.push(shape)
      const result = queryResult(rows[shape] ?? [])
      return {
        from: () => Object.assign(result, { where: () => result }),
      }
    },
  } as unknown as Db
}

test('a licensed identity resolves only through its license binding', async () => {
  // Bound: that server, and only that server.
  const boundCalls: string[] = []
  assertEquals(
    await findServerIdForIdentity(
      lookupDb(boundCalls, { serverId: [{ serverId: SERVER_ID }] }),
      { licenseId: 'lic-1', licenseToken: 'tok', hostname: 'web-01' },
    ),
    SERVER_ID,
  )
  assertEquals(boundCalls, ['serverId'])

  // Unbound: undefined, and the hostname lookup is never reached — that row
  // does not exist yet, and matching one by hostname would cross organizations.
  const unboundCalls: string[] = []
  assertEquals(
    await findServerIdForIdentity(
      lookupDb(unboundCalls, { serverId: [{ serverId: null }] }),
      { licenseId: 'lic-1', licenseToken: 'tok', hostname: 'web-01' },
    ),
    undefined,
  )
  assertEquals(unboundCalls, ['serverId'])
})

test('an unlicensed identity falls back to the hostname and machine-key lookup', async () => {
  const calls: string[] = []
  assertEquals(
    await findServerIdForIdentity(
      lookupDb(calls, { id: [{ id: SERVER_ID }] }),
      { machineKey: HEX64, hostname: 'web-01' },
    ),
    SERVER_ID,
  )
  assertEquals(calls, ['id'])
})
