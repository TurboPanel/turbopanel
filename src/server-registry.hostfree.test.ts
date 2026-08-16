/**
 * Host-free coverage for server-registry pure helpers + Db-backed paths that
 * can be exercised with a fake (no live Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from './db.ts'
import {
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

test('mergeServerMetadataIdentity ignores invalid timeSync and empty ips no-op', () => {
  assertEquals(
    mergeServerMetadataIdentity(
      { timeSync: { timezone: 'UTC' } },
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
            metadata: { os },
            hostname: 'host-1',
            machineKey: HEX64,
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
        where: () =>
          queryResult([{
            metadata: null,
            hostname: null,
            machineKey: null,
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
    ips: [
      { address: '10.0.0.1', version: 4, scope: 'private' },
      { address: '203.0.113.10', version: 4, scope: 'public' },
    ],
  })
  assertEquals(patches.length, 1)
  assertEquals(patches[0]?.hostname, 'edge-1')
  assertEquals(patches[0]?.machineKey, HEX64)
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
