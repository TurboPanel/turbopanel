/**
 * `storage.backup` results against a real database: a created artifact
 * becomes a `archive` row for the payload's copy, a delete removes it,
 * and a result for another backup id writes nothing. Skips without
 * TURBOPANEL_DATABASE_URL.
 */

import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { organization, server, storage, storageCopy, archive } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { applyStorageBackupSideEffect } from './storage-command-effects.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const STORE_ID = '0192d6a0-0000-7000-8000-0000000000d1'

type Db = ReturnType<typeof createDenoDb>

async function withCopy(fn: (db: Db, copyId: string) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping storage.backup side effect tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Storage Backup Effect Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const now = new Date().toISOString()
    const [srv] = await db
      .insert(server)
      .values({ organizationId, name: 'Effect Server', createdAt: now, updatedAt: now })
      .returning({ id: server.id })
    const [store] = await db
      .insert(storage)
      .values({ organizationId, kind: 'volume', name: 'uploads' })
      .returning({ id: storage.id })
    const [copy] = await db
      .insert(storageCopy)
      .values({ storageId: store!.id, serverId: srv!.id, provider: 'docker' })
      .returning({ id: storageCopy.id })
    await fn(db, copy!.id)
  } finally {
    await db.delete(storage).where(eq(storage.organizationId, organizationId))
    await db.delete(server).where(eq(server.organizationId, organizationId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
}

function record(copyId: string, action: 'create' | 'delete', backupId = 'bk_one') {
  return {
    id: 'cmd-1',
    type: 'storage.backup',
    payload: {
      copyId,
      copyProvider: 'docker',
      volumeName: 'uploads',
      storageId: STORE_ID,
      action,
      backupId,
    },
  }
}

function rowsFor(db: Db, copyId: string) {
  return db
    .select({ backupId: archive.backupId, policyId: archive.retentionId })
    .from(archive)
    .where(eq(archive.copyId, copyId))
}

test('a created copy backup is recorded once; a delete removes it', async () => {
  await withCopy(async (db, copyId) => {
    const result = {
      backupId: 'bk_one',
      path: `/backup/copies/${copyId}/bk_one.tar.gz`,
      sizeBytes: 512,
      checksum: 'd'.repeat(64),
      completedAt: '2026-09-30T04:00:00.000Z',
    }
    await applyStorageBackupSideEffect(db, record(copyId, 'create'), result)
    await applyStorageBackupSideEffect(db, record(copyId, 'create'), result)
    assertEquals(await rowsFor(db, copyId), [{ backupId: 'bk_one', policyId: null }])

    await applyStorageBackupSideEffect(db, record(copyId, 'delete'), {
      backupId: 'bk_one',
      deleted: true,
    })
    assertEquals(await rowsFor(db, copyId), [])
  })
})

test('a result that names another backup, or lacks its artifact, writes nothing', async () => {
  await withCopy(async (db, copyId) => {
    await applyStorageBackupSideEffect(db, record(copyId, 'create'), {
      backupId: 'bk_other',
      path: '/backup/x.tar.gz',
      sizeBytes: 1,
      checksum: 'd'.repeat(64),
    })
    await applyStorageBackupSideEffect(db, record(copyId, 'create'), { backupId: 'bk_one' })
    await applyStorageBackupSideEffect(
      db,
      { ...record(copyId, 'create'), type: 'managed.backup' },
      {
        backupId: 'bk_one',
        path: '/backup/x.tar.gz',
        sizeBytes: 1,
        checksum: 'd'.repeat(64),
      }
    )
    assertEquals(await rowsFor(db, copyId), [])
  })
})
