/**
 * Host-free coverage for compose service reconcile helpers (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { assertComposeDocument } from '../../lib/compose/index.ts'
import {
  reconcileServicesForEnvironment,
  reconcileServicesForProject,
} from './reconcile-after-compose-save.ts'
import { reconcileServicesFromCompose } from './reconcile-services.ts'

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

test('reconcileServicesFromCompose creates missing service rows and reports orphans', async () => {
  const inserted: Array<Record<string, unknown>> = []
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          thenableRows([
            { id: 'svc-legacy', composeServiceName: 'legacy' },
            { id: 'svc-web', composeServiceName: 'web' },
          ]),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values)
        return {
          returning: () =>
            Promise.resolve([{ id: `new-${String(values.composeServiceName)}` }]),
        }
      },
    }),
  } as unknown as Db

  const merged = assertComposeDocument({
    version: 1,
    data: {
      services: {
        web: { image: 'nginx:alpine' },
        api: { image: 'node:22' },
      },
    },
    presentation: { keyOrder: ['services'], comments: {} },
  })

  const result = await reconcileServicesFromCompose(db, 'env-1', merged)
  assertEquals(result.created, ['new-api'])
  assertEquals(result.orphans, ['legacy'])
  assertEquals(inserted[0]?.composeServiceName, 'api')
  assertEquals(inserted[0]?.environmentId, 'env-1')
})

test('reconcileServicesFromCompose returns empty lists for blank compose services', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableRows([]),
      }),
    }),
    insert: () => {
      throw new TypeError('should not insert when compose has no services')
    },
  } as unknown as Db

  const merged = assertComposeDocument({
    version: 1,
    data: {},
    presentation: { keyOrder: [], comments: {} },
  })
  assertEquals(await reconcileServicesFromCompose(db, 'env-1', merged), {
    created: [],
    orphans: [],
  })
})

test('reconcileServicesForEnvironment is a no-op when rows or merge fail', async () => {
  const missingEnv = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  await reconcileServicesForEnvironment(missingEnv, 'env-missing')

  let selects = 0
  const missingProject = {
    select: () => ({
      from: () => ({
        where: () => {
          selects += 1
          return {
            limit: () =>
              Promise.resolve(
                selects === 1
                  ? [{ projectId: 'proj-1', options: {} }]
                  : [],
              ),
          }
        },
      }),
    }),
  } as unknown as Db
  await reconcileServicesForEnvironment(missingProject, 'env-1')

  const invalidCompose = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              selects++ % 2 === 0
                ? [{ projectId: 'proj-1', options: { compose: 'nope' } }]
                : [{ options: { compose: 1 } }],
            ),
        }),
      }),
    }),
  } as unknown as Db
  await reconcileServicesForEnvironment(invalidCompose, 'env-1')

  const throwing = {
    select: () => {
      throw new Error('boom')
    },
  } as unknown as Db
  await reconcileServicesForEnvironment(throwing, 'env-1')
})

test('reconcileServicesForProject walks environment ids and swallows errors', async () => {
  let listed = false
  const chained = {
    select: () => ({
      from: () => ({
        where: () => {
          if (!listed) {
            listed = true
            return thenableRows([{ id: 'env-a' }])
          }
          return {
            limit: () => Promise.resolve([]),
          }
        },
      }),
    }),
  } as unknown as Db
  await reconcileServicesForProject(chained, 'proj-1')
  assertEquals(listed, true)

  const throwing = {
    select: () => {
      throw new Error('project list failed')
    },
  } as unknown as Db
  await reconcileServicesForProject(throwing, 'proj-1')
})
