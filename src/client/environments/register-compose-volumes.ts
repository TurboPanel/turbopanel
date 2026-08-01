/**
 * Auto-register compose top-level named volumes as `storage` rows.
 *
 * Idempotency key: `(environment_id, metadata.composeVolumeKey)`. New rows
 * stamp `metadata.dockerVolumeName` to the storage UUID. Concurrent inserts are race-safe via
 * `ON CONFLICT DO NOTHING` + reselect on
 * `uniq_storage_environment_compose_volume_key`.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import { resolveDockerVolumeName } from '../../lib/naming.ts'
import { storage } from '../../lib/db/schema.ts'

export type RegisteredComposeVolume = {
  storageId: string
  composeKey: string
  volumeName: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExternalVolume(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  if (entry.external === true) return true
  return isRecord(entry.external)
}

function hasExplicitVolumeName(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  return typeof entry.name === 'string' && entry.name.length > 0
}

function readComposeVolumeKey(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null
  if (typeof metadata.composeVolumeKey !== 'string') return null
  return metadata.composeVolumeKey.length > 0 ? metadata.composeVolumeKey : null
}

function readPinnedDockerVolumeName(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null
  if (typeof metadata.dockerVolumeName !== 'string') return null
  return metadata.dockerVolumeName.length > 0 ? metadata.dockerVolumeName : null
}

function listComposableVolumeKeys(document: ComposeDocument): string[] {
  if (!isRecord(document.data.volumes)) return []
  const keys: string[] = []
  for (const [key, entry] of Object.entries(document.data.volumes)) {
    if (isExternalVolume(entry)) continue
    if (hasExplicitVolumeName(entry)) continue
    keys.push(key)
  }
  return keys.sort((a, b) => a.localeCompare(b))
}

type StorageRow = {
  id: string
  name: string
  metadata: unknown
}

async function selectByComposeVolumeKey(
  tx: Db,
  environmentId: string,
  composeKey: string,
): Promise<StorageRow | undefined> {
  const [row] = await tx
    .select({
      id: storage.id,
      name: storage.name,
      metadata: storage.metadata,
    })
    .from(storage)
    .where(
      and(
        eq(storage.environmentId, environmentId),
        eq(storage.kind, 'docker_volume'),
        sql`${storage.metadata}->>'composeVolumeKey' = ${composeKey}`,
      ),
    )
    .limit(1)
  return row
}

/**
 * Ensure each non-external, unnamed compose volume has a `docker_volume`
 * storage row for this environment. Returns resolved Docker volume names.
 */
export async function registerComposeVolumes(
  db: Db,
  params: {
    document: ComposeDocument
    organizationId: string
    environmentId: string
    serverId: string
  },
): Promise<RegisteredComposeVolume[]> {
  const composeKeys = listComposableVolumeKeys(params.document)
  if (composeKeys.length === 0) return []

  const existingRows = await db
    .select({
      id: storage.id,
      name: storage.name,
      metadata: storage.metadata,
    })
    .from(storage)
    .where(
      and(
        eq(storage.environmentId, params.environmentId),
        eq(storage.kind, 'docker_volume'),
      ),
    )

  const byComposeKey = new Map<string, (typeof existingRows)[number]>()
  for (const row of existingRows) {
    const key = readComposeVolumeKey(row.metadata)
    if (key) {
      byComposeKey.set(key, row)
    }
  }

  const registered: RegisteredComposeVolume[] = []

  await db.transaction(async (tx) => {
    for (const composeKey of composeKeys) {
      let existing = byComposeKey.get(composeKey)

      if (existing) {
        const volumeName = resolveDockerVolumeName({
          storageId: existing.id,
          pinnedName: readPinnedDockerVolumeName(existing.metadata),
        })
        registered.push({
          storageId: existing.id,
          composeKey,
          volumeName,
        })
        continue
      }

      // Conflict-safe insert: concurrent preview/deploy callers may race on
      // `uniq_storage_environment_compose_volume_key`. DO NOTHING + reselect
      // keeps the path idempotent without aborting the transaction.
      const [inserted] = await tx
        .insert(storage)
        .values({
          organizationId: params.organizationId,
          environmentId: params.environmentId,
          serverId: params.serverId,
          kind: 'docker_volume',
          name: composeKey,
          metadata: { composeVolumeKey: composeKey },
        })
        .onConflictDoNothing()
        .returning({
          id: storage.id,
          name: storage.name,
          metadata: storage.metadata,
        })

      if (!inserted) {
        const winner = await selectByComposeVolumeKey(
          tx,
          params.environmentId,
          composeKey,
        )
        if (!winner) {
          throw new Error(
            `compose volume registration missing after conflict (key=${composeKey})`,
          )
        }
        byComposeKey.set(composeKey, winner)
        registered.push({
          storageId: winner.id,
          composeKey,
          volumeName: resolveDockerVolumeName({
            storageId: winner.id,
            pinnedName: readPinnedDockerVolumeName(winner.metadata),
          }),
        })
        continue
      }

      const storageId = inserted.id
      const metadata = {
        composeVolumeKey: composeKey,
        dockerVolumeName: storageId,
      }
      await tx
        .update(storage)
        .set({ metadata })
        .where(eq(storage.id, storageId))

      const stamped = { ...inserted, metadata }
      byComposeKey.set(composeKey, stamped)

      registered.push({
        storageId,
        composeKey,
        volumeName: resolveDockerVolumeName({
          storageId,
          pinnedName: storageId,
        }),
      })
    }
  })

  return registered
}
