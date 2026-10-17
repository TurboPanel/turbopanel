/**
 * Host-free coverage for storage retention deletes (no Postgres).
 */

import { assertEquals } from '@std/assert'
import {
  applyStorageRetentionOnParentDelete,
  type StorageRetentionScope,
} from './storage-records.ts'
import type { Db } from '../../db/connection.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type RetentionTx = Pick<Db, 'delete' | 'select' | 'update'>

/** `doomed` are the volume ids the select finds; each update is a folder rows move. */
function createRetentionTx(
  doomed: readonly string[] = []
): RetentionTx & { deletes: unknown[]; updates: unknown[] } {
  const deletes: unknown[] = []
  const updates: unknown[] = []
  const deleteFn = ((_table: unknown) => ({
    where: (clause: unknown) => {
      deletes.push(clause)
      return Promise.resolve()
    },
  })) as unknown as RetentionTx['delete']
  const selectFn = (() => ({
    from: () => ({ where: () => Promise.resolve(doomed.map((id) => ({ id }))) }),
  })) as unknown as RetentionTx['select']
  const updateFn = ((_table: unknown) => ({
    set: (values: unknown) => ({
      where: () => {
        updates.push(values)
        return Promise.resolve()
      },
    }),
  })) as unknown as RetentionTx['update']
  return { deletes, updates, delete: deleteFn, select: selectFn, update: updateFn }
}

test('applyStorageRetentionOnParentDelete no-ops when the scope is empty', async () => {
  const tx = createRetentionTx()
  await applyStorageRetentionOnParentDelete(tx, {})
  assertEquals(tx.deletes.length, 0)
  assertEquals(tx.updates.length, 0)
})

test('applyStorageRetentionOnParentDelete drops mounts then retention=delete rows', async () => {
  const tx = createRetentionTx(['vol-1'])
  const scope: StorageRetentionScope = {
    serviceIds: ['svc-1', 'svc-2'],
    projectIds: ['proj-1'],
    workspaceIds: ['ws-1'],
    environmentIds: ['env-1'],
  }
  await applyStorageRetentionOnParentDelete(tx, scope)
  // mount delete + storage delete
  assertEquals(tx.deletes.length, 2)
})

test('applyStorageRetentionOnParentDelete skips mount delete without serviceIds', async () => {
  const tx = createRetentionTx(['vol-1'])
  await applyStorageRetentionOnParentDelete(tx, {
    projectIds: ['proj-1'],
  })
  assertEquals(tx.deletes.length, 1)
})

test('applyStorageRetentionOnParentDelete marks folders removing before the volumes go', async () => {
  const tx = createRetentionTx(['vol-1', 'vol-2'])
  await applyStorageRetentionOnParentDelete(tx, { projectIds: ['proj-1'] })
  assertEquals(tx.updates, [{ state: 'removing' }])
  assertEquals(tx.deletes.length, 1)
})

test('applyStorageRetentionOnParentDelete leaves everything alone when no volume is deleted', async () => {
  const tx = createRetentionTx([])
  await applyStorageRetentionOnParentDelete(tx, { projectIds: ['proj-1'] })
  assertEquals(tx.updates.length, 0)
  assertEquals(tx.deletes.length, 0)
})
