/**
 * Load fleet + compose, interpret Swarm `deploy:`, and plan slots.
 */

import { eq } from 'drizzle-orm'
import {
  isComposeChainError,
  resolveComposeLayerChain,
} from '../compose/layer-chain.ts'
import type { Db } from '../../db.ts'
import { environment, fabric, organization, storageCopy, mount, project, server, service, storage } from '../db/schema.ts'
import { listServerLabelsForServers } from '../db/label-records.ts'
import { listEnvironmentSlots } from '../db/slot-records.ts'
import {
  type ComposeDeployValidationError,
  type ComposeDocument,
  mergeComposeLayers,
  validateComposeForDeploy,
} from '../compose/index.ts'
import { parseProjectOptions } from '../project-options.ts'
import {
  parseOrganizationOptions,
  resolveComposeGatedFieldsEnabled,
} from '../organization-options.ts'
import { parseServiceOptions, resolveServiceInstances } from '../service-options.ts'
import { environmentComposeFilename } from '../../client/environments/deploy-layers.ts'
import { interpretServiceSchedule } from './interpret.ts'
import { reconcileServicesFromCompose } from '../../client/environments/reconcile-services.ts'
import { registerComposeVolumes } from '../../client/environments/register-compose-volumes.ts'
import { registerComposeMounts } from '../../client/environments/register-compose-mounts.ts'
import {
  listActiveColocatedLicenseBindings,
  resolveColocatedServerIdSet,
} from '../../client/servers/colocated.ts'
import {
  planEnvironmentSchedule,
  type FleetServer,
  type PlannedService,
  type ScheduleFailReason,
  type SchedulePlan,
} from './planner.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type PlannedDeploy = {
  plan: SchedulePlan
  /**
   * The merged document passed deploy-time compose validation
   * (`lib/compose/validate-for-deploy.ts`) **before** this plan reconciled a
   * single row.
   *
   * Carried rather than implied so the per-server prepare can see that the
   * document it is about to compile has already been through stages 1–4 for
   * this request, and skip re-running them over the identical merge. The gate
   * itself is not optional — see {@link planEnvironmentDeploy}.
   */
  composeValidated: true
  pinServerId: string | null
  defaultServerId: string | null
  fabricEnabled: boolean
  fabricId: string | null
  merged: ComposeDocument
  serviceRows: Array<{ id: string; composeServiceName: string; options: unknown }>
  projectId: string
  projectOptions: unknown
}

export type PlanDeployError =
  | { kind: 'not_found' }
  | { kind: 'invalid_compose' }
  /**
   * The merged document is a document TurboPanel will refuse to deploy.
   *
   * Carries the refusal itself rather than collapsing to `invalid_compose`, so
   * the route answers with the same body the per-server prepare would have —
   * the operator should not get a different diagnosis depending on which stage
   * of the deploy happened to notice.
   */
  | { kind: 'compose_rejected'; error: ComposeDeployValidationError }

/**
 * Optional doubles for host-free tests. Production callers omit this; defaults
 * are the real reconcile / register / task / label helpers.
 */
export type PlanEnvironmentDeployDeps = {
  reconcileServicesFromCompose?: typeof reconcileServicesFromCompose
  registerComposeVolumes?: typeof registerComposeVolumes
  registerComposeMounts?: typeof registerComposeMounts
  listEnvironmentSlots?: typeof listEnvironmentSlots
  listServerLabelsForServers?: typeof listServerLabelsForServers
  /** Which of these org servers are co-located with the control plane. */
  listColocatedServerIds?: typeof listColocatedServerIds
}

/**
 * The co-located control-plane host is not a tenant deploy target: the
 * environment PATCH refuses it as a pin
 * (`COLOCATED_SERVER_DEPLOY_TARGET_BLOCKED_REASON`), and the unpinned pool
 * must refuse it the same way, or "deploy with no pin" lands arbitrary compose
 * on the host that carries `TURBOPANEL_SECRETS` (found in the 0.1.x install
 * rehearsal). Same probes as the PATCH guard, plus the self-host pin.
 */
async function listColocatedServerIds(
  db: Db,
  organizationId: string,
  serverIds: string[],
): Promise<Set<string>> {
  const colocated = await resolveColocatedServerIdSet(db, undefined, serverIds, {
    orgScoped: true,
    includeSelfHostPin: true,
  })
  // The guard's fallback before the self-host pin exists: an active
  // `this server` license bound to the row.
  for (
    const id of await listActiveColocatedLicenseBindings(db, organizationId, serverIds)
  ) {
    colocated.add(id)
  }
  return colocated
}

/** Host-free: pull `options.compose` (or null) from project/environment options. */
export function extractComposeFromOptions(options: unknown): unknown {
  if (!isPlainObject(options)) return null
  return options.compose ?? null
}

