/**
 * Host-free coverage for container reconcile (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import type { EnvironmentDeployContainer } from '../commands/schemas.ts'
import { container, service } from './schema.ts'
import { reconcileEnvironmentContainers } from './container-records.ts'

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

type ServiceRow = {
  id: string
  composeServiceName: string
  options: unknown
}

type ContainerRow = {
  id: string
  serviceId: string
  containerId: string | null
  containerName: string
  status: string
  role: string
  composeServiceName: string
  ordinal: number
}

function createReconcileDb(opts: {
  services?: ServiceRow[]
  existing?: ContainerRow[]
  onUpdate?: (patch: Record<string, unknown>, whereIds?: unknown) => void
  onInsert?: (values: Record<string, unknown>) => void
  onDelete?: () => void
  insertServiceIds?: string[]
}): Db & {
  updates: Array<Record<string, unknown>>
  inserts: Array<Record<string, unknown>>
  deletes: number
} {
  const services = [...(opts.services ?? [])]
  const existing = [...(opts.existing ?? [])]
  const updates: Array<Record<string, unknown>> = []
  const inserts: Array<Record<string, unknown>> = []
  let deletes = 0
  let insertServiceI = 0

  const db = {
    updates,
    inserts,
    get deletes() {
      return deletes
    },
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === service) {
            return thenableRows(services)
          }
          if (table === container) {
            return thenableRows(existing)
          }
          return thenableRows([])
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const list = Array.isArray(values) ? values : [values]
        for (const row of list) {
          inserts.push(row)
          opts.onInsert?.(row)
        }
        if (table === service) {
          const returned = list.map((row, i) => {
            const id = opts.insertServiceIds?.[insertServiceI + i] ??
              `svc-new-${insertServiceI + i}`
            return {
              id,
              composeServiceName: String(row.composeServiceName),
              options: null,
            }
          })
          insertServiceI += list.length
          for (const row of returned) services.push(row)
          return {
            returning: () => Promise.resolve(returned),
          }
        }
        const id = `ctr-${inserts.length}`
        return {
          returning: () => Promise.resolve([{ id }]),
        }
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch)
        opts.onUpdate?.(patch)
        return {
          where: () => thenableRows([]),
        }
      },
    }),
    delete: () => {
      deletes += 1
      opts.onDelete?.()
      return {
        where: () => thenableRows([]),
      }
    },
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      await fn(db as unknown as Db)
    },
  }

  return db as unknown as Db & {
    updates: Array<Record<string, unknown>>
    inserts: Array<Record<string, unknown>>
    deletes: number
  }
}

function reported(
  partial: Partial<EnvironmentDeployContainer> &
    Pick<EnvironmentDeployContainer, 'containerName' | 'composeServiceName'>,
): EnvironmentDeployContainer {
  return {
    containerId: partial.containerId ?? 'docker-1',
    containerName: partial.containerName,
    composeServiceName: partial.composeServiceName,
    status: partial.status ?? 'running',
    role: partial.role ?? 'service',
    serviceId: partial.serviceId,
  } as EnvironmentDeployContainer
}

test('reconcileEnvironmentContainers no-ops when environment has no services or report', async () => {
  const db = createReconcileDb({ services: [], existing: [] })
  await reconcileEnvironmentContainers(db, {
    serverId: 'srv',
    environmentId: 'env',
    containers: [],
  })
  assertEquals(db.updates.length, 0)
  assertEquals(db.inserts.length, 0)
})

test('reconcileEnvironmentContainers resets existing rows on empty report', async () => {
  const db = createReconcileDb({
    services: [
      { id: 'svc-web', composeServiceName: 'web', options: null },
    ],
    existing: [
      {
        id: 'c1',
        serviceId: 'svc-web',
        containerId: 'd1',
        containerName: 'web',
        status: 'running',
        role: 'service',
        composeServiceName: 'web',
        ordinal: 1,
      },
    ],
  })
  await reconcileEnvironmentContainers(db, {
    serverId: 'srv',
    environmentId: 'env',
    containers: [],
  })
  assertEquals(db.updates[0], { status: 'exited', containerId: null })
})

test('reconcileEnvironmentContainers updates a matching preallocated row by name', async () => {
  const db = createReconcileDb({
    services: [
      { id: 'svc-web', composeServiceName: 'web', options: null },
    ],
    existing: [
      {
        id: 'c1',
        serviceId: 'svc-web',
        containerId: null,
        containerName: 'web-uuid',
        status: 'pending',
        role: 'service',
        composeServiceName: 'web',
        ordinal: 1,
      },
    ],
  })
  await reconcileEnvironmentContainers(db, {
    serverId: 'srv',
    environmentId: 'env',
    containers: [
      reported({
        containerName: 'web-uuid',
        composeServiceName: 'web',
        status: 'running',
        containerId: 'docker-abc',
      }),
    ],
  })
  assertEquals(db.updates[0]?.status, 'running')
  assertEquals(db.updates[0]?.containerId, 'docker-abc')
  assertEquals(db.inserts.length, 0)
})

test('reconcileEnvironmentContainers inserts when no match and mints missing service', async () => {
  const db = createReconcileDb({
    services: [],
    existing: [],
    insertServiceIds: ['svc-api'],
  })
  await reconcileEnvironmentContainers(db, {
    serverId: 'srv',
    environmentId: 'env',
    containers: [
      reported({
        containerName: 'api-1',
        composeServiceName: 'api',
        status: 'running',
        containerId: 'd-api',
      }),
    ],
  })
  assertEquals(
    db.inserts.some((row) => row.composeServiceName === 'api'),
    true,
  )
  assertEquals(
    db.inserts.some((row) => row.containerName === 'api-1'),
    true,
  )
})

test('reconcileEnvironmentContainers skips ingress-only reports when minting services', async () => {
  const db = createReconcileDb({
    services: [
      { id: 'svc-web', composeServiceName: 'web', options: null },
    ],
    existing: [],
  })
  await reconcileEnvironmentContainers(db, {
    serverId: 'srv',
    environmentId: 'env',
    containers: [
      reported({
        containerName: 'web-in',
        composeServiceName: 'web',
        role: 'ingress',
        containerId: 'd-in',
      }),
    ],
  })
  // Insert container for unmatched ingress (no pre-row), but no new service mint.
  assertEquals(
    db.inserts.every((row) => row.environmentId === undefined),
    true,
  )
})

test('reconcileEnvironmentContainers deletes unmatched stale pending and resets expected', async () => {
  const db = createReconcileDb({
    services: [
      {
        id: 'svc-web',
        composeServiceName: 'web',
        options: { instances: 1 },
      },
    ],
    existing: [
      {
        id: 'keep-expected',
        serviceId: 'svc-web',
        containerId: 'old',
        containerName: 'web',
        status: 'running',
        role: 'service',
        composeServiceName: 'web',
        ordinal: 1,
      },
      {
        id: 'stale-pending',
        serviceId: 'svc-web',
        containerId: null,
        containerName: 'web-2',
        status: 'pending',
        role: 'service',
        composeServiceName: 'web-2',
        ordinal: 2,
      },
    ],
  })
  await reconcileEnvironmentContainers(db, {
    serverId: 'srv',
    environmentId: 'env',
    containers: [
      reported({
        containerName: 'web',
        composeServiceName: 'web',
        containerId: 'new',
      }),
    ],
    expectedAllocations: [
      { serviceId: 'svc-web', role: 'service', ordinal: 1 },
    ],
  })
  assertEquals(db.deletes >= 1, true)
})

test('reconcileEnvironmentContainers matches multi-instance clone by suffix ordinal', async () => {
  const db = createReconcileDb({
    services: [
      {
        id: 'svc-web',
        composeServiceName: 'web',
        options: { instances: 2 },
      },
    ],
    existing: [
      {
        id: 'c1',
        serviceId: 'svc-web',
        containerId: null,
        containerName: 'svc-web',
        status: 'pending',
        role: 'service',
        composeServiceName: 'web',
        ordinal: 1,
      },
      {
        id: 'c2',
        serviceId: 'svc-web',
        containerId: null,
        containerName: 'svc-web-2',
        status: 'pending',
        role: 'service',
        composeServiceName: 'web-2',
        ordinal: 2,
      },
    ],
  })
  await reconcileEnvironmentContainers(db, {
    serverId: 'srv',
    environmentId: 'env',
    containers: [
      reported({
        containerName: 'other-name-2',
        composeServiceName: 'web-2',
        containerId: 'd2',
      }),
      reported({
        containerName: 'other-name-1',
        composeServiceName: 'web',
        containerId: 'd1',
      }),
    ],
  })
  assertEquals(db.updates.length, 2)
  assertEquals(db.inserts.filter((r) => 'containerId' in r && r.status).length, 0)
})
