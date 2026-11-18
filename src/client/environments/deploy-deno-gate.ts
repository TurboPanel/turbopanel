/**
 * A Deno app (`x-turbopanel.runtime: deno`) only goes out with a Deno series
 * this platform offers; the panel refuses first, naming the app, and nothing is
 * sent.
 */
import {
  denoRuntimeSeries,
  runtimeSeries,
  DEFAULT_NATIVE_APP_DENO_SERIES,
} from '../../contracts/runtime-registry.ts'

export type DenoAppVersionError = {
  kind: 'deno_version_unsupported'
  composeServiceName: string
  requested: string
  supported: string[]
}

type DenoGateApp = { composeServiceName: string; runtime?: 'node' | 'deno'; denoVersion?: string }

function denoApps<T extends DenoGateApp>(apps: readonly T[]): T[] {
  return apps.filter((app) => app.runtime === 'deno')
}

/** Pure check: the first Deno app that asks for a series nothing here offers. */
export function denoAppWithUnsupportedVersion(
  apps: readonly DenoGateApp[]
): DenoAppVersionError | undefined {
  const offered = runtimeSeries('deno')
  for (const app of denoApps(apps)) {
    const requested = app.denoVersion?.trim() || DEFAULT_NATIVE_APP_DENO_SERIES
    if (offered.includes(denoRuntimeSeries(requested))) continue
    return {
      kind: 'deno_version_unsupported',
      composeServiceName: app.composeServiceName,
      requested,
      supported: [...offered],
    }
  }
  return undefined
}

/**
 * On a rollback, each pinned native app runs on the runtime its release ran on,
 * not the one the compose document names now. Without this a site switched
 * from Node to Deno would be sent back as a Deno app (and the Deno gate would
 * follow the document, not the release). A pin without a
 * runtime is a Node release, so `deno` is cleared. Apps without a pin, and
 * every non-rollback deploy (`pins` undefined), are returned as they are.
 */
export function withRecordedRuntimes<T extends DenoGateApp & { nodeVersion?: string }>(
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
