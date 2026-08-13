/**
 * Detect Compose networks whose member services land on more than one server.
 */

import type { ComposeDocument } from '../compose/types.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type SpanningTask = {
  serviceId: string
  serverId: string
}

export type SpanningServiceRow = {
  id: string
  composeServiceName: string
}

/** Network keys a compose service joins. Undeclared → implicit `default`. */
export function composeServiceNetworkKeys(body: unknown): string[] {
  if (!isPlainObject(body) || body.networks === undefined) return ['default']
  if (Array.isArray(body.networks)) {
    return body.networks.filter((entry): entry is string => typeof entry === 'string')
  }
  if (isPlainObject(body.networks)) return Object.keys(body.networks)
  return ['default']
}

/**
 * Compose network keys used by tasks on two or more servers. Empty when the
 * plan is single-server (TurboFabric is not required for that case).
 */
export function collectSpanningComposeNetworkKeys(
  document: ComposeDocument,
  tasks: readonly SpanningTask[],
  serviceRows: readonly SpanningServiceRow[],
): string[] {
  const serverIds = new Set(tasks.map((task) => task.serverId))
  if (serverIds.size <= 1) return []

  const nameByServiceId = new Map(
    serviceRows.map((row) => [row.id, row.composeServiceName]),
  )
  const serversByServiceName = new Map<string, Set<string>>()
  for (const task of tasks) {
    const name = nameByServiceId.get(task.serviceId)
    if (!name) continue
    const servers = serversByServiceName.get(name) ?? new Set<string>()
    servers.add(task.serverId)
    serversByServiceName.set(name, servers)
  }

  const services = isPlainObject(document.data.services) ? document.data.services : {}
  const serversByNetwork = new Map<string, Set<string>>()
  for (const [name, body] of Object.entries(services)) {
    const memberServers = serversByServiceName.get(name)
    if (!memberServers || memberServers.size === 0) continue
    for (const networkKey of composeServiceNetworkKeys(body)) {
      const servers = serversByNetwork.get(networkKey) ?? new Set<string>()
      for (const serverId of memberServers) servers.add(serverId)
      serversByNetwork.set(networkKey, servers)
    }
  }

  return [...serversByNetwork.entries()]
    .filter(([, servers]) => servers.size > 1)
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b))
}

export function participatingServerIdsForNetwork(
  document: ComposeDocument,
  tasks: readonly SpanningTask[],
  serviceRows: readonly SpanningServiceRow[],
  networkKey: string,
): string[] {
  const nameByServiceId = new Map(
    serviceRows.map((row) => [row.id, row.composeServiceName]),
  )
  const services = isPlainObject(document.data.services) ? document.data.services : {}
  const serverIds = new Set<string>()
  for (const task of tasks) {
    const name = nameByServiceId.get(task.serviceId)
    if (!name) continue
    const body = services[name]
    if (!composeServiceNetworkKeys(body).includes(networkKey)) continue
    serverIds.add(task.serverId)
  }
  return [...serverIds].sort((a, b) => a.localeCompare(b))
}
