/**
 * Split site services out of a compose services map for deploy.
 *
 * Container services stay in Docker Compose; sites are
 * applied on the host (nginx, Apache, and OpenLiteSpeed — vendored under
 * `/opt/turbopanel/vendor` on the daemon).
 */

import {
  isSiteComposeService,
  readServiceTurbopanelExtension,
  type ComposeServicePhpExtension,
  type SiteEngine,
  type SiteSourceKind,
} from './service-kind.ts'

export type SiteSpec = {
  composeServiceName: string
  engine: SiteEngine
  /** Document-root segment under the site directory (default `public`). */
  root: string
  /** Loopback listen port for hosting Caddy → nginx/apache. */
  listenPort: number
  /** PHP config from `x-turbopanel.php`, when the service declares any. */
  php?: ComposeServicePhpExtension
  /**
   * Where the content comes from. Omitted means `release`, which is what every
   * site had before the managed-directory lane existed.
   *
   * Carried rather than resolved to a default here: the daemon reads an absent
   * value as `release` too, and emitting an explicit `release` on every site
   * would churn the wire for services that never opted in.
   */
  sourceKind?: SiteSourceKind
}

/** Engine a site gets when its compose block does not name one. */
export const DEFAULT_SITE_ENGINE: SiteEngine = 'caddy'

const DEFAULT_ROOT = 'public'
const LISTEN_PORT_BASE = 18_080
const LISTEN_PORT_SPAN = 920

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject path traversal and absolute paths — daemon resolves under stateDir. */
export function isSafeSiteRoot(value: string): boolean {
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
export function allocateSiteListenPort(
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
  throw new Error('No free site listen port in 18080–18999')
}

export type SplitSiteResult = {
  /** Services that remain for Docker Compose. */
  containerServices: Record<string, unknown>
  sites: SiteSpec[]
}

/**
 * Partition compose `services` into Docker containers vs sites.
 *
 * `preferredListenPortByService` comes from hosting `targetPort` when set.
 *
 * `usedPorts` is the caller's loopback-port ledger. Site vhosts and
 * native `node` apps both listen on 127.0.0.1 and are both reverse-proxied by
 * hosting Caddy, so the two lanes must allocate out of **one** set or a site
 * and an app can be handed the same port. Callers that split both kinds pass
 * the same set to `splitNativeAppServices` (`native-app.ts`).
 */
export function splitSiteServices(
  services: Record<string, unknown>,
  preferredListenPortByService: ReadonlyMap<string, number> = new Map(),
  usedPorts: Set<number> = new Set<number>(),
): SplitSiteResult {
  const containerServices: Record<string, unknown> = {}
  const sites: SiteSpec[] = []

  const names = Object.keys(services).sort((a, b) => a.localeCompare(b))
  for (const name of names) {
    const raw = services[name]
    if (!isPlainMapping(raw) || !isSiteComposeService(raw)) {
      containerServices[name] = raw
      continue
    }

    const extension = readServiceTurbopanelExtension(raw)
    // `engine` is optional on a site. This is the one place the default is
    // resolved, so the wire always carries an explicit engine and the daemon
    // never has to guess. Caddy is the default because a static site then
    // needs no engine choice, no PHP pool, and no vhost tuning at all.
    const engine = extension?.engine ?? DEFAULT_SITE_ENGINE

    const rootRaw = extension?.root?.trim() || DEFAULT_ROOT
    const root = isSafeSiteRoot(rootRaw) ? rootRaw : DEFAULT_ROOT
    const listenPort = allocateSiteListenPort(
      name,
      usedPorts,
      preferredListenPortByService.get(name),
    )

    sites.push({
      composeServiceName: name,
      engine,
      root,
      listenPort,
      ...(extension?.php ? { php: extension.php } : {}),
      ...(extension?.sourceKind ? { sourceKind: extension.sourceKind } : {}),
    })
  }

  return {
    containerServices,
    sites,
  }
}

/** Runtime compose YAML body when every service is site. */
export function emptyContainerComposeYaml(): string {
  return 'services: {}\n'
}

/**
 * Re-assign listen ports after hosting `targetPort` values are known.
 * Preserves engine/root; returns a new array sorted by compose service name.
 *
 * `used` is shared with the native-app allocator for the same reason
 * {@link splitSiteServices} shares it — one loopback ledger per
 * deploy, not one per lane.
 */
export function assignSiteListenPorts<
  T extends { composeServiceName: string; listenPort: number },
>(
  sites: readonly T[],
  preferredListenPortByService: ReadonlyMap<string, number> = new Map(),
  used: Set<number> = new Set<number>(),
): T[] {
  const sorted = [...sites].sort((a, b) =>
    a.composeServiceName.localeCompare(b.composeServiceName)
  )
  return sorted.map((site) => ({
    ...site,
    listenPort: allocateSiteListenPort(
      site.composeServiceName,
      used,
      preferredListenPortByService.get(site.composeServiceName),
    ),
  }))
}