/** Host-free: merge project + environment compose layers, or `invalid_compose`. */
export function resolveMergedCompose(
  projectOptions: unknown,
  environmentOptions: unknown,
  environmentFilename: string,
): ComposeDocument | PlanDeployError {
  const chain = resolveComposeLayerChain({
    projectOptions,
    environmentOptions,
    environmentFilename,
  })
  if (isComposeChainError(chain)) return chain
  try {
    return mergeComposeLayers(chain)
  } catch {
    return { kind: 'invalid_compose' }
  }
}

/** Host-free: `document.data.services` as a mapping, else `{}`. */
export function servicesMapping(document: ComposeDocument): Record<string, unknown> {
  const services = document.data.services
  return isPlainObject(services) ? services : {}
}

export type StoragePinMountRow = {
  serviceId: string
  storageId: string
  locationServerId: string | null
  locationRole: string | null
}

/**
 * Host-free: pin each service to its storage primary server unless the volume
 * has a shared (null-server) storageCopy.
 */
export function computeStoragePinsFromMountRows(
  rows: readonly StoragePinMountRow[],
): Map<string, string> {
  const hasShared = new Set<string>()
  const primaryServer = new Map<string, string>()
  for (const row of rows) {
    if (row.locationServerId === null) hasShared.add(row.storageId)
    if (row.locationRole === 'primary' && row.locationServerId) {
      primaryServer.set(row.storageId, row.locationServerId)
    }
  }

  const pins = new Map<string, string>()
  for (const row of rows) {
    if (pins.has(row.serviceId) || hasShared.has(row.storageId)) continue
    const serverId = primaryServer.get(row.storageId)
    if (!serverId) continue
    pins.set(row.serviceId, serverId)
  }
  return pins
}

/**
 * The org's servers as scheduling candidates, minus the co-located
 * control-plane host — unless the environment is pinned to it, which only the
 * self-host system environment legitimately is (tenant pins are refused at
 * the PATCH). A project `defaultServerId` never brings it back: that is a
 * preference the pool resolves, not an operator pin.
 */
async function loadTenantFleet(
  db: Db,
  organizationId: string,
  deps: {
    listLabels: typeof listServerLabelsForServers
    listColocated: typeof listColocatedServerIds
    pinServerId: string | null
  },
): Promise<{ fleet: FleetServer[]; excludedColocated: number }> {
  const allRows = await db
    .select({
      id: server.id,
      connected: server.isConnected,
    })
    .from(server)
    .where(eq(server.organizationId, organizationId))
  const colocated = allRows.length > 0
    ? await deps.listColocated(db, organizationId, allRows.map((row) => row.id))
    : new Set<string>()
  const rows = allRows.filter((row) =>
    !colocated.has(row.id) || row.id === deps.pinServerId
  )
  const excludedColocated = allRows.length - rows.length

  const labelsByServer = await deps.listLabels(
    db,
    rows.map((row) => row.id),
  )
  const fleet = rows.map((row) => {
    const labels: Record<string, string> = {}
    for (const label of labelsByServer.get(row.id) ?? []) {
      labels[label.key] = label.value
    }
    return {
      id: row.id,
      connected: row.connected,
      labels,
    }
  })
  return { fleet, excludedColocated }
}

/**
 * What a single-host self-hosted install hears instead of "No connected
 * servers are available" when its only daemon is the control-plane host.
 */
export const COLOCATED_ONLY_SERVER_REASON: ScheduleFailReason = 'colocated_only'
export const COLOCATED_ONLY_SERVER_MESSAGE =
  'The only connected server is the co-located control-plane host, which does not run tenant deploys — enrol another server first'

async function loadStoragePins(
  db: Db,
  environmentId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      serviceId: mount.serviceId,
      storageId: storage.id,
      locationServerId: storageCopy.serverId,
      locationRole: storageCopy.role,
    })
    .from(mount)
    .innerJoin(storage, eq(mount.storageId, storage.id))
    .innerJoin(storageCopy, eq(storageCopy.storageId, storage.id))
    .where(eq(storage.environmentId, environmentId))

  return computeStoragePinsFromMountRows(rows)
}

/**
 * Plan slots for an environment deploy. Callers map `SchedulePlan` errors to
 * HTTP (`turbofabric_required` → 422, no eligible server → 409). The merged
 * document rides into the planner because `turbofabric_required` is a verdict
 * about the document's `driver: overlay` networks, not about how many servers
 * the plan happened to use.
 *
 * **Validation comes before scheduling.** The merged document is run through
 * `validateComposeForDeploy` (schema → extension → semantic → policy) as the
 * first thing after the merge, and a refusal returns `compose_rejected` without
 * touching a row. Everything after that point writes: `reconcileServicesFromCompose`
 * creates and retires `service` rows, `registerComposeVolumes` /
 * `registerComposeMounts` create `storage` and `mount` rows. A deploy that is
 * going to be refused must not reshape the control plane first, and the refusal
 * used to arrive only later, in the per-server prepare.
 *
 * Optional {@link PlanEnvironmentDeployDeps} lets host-free tests stub
 * reconcile / register / list helpers without Postgres.
 */
