import type {
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeploySite,
  EnvironmentDeploySource,
} from '../../contracts/commands/schemas.ts'
import type { PreparedNativeAppService } from '../../features/compose/ir.ts'
import {
  DEFAULT_NATIVE_APP_NODE_SERIES,
  DEFAULT_SITE_PHP_SERIES,
  nodeEntitlementSeries,
  runtimeSeries,
} from '../../contracts/runtime-registry.ts'

export type DeployRuntimeEntitlement = {
  principalId: string
  runtime: string
  series: string
}

function runtimeKey(runtime: string, series: string): string {
  return `${runtime}@${series}`
}

function materialHasRuntime(
  material: EnvironmentDeployPrincipalMaterial,
  runtime: string,
  series: string
): boolean {
  return (material.runtimes ?? []).some(
    (entry) => entry.runtime === runtime && entry.series === series
  )
}

function mergeRuntimeIntoMaterial(
  material: EnvironmentDeployPrincipalMaterial,
  runtime: string,
  series: string
): EnvironmentDeployPrincipalMaterial {
  if (materialHasRuntime(material, runtime, series)) {
    return material
  }
  return {
    ...material,
    runtimes: [...(material.runtimes ?? []), { runtime, series }],
  }
}

function unchangedPrincipalMaterial(
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[]
): {
  principalMaterial: EnvironmentDeployPrincipalMaterial[]
  deployEntitlements: DeployRuntimeEntitlement[]
} {
  return { principalMaterial: [...principalMaterial], deployEntitlements: [] }
}

function indexPrincipalIdsByComposeService(
  sourceMaterial: readonly EnvironmentDeploySource[]
): Map<string, string> {
  const principalIdByComposeService = new Map<string, string>()
  for (const entry of sourceMaterial) {
    const principalId = entry.principal?.principalId
    if (principalId) {
      principalIdByComposeService.set(entry.composeServiceName, principalId)
    }
  }
  return principalIdByComposeService
}

function nodeSeriesForApp(
  app: PreparedNativeAppService,
  offeredNodeSeries: ReadonlySet<string>
): string | undefined {
  const requested = app.nodeVersion?.trim() || DEFAULT_NATIVE_APP_NODE_SERIES
  const series = nodeEntitlementSeries(requested)
  return offeredNodeSeries.has(series) ? series : undefined
}

function pushUniqueEntitlement(
  list: DeployRuntimeEntitlement[],
  entitlement: DeployRuntimeEntitlement
): void {
  const key = runtimeKey(entitlement.runtime, entitlement.series)
  if (list.some((entry) => runtimeKey(entry.runtime, entry.series) === key)) {
    return
  }
  list.push(entitlement)
}

function addImpliedRuntime(
  impliedByPrincipal: Map<string, DeployRuntimeEntitlement[]>,
  entitlement: DeployRuntimeEntitlement
): void {
  const list = impliedByPrincipal.get(entitlement.principalId) ?? []
  pushUniqueEntitlement(list, entitlement)
  impliedByPrincipal.set(entitlement.principalId, list)
}

function collectImpliedNodeRuntimes(
  impliedByPrincipal: Map<string, DeployRuntimeEntitlement[]>,
  nativeAppServices: readonly PreparedNativeAppService[],
  principalIdByComposeService: ReadonlyMap<string, string>
): void {
  const offeredNodeSeries = new Set(runtimeSeries('node'))
  for (const app of nativeAppServices) {
    const principalId = principalIdByComposeService.get(app.composeServiceName)
    if (!principalId) continue
    const series = nodeSeriesForApp(app, offeredNodeSeries)
    if (!series) continue
    addImpliedRuntime(impliedByPrincipal, { principalId, runtime: 'node', series })
  }
}

/**
 * Whether the daemon runs this site's PHP as its principal: a per-site
 * FastCGI or php-fpm runtime under nginx or Apache. Mirrors the daemon's
 * `sitePhpRuntimeMode`; lsphp and the shared pool imply nothing here.
 */
function siteRunsPhpAsPrincipal(site: EnvironmentDeploySite): boolean {
  if (site.engine !== 'nginx' && site.engine !== 'apache') return false
  const mode = site.php?.mode
  return mode === 'fastcgi' || mode === 'fpm'
}

/** The site's `php.version`, else the default — the daemon's `resolveSitePhpSeries`. */
function phpSeriesForSite(
  site: EnvironmentDeploySite,
  offeredPhpSeries: ReadonlySet<string>
): string | undefined {
  const series = site.php?.version?.trim() || DEFAULT_SITE_PHP_SERIES
  return offeredPhpSeries.has(series) ? series : undefined
}

