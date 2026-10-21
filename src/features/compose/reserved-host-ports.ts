/**
 * Host ports a container service may not publish, so the deploy preview can
 * show the refusal the host would give.
 *
 * Twin of `RESERVED_HOST_PORT_RANGES` in the daemon's
 * `src/deploy/compose-final-policy.ts`: the host is the authority and refuses
 * the deploy; this copy only lets the preview say so first. Keep the lists
 * identical.
 */

export const RESERVED_HOST_PORT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [80, 80],
  [443, 443],
  [2019, 2019],
  [2029, 2029],
  [2039, 2039],
  [6070, 6070],
  [7080, 7081],
  [7443, 7443],
  [18080, 18999],
  [19100, 19799],
]

/** The reserved host ports as a short list, e.g. `80, 443, 7080-7081`. */
export function describeReservedHostPorts(): string {
  return RESERVED_HOST_PORT_RANGES.map(([lo, hi]) => (lo === hi ? String(lo) : `${lo}-${hi}`)).join(
    ', '
  )
}

function parseRange(text: string): [number, number] | undefined {
  const [from, to = from] = text.trim().split('-')
  const lo = Number(from)
  const hi = Number(to)
  return from !== '' && Number.isInteger(lo) && Number.isInteger(hi) ? [lo, hi] : undefined
}

/** The published (host) port or range of one `ports:` entry, when it names one. */
export function publishedHostRange(entry: unknown): [number, number] | undefined {
  if (typeof entry === 'number') return undefined
  if (typeof entry === 'object' && entry !== null) {
    const published = (entry as { published?: unknown }).published
    if (typeof published === 'number') return parseRange(String(published))
    return typeof published === 'string' ? parseRange(published) : undefined
  }
  if (typeof entry !== 'string') return undefined
  // `[::1]:8080:80/tcp`: drop the protocol and a bracketed address.
  const body = (entry.split('/')[0] ?? '').replace(/^\[[^\]]*\]:/, '')
  const parts = body.split(':')
  if (parts.length < 2) return undefined
  return parseRange(parts.length === 2 ? (parts[0] ?? '') : (parts.at(-2) ?? ''))
}

/** One finding per container service that publishes a reserved host port. */
export function reservedHostPortFindings(
  services: Record<string, unknown>
): { service: string; port: number }[] {
  const found: { service: string; port: number }[] = []
  for (const [service, raw] of Object.entries(services)) {
    const ports = (raw as { ports?: unknown } | null)?.ports
    if (!Array.isArray(ports)) continue
    for (const entry of ports) {
      const range = publishedHostRange(entry)
      if (range === undefined) continue
      if (RESERVED_HOST_PORT_RANGES.some(([lo, hi]) => range[0] <= hi && range[1] >= lo)) {
        found.push({ service, port: range[0] })
      }
    }
  }
  return found
}
