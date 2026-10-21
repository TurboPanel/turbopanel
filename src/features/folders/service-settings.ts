/**
 * Folder settings of a service: the folder name and the shared (`common`)
 * scope. Services are born from the compose file with neither set, so they are
 * chosen on the service itself, once, before its first folder exists:
 *
 * - the folder name can be typed or changed freely until a `folder` row exists
 *   for the service, then it is locked (`service_slug_locked`);
 * - the scope is the same: chosen before the first folder, then locked
 *   (`scope_locked`), and never changed while another environment uses the
 *   service.
 *
 * With no folder name set when the first folder is planned, the deploy picks
 * one (see `planDeployFolders`).
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, service, tenancy } from '../../db/schema.ts'
import type { FolderOptions } from './options.ts'
import {
  readDirectoryNameMode,
  scopeFor,
  settleFolderName,
  writeServiceFolderName,
} from './allocate.ts'
import { lockEnvironmentRow, serviceHasFolder } from './records.ts'
import { listUsesOfAssets } from './shares.ts'

export type ServiceFolderSettingsResult =
  | { ok: true }
  | { ok: false; error: 'service_slug_locked' | 'scope_locked' | 'common_asset_in_use' }

/** Apply the folder fields of a PATCH. Throws `FolderPlanError` for a name that cannot be used. */
export async function applyServiceFolderSettings(
  tx: Db,
  input: { serviceId: string; organizationId: string; options: FolderOptions }
): Promise<ServiceFolderSettingsResult> {
  const [row] = await tx
    .select({
      environmentId: service.environmentId,
      name: service.name,
      composeServiceName: service.composeServiceName,
      slug: service.slug,
      isCommon: service.isCommon,
    })
    .from(service)
    .where(eq(service.id, input.serviceId))
    .limit(1)
  if (!row) return { ok: true }
  await lockEnvironmentRow(tx, row.environmentId)

  const wantsScope = input.options.common !== undefined && input.options.common !== row.isCommon
  const wantsName =
    (input.options.slug !== undefined && input.options.slug !== row.slug) ||
    input.options.directoryName !== undefined
  if (!wantsScope && !wantsName) return { ok: true }

  if (await serviceHasFolder(tx, input.serviceId)) {
    return { ok: false, error: wantsScope ? 'scope_locked' : 'service_slug_locked' }
  }
  if (wantsScope) {
    const uses = await listUsesOfAssets(tx, { serviceIds: [input.serviceId] }, [], 1)
    if (uses.length > 0) return { ok: false, error: 'common_asset_in_use' }
  }

  const isCommon = input.options.common ?? row.isCommon
  // A scope change on a service with no name yet leaves the name to the deploy, which
  // defaults a web hosting service to its domain.
  if (!wantsName && row.slug === null) {
    await tx.update(service).set({ isCommon }).where(eq(service.id, input.serviceId))
    return { ok: true }
  }
  await settleAndWriteName(tx, input, row, isCommon)
  return { ok: true }
}

type ServiceNameRow = {
  environmentId: string
  name: string | null
  composeServiceName: string
  slug: string | null
}

/** Settle the folder name in the (possibly new) scope and store it with the scope. */
async function settleAndWriteName(
  tx: Db,
  input: { serviceId: string; organizationId: string; options: FolderOptions },
  row: ServiceNameRow,
  isCommon: boolean
): Promise<void> {
  const [env] = await tx
    .select({ name: environment.name })
    .from(environment)
    .where(eq(environment.id, row.environmentId))
    .limit(1)
  const scope = scopeFor(isCommon, env?.name ?? null)
  const owners = await tx
    .select({ principalId: tenancy.principalId })
    .from(tenancy)
    .where(eq(tenancy.serviceId, input.serviceId))
  const principalId = owners.length === 1 ? (owners[0]?.principalId ?? null) : null

  // A scope change alone re-checks the name the service already has.
  const typed =
    input.options.slug ??
    (input.options.directoryName === undefined && row.slug !== null ? row.slug : undefined)
  const settled = await settleFolderName(tx, {
    mode: await readDirectoryNameMode(tx, input.organizationId),
    kind: 'service',
    assetId: input.serviceId,
    principalId,
    scope,
    request: {
      ...(typed === undefined ? {} : { typed }),
      ...(input.options.directoryName === undefined ? {} : { choice: input.options.directoryName }),
    },
    label: row.name ?? row.composeServiceName,
  })
  await writeServiceFolderName(tx, input.serviceId, { slug: settled.slug, isCommon })
}
