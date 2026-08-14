/**
 * Host-free coverage for storage retention deletes (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import {
  applyStorageRetentionOnParentDelete,
  type StorageRetentionScope,
} from './storage-records.ts'
import type { Db } from '../../db.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type RetentionTx = Pick<Db, 'delete'>

function createRetentionTx(): RetentionTx & { deletes: unknown[] } {
  const deletes: unknown[] = []
  const deleteFn = ((_table: unknown) => ({
    where: (clause: unknown) => {
      deletes.push(clause)
      return Promise.resolve()
    },
  })) as unknown as RetentionTx['delete']
  return {
    deletes,
    delete: deleteFn,
  }
}

test('applyStorageRetentionOnParentDelete no-ops when the scope is empty', async () => {
  const tx = createRetentionTx()
  await applyStorageRetentionOnParentDelete(tx, {})
  assertEquals(tx.deletes.length, 0)
})

test('applyStorageRetentionOnParentDelete drops mounts then retention=delete rows', async () => {
  const tx = createRetentionTx()
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
  const tx = createRetentionTx()
  await applyStorageRetentionOnParentDelete(tx, {
    projectIds: ['proj-1'],
  })
  assertEquals(tx.deletes.length, 1)
})
