import type {
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeploySource,
} from "../../lib/commands/schemas.ts";
import type { PreparedNativeAppService } from "../../lib/compose/ir.ts";
import {
  DEFAULT_NATIVE_APP_NODE_SERIES,
  nodeEntitlementSeries,
  runtimeSeries,
} from "../../lib/runtime-registry.ts";

export type DeployRuntimeEntitlement = {
  principalId: string;
  runtime: string;
  series: string;
};

function runtimeKey(runtime: string, series: string): string {
  return `${runtime}@${series}`;
}

function materialHasRuntime(
  material: EnvironmentDeployPrincipalMaterial,
  runtime: string,
  series: string,
): boolean {
  return (material.runtimes ?? []).some(
    (entry) => entry.runtime === runtime && entry.series === series,
  );
}

function mergeRuntimeIntoMaterial(
  material: EnvironmentDeployPrincipalMaterial,
  runtime: string,
  series: string,
): EnvironmentDeployPrincipalMaterial {
  if (materialHasRuntime(material, runtime, series)) {
    return material;
  }
  return {
    ...material,
    runtimes: [...(material.runtimes ?? []), { runtime, series }],
  };
}

function unchangedPrincipalMaterial(
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[],
): {
  principalMaterial: EnvironmentDeployPrincipalMaterial[];
  deployEntitlements: DeployRuntimeEntitlement[];
} {
  return { principalMaterial: [...principalMaterial], deployEntitlements: [] };
}

function indexPrincipalIdsByComposeService(
  sourceMaterial: readonly EnvironmentDeploySource[],
): Map<string, string> {
  const principalIdByComposeService = new Map<string, string>();
  for (const entry of sourceMaterial) {
    const principalId = entry.principal?.principalId;
    if (principalId) {
      principalIdByComposeService.set(entry.composeServiceName, principalId);
    }
  }
  return principalIdByComposeService;
}

function nodeSeriesForApp(
  app: PreparedNativeAppService,
  offeredNodeSeries: ReadonlySet<string>,
): string | undefined {
  const requested = app.nodeVersion?.trim() || DEFAULT_NATIVE_APP_NODE_SERIES;
  const series = nodeEntitlementSeries(requested);
  return offeredNodeSeries.has(series) ? series : undefined;
}

function pushUniqueEntitlement(
  list: DeployRuntimeEntitlement[],
  entitlement: DeployRuntimeEntitlement,
): void {
  const key = runtimeKey(entitlement.runtime, entitlement.series);
  if (list.some((entry) => runtimeKey(entry.runtime, entry.series) === key)) {
    return;
  }
  list.push(entitlement);
}

function collectImpliedRuntimes(
  nativeAppServices: readonly PreparedNativeAppService[],
  principalIdByComposeService: ReadonlyMap<string, string>,
): Map<string, DeployRuntimeEntitlement[]> {
  const impliedByPrincipal = new Map<string, DeployRuntimeEntitlement[]>();
  const offeredNodeSeries = new Set(runtimeSeries("node"));

  for (const app of nativeAppServices) {
    const principalId = principalIdByComposeService.get(app.composeServiceName);
    if (!principalId) continue;
    const series = nodeSeriesForApp(app, offeredNodeSeries);
    if (!series) continue;

    const list = impliedByPrincipal.get(principalId) ?? [];
    pushUniqueEntitlement(list, { principalId, runtime: "node", series });
    impliedByPrincipal.set(principalId, list);
  }
  return impliedByPrincipal;
}

function compareDeployEntitlements(
  a: DeployRuntimeEntitlement,
  b: DeployRuntimeEntitlement,
): number {
  const byPrincipal = a.principalId.localeCompare(b.principalId);
  if (byPrincipal !== 0) return byPrincipal;
  const byRuntime = a.runtime.localeCompare(b.runtime);
  if (byRuntime !== 0) return byRuntime;
  return a.series.localeCompare(b.series);
}

function applyImpliedRuntimes(
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[],
  impliedByPrincipal: ReadonlyMap<string, DeployRuntimeEntitlement[]>,
): {
  principalMaterial: EnvironmentDeployPrincipalMaterial[];
  deployEntitlements: DeployRuntimeEntitlement[];
} {
  const byId = new Map(
    principalMaterial.map((entry) => [entry.principalId, { ...entry }]),
  );
  const deployEntitlements: DeployRuntimeEntitlement[] = [];

  for (const [principalId, implied] of impliedByPrincipal) {
    const existing = byId.get(principalId);
    if (!existing) continue;

    let next = existing;
    for (const entry of implied) {
      if (!materialHasRuntime(next, entry.runtime, entry.series)) {
        deployEntitlements.push(entry);
      }
      next = mergeRuntimeIntoMaterial(next, entry.runtime, entry.series);
    }
    byId.set(principalId, next);
  }

  deployEntitlements.sort(compareDeployEntitlements);
  const principalMaterialOut = [...byId.values()].sort((a, b) =>
    a.principalId.localeCompare(b.principalId)
  );
  return { principalMaterial: principalMaterialOut, deployEntitlements };
}

/**
 * Merge Node runtime entitlements implied by `nativeAppServices[]` into
 * `principalMaterial[]` for the deploy wire.
 *
 * A `serviceKind: node` app runs `corepack` / `node` from the vendored tenant
 * tree; the owning principal must hold `tpnode<series>` before systemd starts
 * the unit. Build already runs under `sg tpnode<series>`; runtime does not.
 */
export function mergeDeployPrincipalRuntimes(args: {
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[];
  nativeAppServices: readonly PreparedNativeAppService[];
  sourceMaterial: readonly EnvironmentDeploySource[];
}): {
  principalMaterial: EnvironmentDeployPrincipalMaterial[];
  deployEntitlements: DeployRuntimeEntitlement[];
} {
  const { principalMaterial, nativeAppServices, sourceMaterial } = args;
  if (nativeAppServices.length === 0) {
    return unchangedPrincipalMaterial(principalMaterial);
  }

  const impliedByPrincipal = collectImpliedRuntimes(
    nativeAppServices,
    indexPrincipalIdsByComposeService(sourceMaterial),
  );
  if (impliedByPrincipal.size === 0) {
    return unchangedPrincipalMaterial(principalMaterial);
  }

  return applyImpliedRuntimes(principalMaterial, impliedByPrincipal);
}
