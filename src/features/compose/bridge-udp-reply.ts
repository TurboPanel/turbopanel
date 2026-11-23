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

/** Protocols that answer from a new port, by the UDP port they are published on. */
const NEW_PORT_REPLY_PROTOCOLS: ReadonlyMap<number, string> = new Map([[69, 'TFTP']])

const LAN_NETWORK_DRIVERS: ReadonlySet<string> = new Set(['macvlan', 'ipvlan'])

export type BridgeUdpReplyFinding = {
  service: string
  protocol: string
  port: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `[host_ip:][host:]container[/protocol]`, as the host and container ports and the protocol. */
function readShortEntry(entry: string): { ports: number[]; protocol: string } {
  const [body = '', protocol = 'tcp'] = entry.trim().split('/')
  const afterAddress = body.replace(/^\[[^\]]*\]:/, '')
  const parts = afterAddress.split(':')
  const ports = (parts.length >= 3 ? parts.slice(-2) : parts)
    .map((part) => (/^\d+$/.test(part.trim()) ? Number(part) : Number.NaN))
    .filter((port) => Number.isInteger(port))
  return { ports, protocol: protocol.toLowerCase() }
}

function readEntry(entry: unknown): { ports: number[]; protocol: string } {
  if (typeof entry === 'string') return readShortEntry(entry)
  if (!isRecord(entry)) return { ports: [], protocol: 'tcp' }
  const ports = [entry.published, entry.target]
    .map((value) => Number(value))
    .filter((port) => Number.isInteger(port))
  const protocol = typeof entry.protocol === 'string' ? entry.protocol.toLowerCase() : 'tcp'
  return { ports, protocol }
}

function onlyOnLanNetworks(
  service: Record<string, unknown>,
  topLevelNetworks: Record<string, unknown>
): boolean {
  const attached = service.networks
  const names = Array.isArray(attached) ? attached : isRecord(attached) ? Object.keys(attached) : []
  if (names.length === 0) return false
  return names.every((name) => {
    const network = topLevelNetworks[String(name)]
    const driver = isRecord(network) ? network.driver : undefined
    return typeof driver === 'string' && LAN_NETWORK_DRIVERS.has(driver)
  })
}

/** One finding per service and protocol that publishes a UDP port on a bridge network. */
export function bridgeUdpReplyFindings(
  services: Record<string, unknown>,
  topLevelNetworks: Record<string, unknown> = {}
): BridgeUdpReplyFinding[] {
  const found: BridgeUdpReplyFinding[] = []
  for (const [name, raw] of Object.entries(services)) {
    if (!isRecord(raw) || !Array.isArray(raw.ports)) continue
    if (parseNetworkMode(raw.network_mode) !== undefined) continue
    if (onlyOnLanNetworks(raw, topLevelNetworks)) continue
    for (const entry of raw.ports) {
      const { ports, protocol } = readEntry(entry)
      if (protocol !== 'udp') continue
      for (const port of ports) {
        const label = NEW_PORT_REPLY_PROTOCOLS.get(port)
        if (label === undefined) continue
        if (!found.some((item) => item.service === name && item.protocol === label)) {
          found.push({ service: name, protocol: label, port })
        }
      }
    }
  }
  return found
}

/** Services that use host networking, where published-port checks do not apply. */
export function hostNetworkServices(services: Record<string, unknown>): string[] {
  return Object.entries(services)
    .filter(([, raw]) => isRecord(raw) && parseNetworkMode(raw.network_mode)?.kind === 'host')
    .map(([name]) => name)
}
