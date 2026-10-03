/**
 * Read the published host ports out of a compose document's `ports:` entries.
 *
 * Pure: it takes the merged compose `data` (project base + environment
 * overlay) and returns what the host would listen on, nothing else. Used by the
 * firewall derivation so a service that publishes a port shows up as a derived
 * `published` rule.
 *
 * Forms handled (Compose Specification):
 *  - short syntax: `"8080:80"`, `"8080:80/udp"`, `"127.0.0.1:5432:5432"`,
 *    `"[::1]:8080:80"`, `"0.0.0.0:80:80"`, ranges `"8000-8010:8000-8010"`;
 *  - long syntax: `{ target, published, host_ip, protocol, mode }`.
 *
 * Not a fixed host port, so not a rule (a note says why): a bare container
 * port (`"80"`, Docker picks a random host port), an empty host side
 * (`"127.0.0.1::80"`), `${VAR}` interpolation (its value is unknown here) and
 * unsupported protocols (`sctp`). A port bound to loopback is not exposed and
 * yields nothing at all.
 */

import { parseFirewallPortRange } from '../../contracts/commands/schemas.ts'
import { parseIpVersion } from '../../lib/ip-address.ts'

export type PublishedPort = {
  proto: 'tcp' | 'udp'
  /** One port or an inclusive ascending range (`8080`, `8000-8010`). */
  ports: string
  /** The single host address the port is bound to; absent means every address. */
  hostIp?: string
}

export type ServicePublishedPort = PublishedPort & { service: string }

export type ComposePortsResult = {
  ports: ServicePublishedPort[]
  /** Why an entry produced no rule, in plain words; one line per entry. */
  notes: string[]
}

type EntryResult = { port?: PublishedPort; note?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.')
}

function normalizeHostPorts(value: string): string | null {
  const range = parseFirewallPortRange(value)
  if (range === null) return null
  return range.from === range.to ? String(range.from) : `${range.from}-${range.to}`
}

/**
 * Split `[HOST_IP:]HOST_PORT:CONTAINER_PORT` into its parts. An IPv6 host
 * address must be in brackets (`[::1]:8080:80`), as Compose requires.
 */
function splitShortEntry(entry: string): { ip?: string; host?: string; container: string } | null {
  let rest = entry
  let ip: string | undefined
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close < 0 || rest[close + 1] !== ':') return null
    ip = rest.slice(1, close)
    rest = rest.slice(close + 2)
  }
  const parts = rest.split(':')
  if (ip !== undefined) {
    return parts.length === 2 ? { ip, host: parts[0], container: parts[1] ?? '' } : null
  }
  if (parts.length === 1) return { container: parts[0] ?? '' }
  if (parts.length === 2) return { host: parts[0], container: parts[1] ?? '' }
  if (parts.length === 3) return { ip: parts[0], host: parts[1], container: parts[2] ?? '' }
  return null
}

function splitProtocol(entry: string): { body: string; proto: string } {
  const slash = entry.lastIndexOf('/')
  if (slash < 0) return { body: entry, proto: 'tcp' }
  return { body: entry.slice(0, slash), proto: entry.slice(slash + 1).toLowerCase() }
}

function resolveHostIp(raw: string | undefined): { ip?: string; loopback: boolean } | null {
  if (raw === undefined || raw === '' || raw === '0.0.0.0' || raw === '::') {
    return { loopback: false }
  }
  if (parseIpVersion(raw) === null) return null
  return isLoopback(raw) ? { loopback: true } : { ip: raw, loopback: false }
}

function buildPort(
  proto: string,
  hostPorts: string | undefined,
  hostIpRaw: string | undefined,
  label: string
): EntryResult {
  if (proto !== 'tcp' && proto !== 'udp') {
    return { note: `${label}: protocol ${proto} is not supported by the firewall` }
  }
  if (hostPorts === undefined || hostPorts === '') {
    return { note: `${label}: Docker picks a random host port, so there is no fixed port to open` }
  }
  const ports = normalizeHostPorts(hostPorts)
  if (ports === null)
    return { note: `${label}: host port ${hostPorts} is not a valid port or range` }
  const bind = resolveHostIp(hostIpRaw)
  if (bind === null) return { note: `${label}: host address ${hostIpRaw} is not an IP address` }
  if (bind.loopback) return {}
  return { port: { proto, ports, ...(bind.ip === undefined ? {} : { hostIp: bind.ip }) } }
}

function parseShortEntry(entry: string): EntryResult {
  if (entry.includes('${')) {
    return { note: `${entry}: uses a variable, so its host port is unknown here` }
  }
  const { body, proto } = splitProtocol(entry.trim())
  const parts = splitShortEntry(body)
  if (parts === null) return { note: `${entry}: not a recognised ports entry` }
  return buildPort(proto, parts.host, parts.ip, entry)
}

function longHostPorts(published: unknown): string | undefined {
  if (typeof published === 'number') return String(published)
  return typeof published === 'string' ? published : undefined
}

function parseLongEntry(entry: Record<string, unknown>): EntryResult {
  const published = entry.published
  const label = `published ${String(longHostPorts(published) ?? '')} -> ${String(longHostPorts(entry.target) ?? '')}`
  if (typeof published === 'string' && published.includes('${')) {
    return { note: `${label}: uses a variable, so its host port is unknown here` }
  }
  const hostPorts = longHostPorts(published)
  const proto = typeof entry.protocol === 'string' ? entry.protocol.toLowerCase() : 'tcp'
  const hostIp = typeof entry.host_ip === 'string' ? entry.host_ip : undefined
  return buildPort(proto, hostPorts, hostIp, label)
}

/** One `ports:` entry of any form. */
export function parseComposePortEntry(entry: unknown): EntryResult {
  if (typeof entry === 'number') {
    return { note: `${entry}: Docker picks a random host port, so there is no fixed port to open` }
  }
  if (typeof entry === 'string') return parseShortEntry(entry)
  if (isRecord(entry)) return parseLongEntry(entry)
  return { note: 'a ports entry that is neither a string, a number nor an object was ignored' }
}

/** The published ports of every service of a merged compose document. */
export function publishedPortsOfCompose(data: unknown): ComposePortsResult {
  const result: ComposePortsResult = { ports: [], notes: [] }
  if (!isRecord(data) || !isRecord(data.services)) return result
  for (const [service, body] of Object.entries(data.services)) {
    if (!isRecord(body) || !Array.isArray(body.ports)) continue
    for (const entry of body.ports) {
      const parsed = parseComposePortEntry(entry)
      if (parsed.port !== undefined) result.ports.push({ ...parsed.port, service })
      if (parsed.note !== undefined) result.notes.push(`${service}: ${parsed.note}`)
    }
  }
  return result
}
