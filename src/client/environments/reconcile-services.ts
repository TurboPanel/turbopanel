import { eq } from 'drizzle-orm'
import type { ComposeDocument } from '../../lib/compose/index.ts'
import type { Db } from '../../db.ts'
import { service } from '../../lib/db/schema.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function listComposeServiceNames(document: ComposeDocument): string[] {
  const services = document.data.services
  if (!isRecord(services)) return []
  return Object.keys(services).sort((a, b) => a.localeCompare(b))
}

function readComposeServiceName(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null
  const name = metadata.composeServiceName
  return typeof name === 'string' && name.length > 0 ? name : null
}

export type ReconcileServicesResult = {
  created: string[]
  orphans: string[]
}

/**
 * Ensure each compose service has a backing `service` row for settings/hosting.
 * Idempotent — safe to call on every deploy and environment compose save.
 */
export async function reconcileServicesFromCompose(
  db: Db,
  environmentId: string,
  merged: ComposeDocument,
): Promise<ReconcileServicesResult> {
  const composeNames = listComposeServiceNames(merged)
  const existingRows = await db
    .select({
      id: service.id,
      displayName: service.displayName,
      metadata: service.metadata,
    })
    .from(service)
    .where(eq(service.environmentId, environmentId))

  const existingByComposeName = new Map<string, typeof existingRows[number]>()
  for (const row of existingRows) {
    const composeServiceName = readComposeServiceName(row.metadata) ?? row.displayName ?? row.id
    existingByComposeName.set(composeServiceName, row)
  }

  const created: string[] = []
  for (const composeServiceName of composeNames) {
    if (existingByComposeName.has(composeServiceName)) continue

    const [inserted] = await db.insert(service).values({
      displayName: composeServiceName,
      environmentId,
      metadata: { composeServiceName },
    }).returning({ id: service.id })

    created.push(inserted.id)
    existingByComposeName.set(composeServiceName, {
      id: inserted.id,
      displayName: composeServiceName,
      metadata: { composeServiceName },
    })
  }

  const composeNameSet = new Set(composeNames)
  const orphans = existingRows
    .map((row) => readComposeServiceName(row.metadata) ?? row.displayName ?? row.id)
    .filter((name) => !composeNameSet.has(name))

  return { created, orphans }
}
