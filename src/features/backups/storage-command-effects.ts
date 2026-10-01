/**
 * What a succeeded `storage.backup` command writes: a `archive` row for
 * a created artifact, or the row's removal for a deleted one. Mirrors
 * `managed.backup` in `../commands/consumer.ts`. The command went to the
 * copy's own server, and the row is keyed by the copy the payload named, so a
 * result can only ever touch that copy's records.
 */

import { compatLogWarn } from '../../lib/log-compat.ts'
import type { Db } from '../../db/connection.ts'
import {
  parseStorageBackupPayload,
  parseStorageBackupResult,
} from '../../contracts/commands/schemas.ts'
import { deleteArchive, insertArchive } from './archive-records.ts'

type StorageCommandRecord = { id: string; type: string; payload: unknown }

export async function applyStorageBackupSideEffect(
  db: Db,
  record: StorageCommandRecord,
  result: unknown
): Promise<void> {
  if (record.type !== 'storage.backup') return
  try {
    const payload = parseStorageBackupPayload(record.payload)
    if (payload.action === 'delete') {
      await deleteArchive(db, payload.copyId, payload.backupId)
      return
    }
    const backupResult = parseStorageBackupResult(result)
    if (
      backupResult.backupId !== payload.backupId ||
      backupResult.path === undefined ||
      backupResult.sizeBytes === undefined ||
      backupResult.checksum === undefined
    ) {
      return
    }
    await insertArchive(db, {
      id: payload.backupId,
      copyId: payload.copyId,
      sizeBytes: backupResult.sizeBytes,
      checksum: backupResult.checksum,
      path: backupResult.path,
      ...(backupResult.completedAt === undefined ? {} : { createdAt: backupResult.completedAt }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn(
      'command-consumer',
      `storage.backup side effect failed for command ${record.id}: ${message}`
    )
  }
}
