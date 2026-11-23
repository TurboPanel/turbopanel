/**
 * Published UDP ports whose protocol answers from a new port, so a bridge
 * network cannot carry them.
 *
 * Docker's bridge NAT maps the client's flow to the published port only. TFTP
 * (UDP 69) replies from a fresh ephemeral port, which that NAT has no mapping
 * for, so the transfer times out. Host networking or a LAN network (a
 * `macvlan` or `ipvlan` driver) has no such NAT.
 *
 * Pure: the merged services in, findings out. The deploy preview turns each
 * finding into a warning; nothing here refuses a deploy.
 */

import { parseNetworkMode } from './network-mode.ts'
import { parseRange } from './reserved-host-ports.ts'

/** Protocols that answer from a new port, by the UDP port they are published on. */
const NEW_PORT_REPLY_PROTOCOLS: ReadonlyMap<number, string> = new Map([[69, 'TFTP']])

const LAN_NETWORK_DRIVERS: ReadonlySet<string> = new Set(['macvlan', 'ipvlan'])

type Range = [number, number]

export type BridgeUdpReplyFinding = {
  service: string
  protocol: string
  port: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rangeOf(value: unknown): Range[] {
  if (typeof value !== 'string' && typeof value !== 'number') return []
  const range = parseRange(String(value))
  return range === undefined ? [] : [range]
}

/** `[host_ip:][host:]container[/protocol]`: the port ranges and the protocol. */
function readShortEntry(entry: string): { ranges: Range[]; protocol: string } {
  const [body = '', protocol = 'tcp'] = entry.trim().split('/')
  const parts = body.replace(/^\[[^\]]*\]:/, '').split(':')
  const sides = parts.length >= 3 ? parts.slice(-2) : parts
  return { ranges: sides.flatMap(rangeOf), protocol: protocol.trim().toLowerCase() }
}

function readLongEntry(entry: Record<string, unknown>): { ranges: Range[]; protocol: string } {
  const protocol = typeof entry.protocol === 'string' ? entry.protocol : 'tcp'
  return {
    ranges: [...rangeOf(entry.published), ...rangeOf(entry.target)],
    protocol: protocol.trim().toLowerCase(),
  }
}

function readEntry(entry: unknown): { ranges: Range[]; protocol: string } {
  if (typeof entry === 'string') return readShortEntry(entry)
  if (isRecord(entry)) return readLongEntry(entry)
  return { ranges: [], protocol: 'tcp' }
}

/** The first new-port-reply protocol whose port a UDP entry covers. */
function newPortReplyIn(entry: unknown): { protocol: string; port: number } | undefined {
  const { ranges, protocol } = readEntry(entry)
  if (protocol !== 'udp') return undefined
  for (const [port, label] of NEW_PORT_REPLY_PROTOCOLS) {
    if (ranges.some(([lo, hi]) => lo <= port && port <= hi)) return { protocol: label, port }
  }
  return undefined
}

/**
 * A network that is not a Docker bridge: a LAN driver, or an external network
 * whose driver this document does not say (so it is not assumed to be a bridge).
 */
function isNotBridge(network: unknown): boolean {
  if (!isRecord(network)) return false
  if (typeof network.driver === 'string') return LAN_NETWORK_DRIVERS.has(network.driver)
  return network.external === true || isRecord(network.external)
}

function attachedNetworkNames(service: Record<string, unknown>): string[] {
  const attached = service.networks
  if (Array.isArray(attached)) return attached.map(String)
  return isRecord(attached) ? Object.keys(attached) : []
}

/** Whether the service's traffic leaves through a bridge network. */
function onBridge(service: Record<string, unknown>, networks: Record<string, unknown>): boolean {
  if (parseNetworkMode(service.network_mode) !== undefined) return false
  const names = attachedNetworkNames(service)
  if (names.length === 0) return !isNotBridge(networks.default)
  return !names.every((name) => isNotBridge(networks[name]))
}

/** One finding per service and protocol that publishes a UDP port on a bridge network. */
export function bridgeUdpReplyFindings(
  services: Record<string, unknown>,
  networks: Record<string, unknown> = {}
): BridgeUdpReplyFinding[] {
  const found: BridgeUdpReplyFinding[] = []
  for (const [service, raw] of Object.entries(services)) {
    if (!isRecord(raw) || !Array.isArray(raw.ports) || !onBridge(raw, networks)) continue
    const hit = raw.ports.map(newPortReplyIn).find((item) => item !== undefined)
    if (hit !== undefined) found.push({ service, ...hit })
  }
  return found
}

/**
 * Services on host networking that also list `ports:`: Docker ignores those
 * entries there, so the service listens on whatever it binds itself.
 */
export function hostNetworkPortServices(services: Record<string, unknown>): string[] {
  return Object.entries(services)
    .filter(
      ([, raw]) =>
        isRecord(raw) &&
        parseNetworkMode(raw.network_mode)?.kind === 'host' &&
        Array.isArray(raw.ports) &&
        raw.ports.length > 0
    )
    .map(([name]) => name)
}