export async function planEnvironmentDeploy(
  db: Db,
  params: {
    environmentId: string
    organizationId: string
  },
  deps: PlanEnvironmentDeployDeps = {},
): Promise<PlannedDeploy | PlanDeployError> {
  const reconcile = deps.reconcileServicesFromCompose ?? reconcileServicesFromCompose
  const registerVolumes = deps.registerComposeVolumes ?? registerComposeVolumes
  const registerMounts = deps.registerComposeMounts ?? registerComposeMounts
  const listTasks = deps.listEnvironmentSlots ?? listEnvironmentSlots
  const listLabels = deps.listServerLabelsForServers ?? listServerLabelsForServers
  const listColocated = deps.listColocatedServerIds ?? listColocatedServerIds

  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      serverId: environment.serverId,
      options: environment.options,
      name: environment.name,
    })
    .from(environment)
    .where(eq(environment.id, params.environmentId))
    .limit(1)
  if (!envRow) return { kind: 'not_found' }

  const [projectRow] = await db
    .select({
      id: project.id,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return { kind: 'not_found' }

  const filename = environmentComposeFilename({
    id: envRow.id,
    name: envRow.name,
  })
  const merged = resolveMergedCompose(projectRow.options, envRow.options, filename)
  if ('kind' in merged) return merged

  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, params.organizationId))
    .limit(1)
  const composeGatedFieldsEnabled = resolveComposeGatedFieldsEnabled(
    parseOrganizationOptions(orgRow?.options),
  )

  // Before anything is written. `reconcile` below creates and retires `service`
  // rows, and `registerVolumes` / `registerMounts` further down create `storage`
  // and `mount` rows — all from a document that, if it is going to be refused,
  // must not have shaped the control plane on its way to being refused. Planning
  // used to run first and the refusal came later, per server, which left rows
  // behind for a deploy that never happened.
  const rejected = validateComposeForDeploy(merged, { composeGatedFieldsEnabled })
  if (rejected) return { kind: 'compose_rejected', error: rejected }

  await reconcile(db, params.environmentId, merged)

  const serviceRows = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
      options: service.options,
    })
    .from(service)
    .where(eq(service.environmentId, params.environmentId))

  const mapping = servicesMapping(merged)
  const planned: PlannedService[] = []
  for (const row of serviceRows) {
    const raw = mapping[row.composeServiceName]
    const body = isPlainObject(raw) ? raw : {}
    const fallback = resolveServiceInstances(parseServiceOptions(row.options) ?? {})
    planned.push({
      serviceId: row.id,
      spec: interpretServiceSchedule(row.composeServiceName, body, fallback),
    })
  }

  const [fabricRow] = await db
    .select({ id: fabric.id })
    .from(fabric)
    .where(eq(fabric.organizationId, params.organizationId))
    .limit(1)

  const existingTasks = await listTasks(db, params.environmentId)
  const projectOptions = parseProjectOptions(projectRow.options)
  const pinServerId = envRow.serverId
  const { fleet, excludedColocated } = await loadTenantFleet(
    db,
    params.organizationId,
    { listLabels, listColocated, pinServerId },
  )
  const defaultServerId = projectOptions.defaultServerId ?? null
  const registerServerId = pinServerId ?? defaultServerId
  if (registerServerId) {
    await registerVolumes(db, {
      document: merged,
      organizationId: params.organizationId,
      environmentId: params.environmentId,
      serverId: registerServerId,
    })
    await registerMounts(db, {
      document: merged,
      environmentId: params.environmentId,
    })
  }
  const storagePins = await loadStoragePins(db, params.environmentId)

  const scheduled = planEnvironmentSchedule({
    pinServerId,
    defaultServerId,
    fabricEnabled: Boolean(fabricRow),
    servers: fleet,
    services: planned,
    // `turbofabric_required` is decided from authored `driver: overlay` intent,
    // not from the server count, so the planner needs the merged document.
    document: merged,
    existingTasks: existingTasks.map((task) => ({
      serviceId: task.serviceId,
      slot: task.slot,
      serverId: task.serverId,
    })),
    storagePins,
  })
  const plan: SchedulePlan = !scheduled.ok &&
      scheduled.error === 'no_eligible_server' &&
      fleet.length === 0 && excludedColocated > 0
    ? {
      ...scheduled,
      message: COLOCATED_ONLY_SERVER_MESSAGE,
      reason: COLOCATED_ONLY_SERVER_REASON,
    }
    : scheduled

  return {
    plan,
    composeValidated: true,
    pinServerId,
    defaultServerId,
    fabricEnabled: Boolean(fabricRow),
    fabricId: fabricRow?.id ?? null,
    merged,
    serviceRows,
    projectId: projectRow.id,
    projectOptions: projectRow.options,
  }
}
