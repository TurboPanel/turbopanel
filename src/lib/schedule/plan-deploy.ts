/**
 * Load fleet + compose, interpret Swarm `deploy:`, and plan tasks.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { environment, fabric, project, server, service, storage } from '../db/schema.ts'
import { listServerLabelsForServers } from '../db/label-records.ts'
import { listEnvironmentTasks } from '../db/task-records.ts'
import {
  assertComposeDocument,
  mergeComposeLayers,
  type ComposeDocument,
  type ComposeLayer,
} from '../compose/index.ts'
import { parseProjectOptions } from '../project-options.ts'
import { parseServiceOptions, resolveServiceInstances } from '../service-options.ts'
import {
  environmentComposeFilename,
  PROJECT_COMPOSE_FILENAME,
} from '../../client/environments/deploy-layers.ts'
import { interpretServiceSchedule } from './interpret.ts'
import { reconcileServicesFromCompose } from '../../client/environments/reconcile-services.ts'
import {
  planEnvironmentSchedule,
  type FleetServer,
  type PlannedService,
  type SchedulePlan,
} from './planner.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type PlannedDeploy = {
  plan: SchedulePlan
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

function extractComposeFromOptions(options: unknown): unknown {
  if (!isPlainObject(options)) return null
  return options.compose ?? null
}

function resolveMergedCompose(
  projectOptions: unknown,
  environmentOptions: unknown,
  environmentFilename: string,
): ComposeDocument | PlanDeployError {
  try {
    const layers: ComposeLayer[] = [
      {
        role: 'project',
        filename: PROJECT_COMPOSE_FILENAME,
        document: assertComposeDocument(extractComposeFromOptions(projectOptions)),
      },
      {
        role: 'environment',
        filename: environmentFilename,
        document: assertComposeDocument(extractComposeFromOptions(environmentOptions)),
      },
    ]
    return mergeComposeLayers(layers)
  } catch {
    return { kind: 'invalid_compose' }
  }
}

function servicesMapping(document: ComposeDocument): Record<string, unknown> {
  const services = document.data.services
  return isPlainObject(services) ? services : {}
}

async function loadFleet(
  db: Db,
  organizationId: string,
): Promise<FleetServer[]> {
  const rows = await db
    .select({
      id: server.id,
      connected: server.connected,
      datacenterId: server.datacenterId,
    })
    .from(server)
    .where(eq(server.organizationId, organizationId))

  const labelsByServer = await listServerLabelsForServers(
    db,
    rows.map((row) => row.id),
  )
  return rows.map((row) => {
    const labels: Record<string, string> = {}
    for (const label of labelsByServer.get(row.id) ?? []) {
      labels[label.key] = label.value
    }
    return {
      id: row.id,
      connected: row.connected,
      datacenterId: row.datacenterId,
      labels,
    }
  })
}

async function loadStoragePins(
  db: Db,
  environmentId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      serviceId: storage.serviceId,
      serverId: storage.serverId,
    })
    .from(storage)
    .where(eq(storage.environmentId, environmentId))

  const pins = new Map<string, string>()
  for (const row of rows) {
    if (!row.serviceId || !row.serverId) continue
    if (!pins.has(row.serviceId)) pins.set(row.serviceId, row.serverId)
  }
  return pins
}

/**
 * Plan tasks for an environment deploy. Callers map `SchedulePlan` errors to
 * HTTP (`turbofabric_required` → 422, no eligible server → 409).
 */
export async function planEnvironmentDeploy(
  db: Db,
  params: {
    environmentId: string
    organizationId: string
  },
): Promise<PlannedDeploy | PlanDeployError> {
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

  await reconcileServicesFromCompose(db, params.environmentId, merged)

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

  const existingTasks = await listEnvironmentTasks(db, params.environmentId)
  const fleet = await loadFleet(db, params.organizationId)
  const storagePins = await loadStoragePins(db, params.environmentId)
  const projectOptions = parseProjectOptions(projectRow.options)
  const pinServerId = envRow.serverId
  const defaultServerId = projectOptions.defaultServerId ?? null

  const plan = planEnvironmentSchedule({
    pinServerId,
    defaultServerId,
    fabricEnabled: Boolean(fabricRow),
    servers: fleet,
    services: planned,
    existingTasks: existingTasks.map((task) => ({
      serviceId: task.serviceId,
      slot: task.slot,
      serverId: task.serverId,
    })),
    storagePins,
  })

  return {
    plan,
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
