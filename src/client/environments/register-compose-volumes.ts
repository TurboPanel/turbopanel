/**
 * Auto-register compose top-level named volumes as `storage` + primary
 * `storageCopy` rows.
 *
 * Idempotency key: `(environment_id, metadata.composeVolumeKey)` where
 * `kind = 'volume'`. New managed rows stamp `metadata.dockerVolumeName` to
 * the storage UUID. External volumes upsert a storageCopy with
 * `options.managed = false` and `options.externalName`.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import { resolveDockerVolumeName } from '../../lib/naming.ts'
import { storageCopy, storage } from '../../lib/db/schema.ts'

export type RegisteredComposeVolume = {
  storageId: string
  locationId: string
  composeKey: string
  volumeName: string
  managed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExternalVolume(entry: unknown): boolean {
  if (!isRecord(entry)) return false
  if (entry.external === true) return true
  return isRecord(entry.external)
}

function readExternalName(entry: unknown): string | null {
  if (!isRecord(entry)) return null
  if (typeof entry.name === 'string' && entry.name.length > 0) return entry.name
  if (isRecord(entry.external) && typeof entry.external.name === 'string') {
    return entry.external.name.length > 0 ? entry.external.name : null
  }
  return null
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

type VolumeSpec = {
  composeKey: string
  managed: boolean
  externalName: string | null
}

function listVolumeSpecs(document: ComposeDocument): VolumeSpec[] {
  if (!isRecord(document.data.volumes)) return []
  const specs: VolumeSpec[] = []
  for (const [key, entry] of Object.entries(document.data.volumes)) {
    if (isExternalVolume(entry)) {
      specs.push({
        composeKey: key,
        managed: false,
        externalName: readExternalName(entry) ?? key,
      })
      continue
    }
    if (hasExplicitVolumeName(entry)) continue
    specs.push({ composeKey: key, managed: true, externalName: null })
  }
  return specs.sort((a, b) => a.composeKey.localeCompare(b.composeKey))
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
        eq(storage.kind, 'volume'),
        sql`${storage.metadata}->>'composeVolumeKey' = ${composeKey}`,
      ),
    )
    .limit(1)
  return row
}

async function ensurePrimaryDockerLocation(
  tx: Db,
  params: {
    storageId: string
    serverId: string
    managed: boolean
    externalName: string | null
  },
): Promise<string> {
  const [existing] = await tx
    .select({ id: storageCopy.id })
    .from(storageCopy)
    .where(
      and(
        eq(storageCopy.storageId, params.storageId),
        eq(storageCopy.role, 'primary'),
      ),
    )
    .limit(1)
  if (existing) return existing.id

  const options: Record<string, unknown> = { managed: params.managed }
  if (!params.managed && params.externalName) {
    options.externalName = params.externalName
  }
  const [inserted] = await tx
    .insert(storageCopy)
    .values({
      storageId: params.storageId,
      serverId: params.serverId,
      provider: 'docker',
      role: 'primary',
      state: 'pending',
      options,
    })
    .onConflictDoNothing()
    .returning({ id: storageCopy.id })
  if (inserted) return inserted.id

  const [winner] = await tx
    .select({ id: storageCopy.id })
    .from(storageCopy)
    .where(
      and(
        eq(storageCopy.storageId, params.storageId),
        eq(storageCopy.role, 'primary'),
      ),
    )
    .limit(1)
  if (!winner) {
    throw new Error(
      `compose volume storageCopy missing after conflict (storage=${params.storageId})`,
    )
  }
  return winner.id
}

function resolvedVolumeName(
  row: StorageRow,
  spec: VolumeSpec,
): string {
  if (!spec.managed) {
    return spec.externalName ?? spec.composeKey
  }
  return resolveDockerVolumeName({
    storageId: row.id,
    pinnedName: readPinnedDockerVolumeName(row.metadata),
  })
}

/**
 * Ensure each compose named volume has a `volume` storage row and a primary
 * docker storageCopy on `serverId`.
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
  const specs = listVolumeSpecs(params.document)
  if (specs.length === 0) return []

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
        eq(storage.kind, 'volume'),
      ),
    )

  const byComposeKey = new Map<string, StorageRow>()
  for (const row of existingRows) {
    const key = readComposeVolumeKey(row.metadata)
    if (key) byComposeKey.set(key, row)
  }

  const registered: RegisteredComposeVolume[] = []

  await db.transaction(async (tx) => {
    for (const spec of specs) {
      let existing = byComposeKey.get(spec.composeKey)

      if (!existing) {
        const [inserted] = await tx
          .insert(storage)
          .values({
            organizationId: params.organizationId,
            environmentId: params.environmentId,
            kind: 'volume',
            name: spec.composeKey,
            metadata: { composeVolumeKey: spec.composeKey },
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
            spec.composeKey,
          )
          if (!winner) {
            throw new Error(
              `compose volume registration missing after conflict (key=${spec.composeKey})`,
            )
          }
          existing = winner
        } else {
          const storageId = inserted.id
          const metadata = spec.managed
            ? {
                composeVolumeKey: spec.composeKey,
                dockerVolumeName: storageId,
              }
            : {
                composeVolumeKey: spec.composeKey,
              }
          await tx
            .update(storage)
            .set({ metadata })
            .where(eq(storage.id, storageId))
          existing = { ...inserted, metadata }
        }
        byComposeKey.set(spec.composeKey, existing)
      }

      const locationId = await ensurePrimaryDockerLocation(tx, {
        storageId: existing.id,
        serverId: params.serverId,
        managed: spec.managed,
        externalName: spec.externalName,
      })

      registered.push({
        storageId: existing.id,
        locationId,
        composeKey: spec.composeKey,
        volumeName: resolvedVolumeName(existing, spec),
        managed: spec.managed,
      })
    }
  })

  return registered
}
