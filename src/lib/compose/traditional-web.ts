/**
 * Split traditional-web services out of a compose services map for deploy.
 *
 * Container services stay in Docker Compose; traditional-web sites are
 * applied on the host (nginx, Apache, and OpenLiteSpeed — vendored under
 * `/opt/turbopanel/vendor` on the daemon).
 */

import {
  isTraditionalWebComposeService,
  readServiceTurbopanelExtension,
  type TraditionalWebEngine,
} from './service-kind.ts'

export type TraditionalWebSiteSpec = {
  composeServiceName: string
  engine: TraditionalWebEngine
  /** Document-root segment under the site directory (default `public`). */
  root: string
  /** Loopback listen port for hosting Caddy → nginx/apache. */
  listenPort: number
}

const DEFAULT_ROOT = 'public'
const LISTEN_PORT_BASE = 18_080
const LISTEN_PORT_SPAN = 920

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject path traversal and absolute paths — daemon resolves under stateDir. */
export function isSafeTraditionalWebRoot(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 200) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false
  if (trimmed.includes('..')) return false
  if (trimmed.includes('\0')) return false
  return /^[A-Za-z0-9._/-]+$/.test(trimmed)
}

function hashServiceName(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + (name.codePointAt(i) ?? 0)) >>> 0
  }
  return hash
}

/**
 * Prefer hosting `targetPort` when free; otherwise a stable port in
 * 18080–18999 derived from the compose service name.
 */
export function allocateTraditionalWebListenPort(
  composeServiceName: string,
  used: Set<number>,
  preferred?: number,
): number {
  if (
    preferred !== undefined &&
    Number.isInteger(preferred) &&
    preferred >= 1024 &&
    preferred <= 65_535 &&
    !used.has(preferred)
  ) {
    used.add(preferred)
    return preferred
  }

  let port = LISTEN_PORT_BASE + (hashServiceName(composeServiceName) % LISTEN_PORT_SPAN)
  for (let attempt = 0; attempt < LISTEN_PORT_SPAN; attempt++) {
    if (!used.has(port)) {
      used.add(port)
      return port
    }
    port = port >= LISTEN_PORT_BASE + LISTEN_PORT_SPAN - 1
      ? LISTEN_PORT_BASE
      : port + 1
  }
  throw new Error('No free traditional-web listen port in 18080–18999')
}

export type SplitTraditionalWebResult = {
  /** Services that remain for Docker Compose. */
  containerServices: Record<string, unknown>
  sites: TraditionalWebSiteSpec[]
}

/**
 * Partition compose `services` into Docker containers vs traditional-web sites.
 *
 * `preferredListenPortByService` comes from hosting `targetPort` when set.
 *
 * `usedPorts` is the caller's loopback-port ledger. Traditional-web vhosts and
 * native `node` apps both listen on 127.0.0.1 and are both reverse-proxied by
 * hosting Caddy, so the two lanes must allocate out of **one** set or a site
 * and an app can be handed the same port. Callers that split both kinds pass
 * the same set to `splitNativeAppServices` (`native-app.ts`).
 */
export function splitTraditionalWebServices(
  services: Record<string, unknown>,
  preferredListenPortByService: ReadonlyMap<string, number> = new Map(),
  usedPorts: Set<number> = new Set<number>(),
): SplitTraditionalWebResult {
  const containerServices: Record<string, unknown> = {}
  const sites: TraditionalWebSiteSpec[] = []

  const names = Object.keys(services).sort((a, b) => a.localeCompare(b))
  for (const name of names) {
    const raw = services[name]
    if (!isPlainMapping(raw) || !isTraditionalWebComposeService(raw)) {
      containerServices[name] = raw
      continue
    }

    const extension = readServiceTurbopanelExtension(raw)
    const engine = extension?.engine
    if (!engine) {
      // Validation should have rejected this earlier; keep out of Docker.
      continue
    }

    const rootRaw = extension.root?.trim() || DEFAULT_ROOT
    const root = isSafeTraditionalWebRoot(rootRaw) ? rootRaw : DEFAULT_ROOT
    const listenPort = allocateTraditionalWebListenPort(
      name,
      usedPorts,
      preferredListenPortByService.get(name),
    )

    sites.push({
      composeServiceName: name,
      engine,
      root,
      listenPort,
    })
  }

  return {
    containerServices,
    sites,
  }
}

/** Runtime compose YAML body when every service is traditional-web. */
export function emptyContainerComposeYaml(): string {
  return 'services: {}\n'
}

/**
 * Re-assign listen ports after hosting `targetPort` values are known.
 * Preserves engine/root; returns a new array sorted by compose service name.
 *
 * `used` is shared with the native-app allocator for the same reason
 * {@link splitTraditionalWebServices} shares it — one loopback ledger per
 * deploy, not one per lane.
 */
export function assignTraditionalWebListenPorts(
  sites: readonly TraditionalWebSiteSpec[],
  preferredListenPortByService: ReadonlyMap<string, number> = new Map(),
  used: Set<number> = new Set<number>(),
): TraditionalWebSiteSpec[] {
  const sorted = [...sites].sort((a, b) =>
    a.composeServiceName.localeCompare(b.composeServiceName)
  )
  return sorted.map((site) => ({
    ...site,
    listenPort: allocateTraditionalWebListenPort(
      site.composeServiceName,
      used,
      preferredListenPortByService.get(site.composeServiceName),
    ),
  }))
}
