/**
 * Host-free coverage for compose volume auto-registration.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import { emptyComposeDocument } from '../../lib/compose/types.ts'
import { registerComposeVolumes } from './register-compose-volumes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function volumeDoc(
  volumes: Record<string, unknown>,
): ComposeDocument {
  return {
    ...emptyComposeDocument(),
    data: {
      services: { web: { image: 'nginx' } },
      volumes,
    },
  }
}

test('registerComposeVolumes returns empty for blank volumes', async () => {
  const db = {
    select: () => {
      throw new TypeError('should not query when no composable volumes')
    },
  } as unknown as Db

  assertEquals(
    await registerComposeVolumes(db, {
      document: volumeDoc({}),
      organizationId: 'org',
      environmentId: 'env',
      serverId: 'srv',
    }),
    [],
  )
})

test('registerComposeVolumes registers unmanaged external volumes', async () => {
  const storageId = '00000000-0000-4000-8000-0000000000ee'
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([]),
      }),
    }),
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn(db as unknown as Db)
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: storageId,
                name: 'data',
                metadata: { composeVolumeKey: 'data' },
              },
            ]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => thenableRows([]),
      }),
    }),
  } as unknown as Db

  const result = await registerComposeVolumes(db, {
    document: volumeDoc({
      data: { external: true },
    }),
    organizationId: 'org',
    environmentId: 'env',
    serverId: 'srv',
  })
  assertEquals(result[0]?.storageId, storageId)
  assertEquals(result[0]?.managed, false)
  assertEquals(result[0]?.composeKey, 'data')
})

test('registerComposeVolumes reuses existing composeVolumeKey rows', async () => {
  const storageId = '00000000-0000-4000-8000-0000000000aa'
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          thenableRows([
            {
              id: storageId,
              name: 'appdata',
              metadata: {
                composeVolumeKey: 'appdata',
                dockerVolumeName: storageId,
              },
            },
          ]),
      }),
    }),
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn(db as unknown as Db)
    },
    insert: () => {
      throw new TypeError('should not insert when key already registered')
    },
  } as unknown as Db

  const result = await registerComposeVolumes(db, {
    document: volumeDoc({ appdata: null }),
    organizationId: 'org',
    environmentId: 'env',
    serverId: 'srv',
  })
  assertEquals(result, [
    {
      storageId,
      locationId: storageId,
      composeKey: 'appdata',
      volumeName: storageId,
      managed: true,
    },
  ])
})

test('registerComposeVolumes inserts stamps dockerVolumeName and updates metadata', async () => {
  const storageId = '00000000-0000-4000-8000-0000000000bb'
  let updated: unknown
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([]),
      }),
    }),
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn(db as unknown as Db)
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: storageId,
                name: 'logs',
                metadata: { composeVolumeKey: 'logs' },
              },
            ]),
        }),
      }),
    }),
    update: () => ({
      set: (patch: unknown) => {
        updated = patch
        return {
          where: () => thenableRows([]),
        }
      },
    }),
  } as unknown as Db

  const result = await registerComposeVolumes(db, {
    document: volumeDoc({ logs: {} }),
    organizationId: 'org',
    environmentId: 'env',
    serverId: 'srv',
  })
  assertEquals(result[0]?.storageId, storageId)
  assertEquals(result[0]?.composeKey, 'logs')
  assertEquals(result[0]?.volumeName, storageId)
  assertEquals(updated, {
    metadata: {
      composeVolumeKey: 'logs',
      dockerVolumeName: storageId,
    },
  })
})

test('registerComposeVolumes reselects winner after insert conflict', async () => {
  const storageId = '00000000-0000-4000-8000-0000000000cc'
  let selects = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          selects += 1
          if (selects === 1) return thenableRows([])
          return thenableRows([
            {
              id: storageId,
              name: 'cache',
              metadata: {
                composeVolumeKey: 'cache',
                dockerVolumeName: storageId,
              },
            },
          ])
        },
      }),
    }),
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn(db as unknown as Db)
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db

  const result = await registerComposeVolumes(db, {
    document: volumeDoc({ cache: null }),
    organizationId: 'org',
    environmentId: 'env',
    serverId: 'srv',
  })
  assertEquals(result[0]?.storageId, storageId)
})

test('registerComposeVolumes throws when conflict winner is missing', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([]),
      }),
    }),
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn(db as unknown as Db)
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db

  await assertRejects(
    () =>
      registerComposeVolumes(db, {
        document: volumeDoc({ cache: null }),
        organizationId: 'org',
        environmentId: 'env',
        serverId: 'srv',
      }),
    Error,
    'compose volume registration missing',
  )
})
