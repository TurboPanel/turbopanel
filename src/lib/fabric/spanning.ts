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

/** ProxySQL listener that joins tenant spanning networks as a platform attachment. */
export type PlatformAttachment = {
  serverId: string
  networkKeys: readonly string[]
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
 * Compose network keys used by tasks ∪ platform attachments on two or more
 * servers. Empty when every participant lands on a single host.
 */
export function collectSpanningComposeNetworkKeys(
  document: ComposeDocument,
  tasks: readonly SpanningTask[],
  serviceRows: readonly SpanningServiceRow[],
  platformAttachments: readonly PlatformAttachment[] = [],
): string[] {
  const taskServers = new Set(tasks.map((task) => task.serverId))
  const attachmentServers = new Set(
    platformAttachments.map((attachment) => attachment.serverId),
  )
  if (new Set([...taskServers, ...attachmentServers]).size <= 1) return []

  const serversByNetwork = serversByNetworkFromTasks(
    document,
    tasks,
    serviceRows,
  )
  addPlatformAttachmentServers(serversByNetwork, platformAttachments)

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
  platformAttachments: readonly PlatformAttachment[] = [],
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
  for (const attachment of platformAttachments) {
    if (!attachment.networkKeys.includes(networkKey)) continue
    serverIds.add(attachment.serverId)
  }
  return [...serverIds].sort((a, b) => a.localeCompare(b))
}

function serversByNetworkFromTasks(
  document: ComposeDocument,
  tasks: readonly SpanningTask[],
  serviceRows: readonly SpanningServiceRow[],
): Map<string, Set<string>> {
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
  return serversByNetwork
}

function addPlatformAttachmentServers(
  serversByNetwork: Map<string, Set<string>>,
  platformAttachments: readonly PlatformAttachment[],
): void {
  for (const attachment of platformAttachments) {
    for (const networkKey of attachment.networkKeys) {
      const servers = serversByNetwork.get(networkKey) ?? new Set<string>()
      servers.add(attachment.serverId)
      serversByNetwork.set(networkKey, servers)
    }
  }
}
