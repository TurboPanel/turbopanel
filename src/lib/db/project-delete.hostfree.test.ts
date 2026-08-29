/**
 * Host-free coverage for project cascade delete (mock Db — no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  deleteProjectCascade,
  isActiveContainerStatus,
  MANAGED_RUNTIME_PRESENT_ERROR,
  PROJECT_HAS_RUNNING_SERVICES_ERROR,
} from './project-delete.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type ContainerRow = { id: string; status: string | null; role?: string }
type DeleteCall = { table: string; ids: string[] }

function createCascadeMockDb(scenario: {
  environmentIds?: string[]
  managedIds?: string[]
  serviceIds?: string[]
  containers?: ContainerRow[]
  hostingIds?: string[]
  composeNetworkIds?: string[]
}): { db: Db; deletes: DeleteCall[]; stats: { transactions: number } } {
  const deletes: DeleteCall[] = []
  const stats = { transactions: 0 }
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

  const selectFromWhere = (rows: unknown[]) => ({
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  })

  const tx = {
    select: (fields: Record<string, unknown>) => {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b))
      const keySet = new Set(keys)
      // purgeEnvironmentsComposeNetworks: { id }
      if (keys.length === 1 && keySet.has('id')) {
        return selectFromWhere(composeNetworkIds.map((id) => ({ id })))
      }
      throw new TypeError(`unexpected cascade tx select keys: ${keys.join(',')}`)
    },
    delete: (_table: unknown) => ({
      where: () => {
        deletes.push({ table: 'tx-delete', ids: ['tx-batch'] })
        return Promise.resolve(undefined)
      },
    }),
  } as unknown as Db

  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = selectQueue[selectIndex] ?? []
          selectIndex += 1
          return Promise.resolve(rows)
        },
      }),
    }),
    delete: (_table: unknown) => ({
      where: () => {
        deletes.push({ table: 'delete', ids: [projectId] })
        return Promise.resolve(undefined)
      },
    }),
    transaction: async (fn: (inner: Db) => Promise<void>) => {
      stats.transactions += 1
      await fn(tx)
    },
  } as unknown as Db

  return { db, deletes, stats }
}

test('isActiveContainerStatus treats dead and removing as inactive', () => {
  assertEquals(isActiveContainerStatus('dead'), false)
  assertEquals(isActiveContainerStatus('removing'), false)
  assertEquals(isActiveContainerStatus(undefined), true)
  assertEquals(isActiveContainerStatus(''), true)
})

test('deleteProjectCascade deletes bare project when no environments exist', async () => {
  const { db, deletes, stats } = createCascadeMockDb({})
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, { ok: true })
  assertEquals(stats.transactions, 1)
  // storage retention delete + project row
  assertEquals(deletes.length, 2)
})

test('deleteProjectCascade removes environments when no services exist', async () => {
  const { db, stats } = createCascadeMockDb({
    environmentIds: ['env-1', 'env-2'],
    serviceIds: [],
  })
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, { ok: true })
  assertEquals(stats.transactions, 1)
})

test('deleteProjectCascade rejects remaining managed runtime before transaction', async () => {
  const { db, stats } = createCascadeMockDb({
    environmentIds: ['env-1'],
    managedIds: ['managed-1'],
  })
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, {
    ok: false,
    error: MANAGED_RUNTIME_PRESENT_ERROR,
  })
  assertEquals(stats.transactions, 0)
})

test('deleteProjectCascade rejects active containers before transaction', async () => {
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
  assertEquals(stats.transactions, 0)
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
  assertEquals(result, { ok: true })
  assertEquals(stats.transactions, 1)
})

test('deleteProjectCascade cascades stopped containers inside a transaction', async () => {
  const { db, stats } = createCascadeMockDb({
    environmentIds: ['env-1'],
    serviceIds: ['svc-1'],
    containers: [{ id: 'c1', status: 'exited' }],
    hostingIds: ['host-1'],
  })
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, { ok: true })
  assertEquals(stats.transactions, 1)
})
