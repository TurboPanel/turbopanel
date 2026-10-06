/**
 * A Deno app (`x-turbopanel.runtime: deno`) only goes to a daemon that
 * advertises `deno-native-apps-v1`, and only with a Deno series this platform
 * offers. An older daemon ignores `runtime` and would start the app on Node, so
 * the panel refuses first, naming the app, and nothing is sent.
 */
import type { Db } from '../../db/connection.ts'
import {
  denoEntitlementSeries,
  runtimeSeries,
  DEFAULT_NATIVE_APP_DENO_SERIES,
} from '../../contracts/runtime-registry.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'
import { DENO_NATIVE_APPS_FEATURE } from '../../lib/version-wire.ts'

export { DENO_NATIVE_APPS_FEATURE }

export type DenoAppFeatureError =
  | { kind: 'deno_feature_missing'; composeServiceName: string }
  | {
      kind: 'deno_version_unsupported'
      composeServiceName: string
      requested: string
      supported: string[]
    }

/**
 * The database still has the `entitlement_runtime_check` that allows only php
 * and node, so the Deno grant cannot be recorded. The instance's migration
 * (the owner's to apply) widens it; until then a Deno deploy stops here.
 */
export type DenoMigrationPendingError = { kind: 'deno_migration_pending' }

type DenoGateApp = { composeServiceName: string; runtime?: 'node' | 'deno'; denoVersion?: string }

function denoApps<T extends DenoGateApp>(apps: readonly T[]): T[] {
  return apps.filter((app) => app.runtime === 'deno')
}

/** Pure check: the first Deno app that asks for a series nothing here offers. */
export function denoAppWithUnsupportedVersion(
  apps: readonly DenoGateApp[]
): Extract<DenoAppFeatureError, { kind: 'deno_version_unsupported' }> | undefined {
  const offered = runtimeSeries('deno')
  for (const app of denoApps(apps)) {
    const requested = app.denoVersion?.trim() || DEFAULT_NATIVE_APP_DENO_SERIES
    if (offered.includes(denoEntitlementSeries(requested))) continue
    return {
      kind: 'deno_version_unsupported',
      composeServiceName: app.composeServiceName,
      requested,
      supported: [...offered],
    }
  }
  return undefined
}

/** Pure check: the first Deno app, when the daemon lacks the feature. */
export function denoAppNeedingFeature(
  apps: readonly DenoGateApp[],
  features: readonly string[]
): DenoAppFeatureError | undefined {
  if (features.includes(DENO_NATIVE_APPS_FEATURE)) return undefined
  const app = denoApps(apps)[0]
  return app
    ? { kind: 'deno_feature_missing', composeServiceName: app.composeServiceName }
    : undefined
}

/**
 * On a rollback, each pinned native app runs on the runtime its release ran on,
 * not the one the compose document names now. Without this a site switched
 * from Node to Deno would be sent back as a Deno app (and the Deno gate and
 * runtime grant would follow the document, not the release). A pin without a
 * runtime is a Node release, so `deno` is cleared. Apps without a pin, and
 * every non-rollback deploy (`pins` undefined), are returned as they are.
 */
export function withRecordedRuntimes<
  T extends DenoGateApp & { nodeVersion?: string },
>(
  apps: readonly T[],
  pins: Readonly<Record<string, { runtime?: 'deno' }>> | undefined
): T[] {
  if (pins === undefined) return [...apps]
  return apps.map((app) => {
    const pin = pins[app.composeServiceName]
    if (pin === undefined) return app
    if (pin.runtime === 'deno') {
      if (app.runtime === 'deno') return app
      const { nodeVersion: _node, ...rest } = app
      return { ...rest, runtime: 'deno' as const } as T
    }
    if (app.runtime !== 'deno') return app
    const { runtime: _runtime, denoVersion: _deno, ...rest } = app
    return rest as unknown as T
  })
}

/** Looks the daemon up only when a Deno app is in the deploy. */
export async function withDenoNativeApps(
  db: Db,
  serverId: string,
  apps: readonly DenoGateApp[],
  loadFeatures: (db: Db, serverId: string) => Promise<readonly string[]> = loadDaemonFeatures
): Promise<DenoAppFeatureError | { ok: true }> {
  if (denoApps(apps).length === 0) return { ok: true }
  const unsupported = denoAppWithUnsupportedVersion(apps)
  if (unsupported) return unsupported
  return denoAppNeedingFeature(apps, await loadFeatures(db, serverId)) ?? { ok: true }
}

async function loadDaemonFeatures(db: Db, serverId: string): Promise<readonly string[]> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return state?.projection?.features ?? []
}
