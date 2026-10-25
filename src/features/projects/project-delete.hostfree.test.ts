/**
 * Host-free coverage for project cascade delete (mock Db — no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { deployment, network } from '../../db/schema.ts'
import {
  deleteProjectCascade,
  dropEnvironmentSubtreeInTx,
  isActiveContainerStatus,
  MANAGED_RUNTIME_PRESENT_ERROR,
  PROJECT_HAS_RUNNING_SERVICES_ERROR,
  type ProjectDeleteResult,
} from './project-delete.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** A finished delete with nothing left for the servers to do. */
const DELETED: ProjectDeleteResult = {
  ok: true,
  cleanup: { folderServerIds: [], principals: { removed: [], kept: [] } },
}

type ContainerRow = { id: string; status: string | null; role?: string }
type DeleteCall = { table: string; ids: string[] }

function createCascadeMockDb(scenario: {
  environmentIds?: string[]
  managedIds?: string[]
  serviceIds?: string[]
  containers?: ContainerRow[]
  hostingIds?: string[]
  composeNetworkIds?: string[]
  /** Serve the same rows again when a second pass reads them (check, then delete). */
  repeat?: boolean
}): {
  db: Db
  deletes: DeleteCall[]
  stats: { transactions: number; open: boolean }
} {
  const deletes: DeleteCall[] = []
  const stats = { transactions: 0, open: false }
  const projectId = 'proj-1'

  const envIds = scenario.environmentIds ?? []
  const managedIds = scenario.managedIds ?? []
  const serviceIds = scenario.serviceIds ?? []
  const containers = scenario.containers ?? []
  const hostingIds = scenario.hostingIds ?? []
  const composeNetworkIds = scenario.composeNetworkIds ?? []

  const selectQueue: unknown[][] = [
    envIds.map((id) => ({ id })),
    managedIds.map((id) => ({ id })),
    serviceIds.map((id) => ({ id })),
    containers,
    hostingIds.map((id) => ({ id })),
  ]
  let selectIndex = 0

  // One select for the database and the transaction: the delete reads and writes
  // under the project lock, in the transaction.
  const select = () => ({
    from: (table: unknown) => {
      const next = () => {
        // Compose networks and in-flight deploys are read outside the queue.
        const outsideQueue = table === network || table === deployment
        let rows: unknown[] = selectQueue[selectIndex] ?? []
        if (table === network) rows = composeNetworkIds.map((id) => ({ id }))
        else if (table === deployment) rows = []
        if (!outsideQueue) selectIndex += 1
        if (scenario.repeat && selectIndex >= selectQueue.length) selectIndex = 0
        // `where(...)` can be awaited, or continue into `orderBy(...).limit(...)`.
        const result = Promise.resolve(rows) as Promise<unknown[]> & {
          orderBy: () => { limit: () => Promise<unknown[]> }
          limit: () => Promise<unknown[]>
        }
        result.orderBy = () => ({ limit: () => Promise.resolve(rows) })
        result.limit = () => Promise.resolve(rows)
        return result
      }
      const join = {
        innerJoin: () => join,
        leftJoin: () => join,
        where: next,
      }
      return {
        where: next,
        innerJoin: () => join,
        leftJoin: () => join,
      }
    },
  })

  const tx = {
    select,
    delete: (_table: unknown) => ({
      where: () => {
        deletes.push({ table: 'tx-delete', ids: ['tx-batch'] })
        return Promise.resolve(undefined)
      },
    }),
    // markAssetFoldersRemoving: the folder rows of a deleted service wait for the host.
    update: (_table: unknown) => ({
      set: () => ({
        where: () => {
          deletes.push({ table: 'tx-folders-removing', ids: ['tx-batch'] })
          // `.returning()` hands back the servers whose rows moved.
          return Object.assign(Promise.resolve(undefined), {
            returning: () => Promise.resolve([]),
          })
        },
      }),
    }),
    // ensureProjectPlacements: one raw upsert before the rows go.
    execute: () => {
      deletes.push({ table: 'tx-placements', ids: [projectId] })
      return Promise.resolve(undefined)
    },
  } as unknown as Db

  const db = {
    select,
    delete: (_table: unknown) => ({
      where: () => {
        deletes.push({ table: 'delete', ids: [projectId] })
        return Promise.resolve(undefined)
      },
    }),
    transaction: async <T>(fn: (inner: Db) => Promise<T>): Promise<T> => {
      stats.transactions += 1
      stats.open = true
      try {
        return await fn(tx)
      } finally {
        stats.open = false
      }
    },
  } as unknown as Db

  return { db, deletes, stats }
}

