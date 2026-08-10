/**
 * Host-free coverage for project cascade delete (mock Db — no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  deleteProjectCascade,
  isActiveContainerStatus,
  PROJECT_HAS_RUNNING_SERVICES_ERROR,
} from './project-delete.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type ContainerRow = { id: string; status: string | null }
type DeleteCall = { table: string; ids: string[] }

function createCascadeMockDb(scenario: {
  environmentIds?: string[]
  serviceIds?: string[]
  containers?: ContainerRow[]
  hostingIds?: string[]
}): { db: Db; deletes: DeleteCall[]; stats: { transactions: number } } {
  const deletes: DeleteCall[] = []
  const stats = { transactions: 0 }
  const projectId = 'proj-1'

  const envIds = scenario.environmentIds ?? []
  const serviceIds = scenario.serviceIds ?? []
  const containers = scenario.containers ?? []
  const hostingIds = scenario.hostingIds ?? []

  const selectQueue: unknown[][] = [
    envIds.map((id) => ({ id })),
    serviceIds.map((id) => ({ id })),
    containers,
    hostingIds.map((id) => ({ id })),
  ]
  let selectIndex = 0

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
    transaction: async (fn: (tx: Db) => Promise<void>) => {
      stats.transactions += 1
      const tx = {
        delete: (_table: unknown) => ({
          where: () => {
            deletes.push({ table: 'tx-delete', ids: ['tx-batch'] })
            return Promise.resolve(undefined)
          },
        }),
      } as unknown as Db
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
  assertEquals(stats.transactions, 0)
  assertEquals(deletes.length, 1)
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

test('deleteProjectCascade rejects active containers before transaction', async () => {
  const { db, stats } = createCascadeMockDb({
    environmentIds: ['env-1'],
    serviceIds: ['svc-1'],
    containers: [
      { id: 'c1', status: 'exited' },
      { id: 'c2', status: 'running' },
    ],
  })
  const result = await deleteProjectCascade(db, 'proj-1')
  assertEquals(result, {
    ok: false,
    error: PROJECT_HAS_RUNNING_SERVICES_ERROR,
  })
  assertEquals(stats.transactions, 0)
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
