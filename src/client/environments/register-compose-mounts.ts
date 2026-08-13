/**
 * Upsert `mount` rows from Compose service `volumes:` after services exist.
 * Named volumes only (host binds are not registered this slice).
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { ComposeDocument } from '../../lib/compose/types.ts'
import { location, mount, service, storage } from '../../lib/db/schema.ts'
import { scratchLocationNotMountable } from '../storage/routes-helpers.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type ParsedNamedVolumeMount = {
  composeKey: string
  destinationPath: string
  readOnly: boolean
}

function isHostPathSource(source: string): boolean {
  return source.startsWith('/') || source.startsWith('.') || source.startsWith('~')
}

export function parseNamedVolumeMount(spec: unknown): ParsedNamedVolumeMount | null {
  if (typeof spec === 'string') {
    const parts = spec.split(':')
    if (parts.length < 2) return null
    const source = parts[0] ?? ''
    const destinationPath = parts[1] ?? ''
    if (!source || !destinationPath || isHostPathSource(source)) return null
    const mode = parts[2] ?? ''
    return {
      composeKey: source,
      destinationPath,
      readOnly: mode.split(',').includes('ro'),
    }
  }
  if (!isRecord(spec)) return null
  if (spec.type === 'bind') return null
  const source = typeof spec.source === 'string' ? spec.source : ''
  let destinationPath = ''
  if (typeof spec.target === 'string') {
    destinationPath = spec.target
  } else if (typeof spec.destination === 'string') {
    destinationPath = spec.destination
  }
  if (!source || !destinationPath || isHostPathSource(source)) return null
  return {
    composeKey: source,
    destinationPath,
    readOnly: spec.read_only === true,
  }
}

function listServiceVolumeSpecs(
  document: ComposeDocument,
): Map<string, ParsedNamedVolumeMount[]> {
  const byService = new Map<string, ParsedNamedVolumeMount[]>()
  if (!isRecord(document.data.services)) return byService
  for (const [composeName, body] of Object.entries(document.data.services)) {
    if (!isRecord(body) || !Array.isArray(body.volumes)) continue
    const mounts: ParsedNamedVolumeMount[] = []
    for (const spec of body.volumes) {
      const parsed = parseNamedVolumeMount(spec)
      if (parsed) mounts.push(parsed)
    }
    if (mounts.length > 0) byService.set(composeName, mounts)
  }
  return byService
}

function readComposeVolumeKey(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null
  if (typeof metadata.composeVolumeKey !== 'string') return null
  return metadata.composeVolumeKey.length > 0 ? metadata.composeVolumeKey : null
}

async function loadScratchOnlyStorageIds(
  db: Db,
  storageIds: string[],
): Promise<Set<string>> {
  const scratchOnly = new Set<string>()
  if (storageIds.length === 0) return scratchOnly
  const locRows = await db
    .select({
      storageId: location.storageId,
      role: location.role,
    })
    .from(location)
    .where(inArray(location.storageId, storageIds))
  const rolesByStorage = new Map<string, string[]>()
  for (const row of locRows) {
    const roles = rolesByStorage.get(row.storageId) ?? []
    roles.push(row.role)
    rolesByStorage.set(row.storageId, roles)
  }
  for (const [storageId, roles] of rolesByStorage) {
    if (roles.length > 0 && roles.every((role) => scratchLocationNotMountable(role))) {
      scratchOnly.add(storageId)
    }
  }
  return scratchOnly
}

/**
 * Replace named-volume mounts for services in this environment from Compose.
 * Existing mounts for those services onto compose-registered volumes are
 * reconciled to the YAML set (insert missing, delete stale).
 */
export async function registerComposeMounts(
  db: Db,
  params: {
    document: ComposeDocument
    environmentId: string
  },
): Promise<void> {
  const specsByComposeName = listServiceVolumeSpecs(params.document)
  const serviceRows = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
    })
    .from(service)
    .where(eq(service.environmentId, params.environmentId))

  const storageRows = await db
    .select({
      id: storage.id,
      metadata: storage.metadata,
    })
    .from(storage)
    .where(
      and(
        eq(storage.environmentId, params.environmentId),
        eq(storage.kind, 'volume'),
      ),
    )
  const storageByKey = new Map<string, string>()
  for (const row of storageRows) {
    const key = readComposeVolumeKey(row.metadata)
    if (key) storageByKey.set(key, row.id)
  }

  const serviceIds = serviceRows.map((row) => row.id)
  if (serviceIds.length === 0) return

  const composeStorageIds = [...storageByKey.values()]
  const scratchOnlyIds = await loadScratchOnlyStorageIds(db, composeStorageIds)

  await db.transaction(async (tx) => {
    if (composeStorageIds.length > 0) {
      await tx.delete(mount).where(
        and(
          inArray(mount.serviceId, serviceIds),
          inArray(mount.storageId, composeStorageIds),
        ),
      )
    }

    for (const svc of serviceRows) {
      const specs = specsByComposeName.get(svc.composeServiceName) ?? []
      for (const spec of specs) {
        const storageId = storageByKey.get(spec.composeKey)
        if (!storageId || scratchOnlyIds.has(storageId)) continue
        await tx.insert(mount).values({
          storageId,
          serviceId: svc.id,
          destinationPath: spec.destinationPath,
          readOnly: spec.readOnly,
        })
      }
    }
  })
}