test('dropEnvironmentSubtreeInTx is a no-op for an empty id list', async () => {
  const result = await dropEnvironmentSubtreeInTx({} as Db, [])
  assertEquals(result, { containers: 0 })
})

test('isActiveContainerStatus treats dead and removing as inactive', () => {
  assertEquals(isActiveContainerStatus('dead'), false)
  assertEquals(isActiveContainerStatus('removing'), false)
  assertEquals(isActiveContainerStatus(undefined), true)
  assertEquals(isActiveContainerStatus(''), true)
})

test('deleteProjectCascade deletes bare project when no environments exist', async () => {
  const { db, deletes, stats } = createCascadeMockDb({})
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, DELETED)
  assertEquals(stats.transactions, 1)
  // No volume goes with the project, so only the project row is deleted.
  assertEquals(deletes.filter((call) => call.table !== 'tx-placements').length, 1)
})

test('deleteProjectCascade removes environments when no services exist', async () => {
  const { db, stats } = createCascadeMockDb({
    environmentIds: ['env-1', 'env-2'],
    serviceIds: [],
  })
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, DELETED)
  assertEquals(stats.transactions, 1)
})

test('deleteProjectCascade rejects remaining managed runtime before transaction', async () => {
  const { db, stats } = createCascadeMockDb({
    environmentIds: ['env-1'],
    managedIds: ['managed-1'],
  })
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.error, MANAGED_RUNTIME_PRESENT_ERROR)
    assertEquals(typeof result.detail?.message, 'string')
  }
  assertEquals(stats.transactions, 1)
})

test('deleteProjectCascade without a stop refuses while services run', async () => {
  const { db, stats } = createCascadeMockDb({
    environmentIds: ['env-1'],
    serviceIds: ['svc-1'],
    containers: [
      { id: 'c1', status: 'exited', role: 'service' },
      { id: 'c2', status: 'running', role: 'service' },
    ],
  })
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, {
    ok: false,
    error: PROJECT_HAS_RUNNING_SERVICES_ERROR,
  })
  assertEquals(stats.transactions, 1)
})

test('deleteProjectCascade ignores running platform components (ingress/ha)', async () => {
  // ProxySQL / Orchestrator rows are shared per-server infrastructure — a
  // project must never be held hostage by them; their lifecycle is
  // server-scoped (destroy fan-out + orphan sweep).
  const { db, stats } = createCascadeMockDb({
    environmentIds: ['env-1'],
    serviceIds: ['svc-1'],
    containers: [
      { id: 'c1', status: 'exited', role: 'service' },
      { id: 'c2', status: 'running', role: 'ingress' },
    ],
  })
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, DELETED)
  assertEquals(stats.transactions, 1)
})

test('deleteProjectCascade cascades stopped containers inside a transaction', async () => {
  const { db, stats, deletes } = createCascadeMockDb({
    environmentIds: ['env-1'],
    serviceIds: ['svc-1'],
    containers: [{ id: 'c1', status: 'exited' }],
    hostingIds: ['host-1'],
  })
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, DELETED)
  assertEquals(stats.transactions, 1)
  // The principals' placements are written first, inside the same transaction.
  assertEquals(deletes[0], { table: 'tx-placements', ids: ['proj-1'] })
})

test('deleteProjectCascade sends the stop before the transaction opens, never inside it', async () => {
  const { db, stats } = createCascadeMockDb({ environmentIds: ['env-1'], repeat: true })
  let openWhenStopped: boolean | undefined
  const result = await deleteProjectCascade(db, 'proj-1', undefined, () => {
    openWhenStopped = stats.open
    return Promise.resolve(true)
  })
  assertEquals(result, DELETED)
  assertEquals(openWhenStopped, false)
})

test('deleteProjectCascade gives up with a clear message when the stop never answers', async () => {
  const { db, stats } = createCascadeMockDb({ environmentIds: ['env-1'], repeat: true })
  const hang = new Promise<boolean>(() => {})
  const result = await deleteProjectCascade(db, 'proj-1', undefined, () => hang, 20)
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.error, 'project_stop_failed')
    assertEquals(typeof result.detail?.message, 'string')
  }
  assertEquals(stats.transactions, 0)
})
