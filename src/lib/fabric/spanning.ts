/**
 * Detect the Compose networks TurboFabric spans across hosts.
 *
 * **`driver: overlay` is the authored signal.** Compose already has a standard
 * expression for "this network reaches beyond one engine", so TurboPanel reads
 * that rather than inventing an `x-` key for it. A network key is eligible only
 * when the merged document's top-level `networks:` declares it with
 * `driver: overlay`; the per-server count then decides whether it *actually*
 * spans this deploy.
 *
 * Server count alone no longer promotes a network. Before, any key whose member
 * services happened to land on two hosts became a `tpn_*` routed bridge — the
 * implicit `default` network included — so a scheduling decision the author
 * never made silently changed what their document meant, and `driver: bridge`
 * behaved identically to declaring nothing at all. An author who wants two
 * hosts to share a network now says so, and one who does not gets two ordinary
 * local bridges.
 */

import type { ComposeDocument } from '../compose/types.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type SpanningSlot = {
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

/**
 * Top-level network keys declared `driver: overlay`.
 *
 * The one authored signal for spanning intent. Tolerant of the shapes the rest
 * of this codebase already handles for a `networks:` entry — a non-mapping
 * value, a bare `external:`/`name:` entry, an absent `networks:` block — all of
 * which simply mean "not declared overlay".
 */
export function readOverlayDeclaredNetworkKeys(
  document: ComposeDocument,
): Set<string> {
  const keys = new Set<string>()
  const networks = document.data.networks
  if (!isPlainObject(networks)) return keys
  for (const [key, entry] of Object.entries(networks)) {
    if (!isPlainObject(entry)) continue
    if (typeof entry.driver !== 'string') continue
    if (entry.driver.trim() !== 'overlay') continue
    keys.add(key)
  }
  return keys
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
 * Compose network keys **declared `driver: overlay`** that are used by slots ∪
 * platform attachments on two or more servers.
 *
 * Both halves are required. Empty when every participant lands on a single
 * host, and empty for a network the document never declared overlay however
 * its members are spread. The implicit `default` is included in that: a
 * document that writes no `networks:` block at all never spans, while one that
 * declares `networks.default.driver: overlay` opts the default network in the
 * same way as any other key.
 */
export function collectSpanningComposeNetworkKeys(
  document: ComposeDocument,
  slots: readonly SpanningSlot[],
  serviceRows: readonly SpanningServiceRow[],
  platformAttachments: readonly PlatformAttachment[] = [],
): string[] {
  const slotServers = new Set(slots.map((slot) => slot.serverId))
  const attachmentServers = new Set(
    platformAttachments.map((attachment) => attachment.serverId),
  )
  if (new Set([...slotServers, ...attachmentServers]).size <= 1) return []

  const serversByNetwork = serversByNetworkFromSlots(
    document,
    slots,
    serviceRows,
  )
  addPlatformAttachmentServers(serversByNetwork, platformAttachments)

  const declared = readOverlayDeclaredNetworkKeys(document)
  return [...serversByNetwork.entries()]
    .filter(([key, servers]) => servers.size > 1 && declared.has(key))
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b))
}

export function participatingServerIdsForNetwork(
  document: ComposeDocument,
  slots: readonly SpanningSlot[],
  serviceRows: readonly SpanningServiceRow[],
  networkKey: string,
  platformAttachments: readonly PlatformAttachment[] = [],
): string[] {
  const nameByServiceId = new Map(
    serviceRows.map((row) => [row.id, row.composeServiceName]),
  )
  const services = isPlainObject(document.data.services) ? document.data.services : {}
  const serverIds = new Set<string>()
  for (const slot of slots) {
    const name = nameByServiceId.get(slot.serviceId)
    if (!name) continue
    const body = services[name]
    if (!composeServiceNetworkKeys(body).includes(networkKey)) continue
    serverIds.add(slot.serverId)
  }
  for (const attachment of platformAttachments) {
    if (!attachment.networkKeys.includes(networkKey)) continue
    serverIds.add(attachment.serverId)
  }
  return [...serverIds].sort((a, b) => a.localeCompare(b))
}

function serversByNetworkFromSlots(
  document: ComposeDocument,
  slots: readonly SpanningSlot[],
  serviceRows: readonly SpanningServiceRow[],
): Map<string, Set<string>> {
  const nameByServiceId = new Map(
    serviceRows.map((row) => [row.id, row.composeServiceName]),
  )
  const serversByServiceName = new Map<string, Set<string>>()
  for (const slot of slots) {
    const name = nameByServiceId.get(slot.serviceId)
    if (!name) continue
    const servers = serversByServiceName.get(name) ?? new Set<string>()
    servers.add(slot.serverId)
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
