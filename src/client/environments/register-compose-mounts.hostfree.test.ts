/**
 * Host-free coverage for compose named-volume mount registration.
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import { emptyComposeDocument } from '../../lib/compose/types.ts'
import {
  parseNamedVolumeMount,
  registerComposeMounts,
} from './register-compose-mounts.ts'

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

test('parseNamedVolumeMount reads short and long syntax', () => {
  assertEquals(parseNamedVolumeMount('data:/var/lib/data'), {
    composeKey: 'data',
    destinationPath: '/var/lib/data',
    readOnly: false,
  })
  assertEquals(parseNamedVolumeMount('data:/var/lib/data:ro'), {
    composeKey: 'data',
    destinationPath: '/var/lib/data',
    readOnly: true,
  })
  assertEquals(parseNamedVolumeMount('/host/path:/data'), null)
  assertEquals(parseNamedVolumeMount('./rel:/data'), null)
  assertEquals(parseNamedVolumeMount({ type: 'bind', source: 'x', target: '/data' }), null)
  assertEquals(
    parseNamedVolumeMount({ source: 'cache', destination: '/tmp/cache' }),
    {
      composeKey: 'cache',
      destinationPath: '/tmp/cache',
      readOnly: false,
    },
  )
})

test('registerComposeMounts no-ops when the environment has no services', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([]),
      }),
    }),
    transaction: () => {
      throw new TypeError('should not open a transaction without services')
    },
  } as unknown as Db

  await registerComposeMounts(db, {
    document: {
      ...emptyComposeDocument(),
      data: {
        services: {
          web: { image: 'nginx', volumes: ['data:/data'] },
        },
        volumes: { data: null },
      },
    },
    environmentId: 'env',
  })
})

test('registerComposeMounts inserts named-volume mounts and skips scratch-only storage', async () => {
  const inserted: Array<Record<string, unknown>> = []
  let selectCalls = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          selectCalls += 1
          if (selectCalls === 1) {
            return thenableRows([
              { id: 'svc-web', composeServiceName: 'web' },
            ])
          }
          if (selectCalls === 2) {
            return thenableRows([
              {
                id: 'stor-data',
                metadata: { composeVolumeKey: 'data' },
              },
              {
                id: 'stor-scratch',
                metadata: { composeVolumeKey: 'scratch' },
              },
            ])
          }
          return thenableRows([
            { storageId: 'stor-data', role: 'primary' },
            { storageId: 'stor-scratch', role: 'scratch' },
          ])
        },
      }),
    }),
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn(db as unknown as Db)
    },
    delete: () => ({
      where: () => Promise.resolve([]),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row)
        return Promise.resolve([row])
      },
    }),
  } as unknown as Db

  await registerComposeMounts(db, {
    document: {
      ...emptyComposeDocument(),
      data: {
        services: {
          web: {
            image: 'nginx',
            volumes: [
              'data:/var/lib/data:ro',
              'scratch:/scratch',
              '/host/path:/bind',
            ],
          },
        },
        volumes: { data: null, scratch: null },
      },
    },
    environmentId: 'env',
  })

  assertEquals(inserted, [
    {
      storageId: 'stor-data',
      serviceId: 'svc-web',
      destinationPath: '/var/lib/data',
      readOnly: true,
    },
  ])
})
