/**
 * Split native `serviceKind: node` services out of a compose services map.
 *
 * A `node` service is neither a Docker container nor a document root: the Git
 * release engine publishes it into `<principalHome>/sites/<serviceId>/current`
 * exactly like any other release, and the daemon supervises it with a generated
 * `turbopanel-app-<serviceId>.service` unit listening on an allocated loopback
 * port. Hosting Caddy reverse-proxies to that port the same way it already does
 * for a site vhost — which is precisely why the port allocator here
 * is the site one, driven from a **shared** used-port ledger.
 */

import {
  isNodeComposeService,
  type NativeRuntimeFramework,
  type NodeAppMode,
  readServiceTurbopanelExtension,
} from './service-kind.ts'
import { allocateSiteListenPort } from './site.ts'

export type NativeAppServiceSpec = {
  composeServiceName: string
  /** Resolved runtime family; `auto` leaves detection to the daemon build. */
  framework: NativeRuntimeFramework
  /** Loopback listen port for hosting Caddy → the app process. */
  listenPort: number
  /** Operator-pinned Node series, when the author declared one. */
  nodeVersion?: string
  /** `NODE_ENV` for build and unit. Omitted means `production`. */
  appMode?: NodeAppMode
  /**
   * Omitted means `true`. A disabled app is still emitted — dropping it would
   * make the daemon reconcile tear the unit down and strand the release; the
   * daemon stops and disables the unit instead of starting it.
   */
  enabled?: boolean
  /** Script run when `source.startCommand` is absent. Default `server.js`. */
  startupFile?: string
}

/** Framework when `x-turbopanel.framework` is omitted. */
export const NATIVE_APP_DEFAULT_FRAMEWORK: NativeRuntimeFramework = 'auto'

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type SplitNativeAppResult = {
  /** Services that remain for Docker Compose (native apps removed). */
  containerServices: Record<string, unknown>
  apps: NativeAppServiceSpec[]
}

/**
 * Partition compose `services`, pulling `serviceKind: node` entries out into
 * {@link NativeAppServiceSpec} rows.
 *
 * `usedPorts` must be the same set the site split used — see
 * `splitSiteServices`. Passing a fresh set is only correct when the
 * caller knows there are no sites in the same document.
 */
export function splitNativeAppServices(
  services: Record<string, unknown>,
  usedPorts: Set<number> = new Set<number>(),
  preferredListenPortByService: ReadonlyMap<string, number> = new Map(),
): SplitNativeAppResult {
  const containerServices: Record<string, unknown> = {}
  const apps: NativeAppServiceSpec[] = []

  const names = Object.keys(services).sort((a, b) => a.localeCompare(b))
  for (const name of names) {
    const raw = services[name]
    if (!isPlainMapping(raw) || !isNodeComposeService(raw)) {
      containerServices[name] = raw
      continue
    }

    const extension = readServiceTurbopanelExtension(raw)
    // Validation rejects a `node` service with no source; a document that slips
    // through anyway must still stay out of Docker — an image-less service
    // would just fail `compose up`.
    if (!extension?.source) continue

    apps.push({
      composeServiceName: name,
      framework: extension.framework ?? NATIVE_APP_DEFAULT_FRAMEWORK,
      listenPort: allocateSiteListenPort(
        name,
        usedPorts,
        preferredListenPortByService.get(name),
      ),
      ...(extension.nodeVersion === undefined
        ? {}
        : { nodeVersion: extension.nodeVersion }),
      ...(extension.appMode === undefined ? {} : { appMode: extension.appMode }),
      ...(extension.enabled === undefined ? {} : { enabled: extension.enabled }),
      ...(extension.startupFile === undefined
        ? {}
        : { startupFile: extension.startupFile }),
    })
  }

  return { containerServices, apps }
}

/**
 * Re-assign listen ports once hosting `targetPort` values are known, sharing
 * `used` with {@link assignSiteListenPorts} so the two lanes cannot
 * collide. Returns a new array sorted by compose service name.
 */
export function assignNativeAppListenPorts<
  T extends { composeServiceName: string; listenPort: number },
>(
  apps: readonly T[],
  preferredListenPortByService: ReadonlyMap<string, number> = new Map(),
  used: Set<number> = new Set<number>(),
): T[] {
  const sorted = [...apps].sort((a, b) =>
    a.composeServiceName.localeCompare(b.composeServiceName)
  )
  return sorted.map((app) => ({
    ...app,
    listenPort: allocateSiteListenPort(
      app.composeServiceName,
      used,
      preferredListenPortByService.get(app.composeServiceName),
    ),
  }))
}
