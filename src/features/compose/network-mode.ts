/**
 * `network_mode` helpers. A service that sets `network_mode` has no network of
 * its own: `service:x` and `container:x` share the target's network namespace
 * (and its `/etc/hosts`), `host` uses the host's, `none` has none. Nothing
 * that attaches a network or writes `extra_hosts` may touch such a service.
 */

export type NetworkModeShare =
  { kind: 'service' | 'container'; target: string } | { kind: 'host' | 'none' }

/** Parse a `network_mode` value; undefined for an absent or unknown one. */
export function parseNetworkMode(value: unknown): NetworkModeShare | undefined {
  if (typeof value !== 'string') return undefined
  const mode = value.trim()
  if (mode === 'host' || mode === 'none') return { kind: mode }
  const match = /^(service|container):(.+)$/.exec(mode)
  if (match === null) return undefined
  return { kind: match[1] as 'service' | 'container', target: match[2] as string }
}

/**
 * The service that owns the network `name` ends up on, following `service:`
 * chains (a loop stops at the first repeat). `name` itself when it sets no
 * `network_mode`; undefined when the chain ends at `container:`, `host` or
 * `none`, or loops.
 */
export function resolveNetworkModeOwner(
  name: string,
  services: Record<string, unknown>
): string | undefined {
  const seen = new Set<string>()
  let current = name
  while (!seen.has(current)) {
    seen.add(current)
    const body = services[current]
    const share =
      typeof body === 'object' && body !== null
        ? parseNetworkMode((body as Record<string, unknown>).network_mode)
        : undefined
    if (share === undefined) return current
    if (share.kind !== 'service' || !(share.target in services)) {
      // Names the file does not define are kept as they are.
      return share.kind === 'service' && !(share.target in services) ? current : undefined
    }
    current = share.target
  }
  return undefined
}

/**
 * Move per-service attachments (managed network, `extra_hosts`) off services
 * that cannot hold them. A `service:x` service hands its entry to the owner of
 * its network when that is a service in the file; `container:x`, `host` and
 * `none` services drop it.
 */
export function redirectNetworkModeNames(
  names: readonly string[],
  services: Record<string, unknown>
): string[] {
  const out = new Set<string>()
  for (const name of names) {
    const owner = resolveNetworkModeOwner(name, services)
    if (owner !== undefined) out.add(owner)
  }
  return [...out]
}