function collectImpliedPhpRuntimes(
  impliedByPrincipal: Map<string, DeployRuntimeEntitlement[]>,
  sites: readonly EnvironmentDeploySite[]
): void {
  const offeredPhpSeries = new Set(runtimeSeries('php'))
  for (const site of sites) {
    const principalId = site.principal?.principalId
    if (!principalId || !siteRunsPhpAsPrincipal(site)) continue
    const series = phpSeriesForSite(site, offeredPhpSeries)
    if (!series) continue
    addImpliedRuntime(impliedByPrincipal, { principalId, runtime: 'php', series })
  }
}

function collectImpliedRuntimes(
  nativeAppServices: readonly PreparedNativeAppService[],
  sourceMaterial: readonly EnvironmentDeploySource[],
  sites: readonly EnvironmentDeploySite[]
): Map<string, DeployRuntimeEntitlement[]> {
  const impliedByPrincipal = new Map<string, DeployRuntimeEntitlement[]>()
  if (nativeAppServices.length > 0) {
    collectImpliedNodeRuntimes(
      impliedByPrincipal,
      nativeAppServices,
      indexPrincipalIdsByComposeService(sourceMaterial)
    )
  }
  collectImpliedPhpRuntimes(impliedByPrincipal, sites)
  return impliedByPrincipal
}

function compareDeployEntitlements(
  a: DeployRuntimeEntitlement,
  b: DeployRuntimeEntitlement
): number {
  const byPrincipal = a.principalId.localeCompare(b.principalId)
  if (byPrincipal !== 0) return byPrincipal
  const byRuntime = a.runtime.localeCompare(b.runtime)
  if (byRuntime !== 0) return byRuntime
  return a.series.localeCompare(b.series)
}

function applyImpliedRuntimes(
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[],
  impliedByPrincipal: ReadonlyMap<string, DeployRuntimeEntitlement[]>
): {
  principalMaterial: EnvironmentDeployPrincipalMaterial[]
  deployEntitlements: DeployRuntimeEntitlement[]
} {
  const byId = new Map(principalMaterial.map((entry) => [entry.principalId, { ...entry }]))
  const deployEntitlements: DeployRuntimeEntitlement[] = []

  for (const [principalId, implied] of impliedByPrincipal) {
    const existing = byId.get(principalId)
    if (!existing) continue

    let next = existing
    for (const entry of implied) {
      if (!materialHasRuntime(next, entry.runtime, entry.series)) {
        deployEntitlements.push(entry)
      }
      next = mergeRuntimeIntoMaterial(next, entry.runtime, entry.series)
    }
    byId.set(principalId, next)
  }

  deployEntitlements.sort(compareDeployEntitlements)
  const principalMaterialOut = [...byId.values()].sort((a, b) =>
    a.principalId.localeCompare(b.principalId)
  )
  return { principalMaterial: principalMaterialOut, deployEntitlements }
}

/**
 * Merge runtime entitlements implied by what this deploy runs as a principal
 * into `principalMaterial[]` for the deploy wire.
 *
 * - A `serviceKind: node` app runs `corepack` / `node` from the vendored tenant
 *   tree; the owning principal must hold `tpnode<series>` before systemd starts
 *   the unit. Build already runs under `sg tpnode<series>`; runtime does not.
 * - A site whose `php.mode` is `fastcgi` or `fpm` (nginx / Apache) runs
 *   `php-cgi<series>` / `php-fpm<series>` as its principal, and those binaries
 *   are `0750 root:tpphp<series>` — without the grant the unit dies `203/EXEC`.
 *
 * The daemon reconciles the **effective** set it is sent and derives nothing,
 * so the returned `deployEntitlements` are persisted (`grantedBy: deploy`) for
 * `server.principals.reconcile` and other environments' deploys to carry.
 */
export function mergeDeployPrincipalRuntimes(args: {
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[]
  nativeAppServices: readonly PreparedNativeAppService[]
  sourceMaterial: readonly EnvironmentDeploySource[]
  sites?: readonly EnvironmentDeploySite[]
}): {
  principalMaterial: EnvironmentDeployPrincipalMaterial[]
  deployEntitlements: DeployRuntimeEntitlement[]
} {
  const { principalMaterial, nativeAppServices, sourceMaterial, sites = [] } = args
  const impliedByPrincipal = collectImpliedRuntimes(nativeAppServices, sourceMaterial, sites)
  if (impliedByPrincipal.size === 0) {
    return unchangedPrincipalMaterial(principalMaterial)
  }

  return applyImpliedRuntimes(principalMaterial, impliedByPrincipal)
}
