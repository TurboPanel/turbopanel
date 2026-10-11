import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { container, server } from '../../db/schema.ts'
import {
  parseServiceRunStates,
  type ServiceRunState,
  type ServiceRunStateName,
  worstServiceRunState,
} from '../../contracts/service-run-state.ts'

/**
 * What a service row serves as `runState`: the daemon's last report for it,
 * with `running` spelled out so a client never re-derives it from the word.
 */
export type ServiceRunStateView = {
  state: ServiceRunStateName
  /** True only for `running`, which the daemon reports after 60 s up. */
  running: boolean
  restartCount: number
  lastError: string | null
  /** When the daemon last saw this exact state change. */
  asOf: string
}

export function toServiceRunStateView(entry: ServiceRunState): ServiceRunStateView {
  return {
    state: entry.state,
    running: entry.state === 'running',
    restartCount: entry.restartCount,
    lastError: entry.lastError ?? null,
    asOf: entry.asOf,
  }
}

/** A service the daemon just reported down after crashing past its restart limit. */
export type ServiceStoppedAfterCrashes = {
  serviceId: string
  restartCount: number
  lastError: string | null
  asOf: string
}

/**
 * Services that are `stopped_after_crashes` in a daemon report and were not
 * already stored as that: the moment to tell the site owner. A hello after a
 * reconnect, or a heartbeat that only refreshes the log line, repeats a state
 * already stored and returns nothing. A service started again and stopped
 * again is a new stop and returns once more.
 */
export function servicesNewlyStoppedAfterCrashes(
  previous: readonly ServiceRunState[] | undefined,
  incoming: readonly ServiceRunState[] | undefined
): ServiceStoppedAfterCrashes[] {
  if (!incoming) return []
  const alreadyStopped = new Set(
    (previous ?? [])
      .filter((entry) => entry.state === 'stopped_after_crashes')
      .map((entry) => entry.serviceId)
  )
  return incoming
    .filter(
      (entry) => entry.state === 'stopped_after_crashes' && !alreadyStopped.has(entry.serviceId)
    )
    .map((entry) => ({
      serviceId: entry.serviceId,
      restartCount: entry.restartCount,
      lastError: entry.lastError ?? null,
      asOf: entry.asOf,
    }))
}

export type ServicePlacement = { serviceId: string; serverId: string }
export type ServerReport = { id: string; metadata: unknown }

/**
 * Pure join: each service takes the report of every server holding one of its
 * containers, and shows the worst. A service with no report is absent.
 */
export function buildServiceRunStateViews(
  placements: readonly ServicePlacement[],
  servers: readonly ServerReport[]
): Map<string, ServiceRunStateView> {
  const reportsByServer = new Map<string, Map<string, ServiceRunState>>()
  for (const row of servers) {
    const metadata = row.metadata as { services?: unknown } | null
    const reports = parseServiceRunStates(metadata?.services) ?? []
    reportsByServer.set(row.id, new Map(reports.map((entry) => [entry.serviceId, entry])))
  }

  const entriesByService = new Map<string, ServiceRunState[]>()
  for (const { serviceId, serverId } of placements) {
    const entry = reportsByServer.get(serverId)?.get(serviceId)
    if (!entry) continue
    const list = entriesByService.get(serviceId) ?? []
    list.push(entry)
    entriesByService.set(serviceId, list)
  }

  const views = new Map<string, ServiceRunStateView>()
  for (const [serviceId, entries] of entriesByService) {
    const worst = worstServiceRunState(entries)
    if (worst) views.set(serviceId, toServiceRunStateView(worst))
  }
  return views
}

/**
 * Last daemon-reported run state per service, from `server.metadata.services`
 * of the servers that hold the service's containers. A service with no report
 * is absent from the map (nothing has been reported yet), never defaulted to
 * stopped.
 */
export async function loadServiceRunStates(
  db: Db,
  serviceIds: readonly string[]
): Promise<Map<string, ServiceRunStateView>> {
  if (serviceIds.length === 0) return new Map()

  const placements = await db
    .select({ serviceId: container.serviceId, serverId: container.serverId })
    .from(container)
    .where(and(inArray(container.serviceId, [...serviceIds]), eq(container.role, 'service')))
  if (placements.length === 0) return new Map()

  const serverIds = [...new Set(placements.map((row) => row.serverId))]
  const servers = await db
    .select({ id: server.id, metadata: server.metadata })
    .from(server)
    .where(inArray(server.id, serverIds))

  return buildServiceRunStateViews(placements, servers)
}
