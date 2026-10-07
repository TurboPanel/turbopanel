/**
 * The control plane's view of the runtime registry.
 *
 * A small static mirror of `turbopaneld/orchestration/runtime-registry.json`,
 * which the daemon imports directly. The control plane cannot import across
 * repos, so this exists for save-time validation and for offering choices in
 * the UI. The **authoritative** answer for a specific host is that server's
 * reported inventory (`server.metadata.runtimes`), and deploy-prepare is where
 * the two meet: a series this list does not know is a hard error, one the host
 * has not installed yet is a warning because the deploy installs it.
 *
 * Divergence therefore degrades to "offered a series the server has not
 * reported" — visible, never exploitable.
 */

/**
 * Runtimes an operator can grant a principal by hand. Deno is deliberately not
 * here yet: a Deno app's grant is recorded by deploy, and the database's
 * `entitlement_runtime_check` only allows `deno` after the instance migration
 * (`runtimeSeries('deno')` is still answered for deploy).
 */
export const SUPPORTED_RUNTIMES: readonly string[] = ['php', 'node']

/**
 * Series across every runtime, as one flat list.
 *
 * Flat because an entitlement is validated as a `(runtime, series)` pair
 * against the registry on the host anyway; this is a shape gate, not the
 * authority. `runtimeSeries` is what the UI should offer per runtime.
 */
export const SUPPORTED_RUNTIME_SERIES: readonly string[] = [
  '8.1',
  '8.2',
  '8.3',
  '8.4',
  '8.5',
  '22',
  '24',
  '26',
]

/** Series offered for one runtime, or `[]` for one this list does not know. */
export function runtimeSeries(runtime: string): readonly string[] {
  if (runtime === 'php') return ['8.1', '8.2', '8.3', '8.4', '8.5']
  if (runtime === 'node') return ['22', '24', '26']
  if (runtime === 'deno') return ['2']
  return []
}

/**
 * Default PHP series when a site declares no `php.version`.
 *
 * Mirrors the daemon's `DEFAULT_PHP_FPM_SERIES`, which `resolveSitePhpSeries`
 * falls back to, so the grant a per-site runtime implies names the series the
 * host actually runs.
 */
export const DEFAULT_SITE_PHP_SERIES = '8.4'

/** Default Node series when a native app declares no `nodeVersion`. */
export const DEFAULT_NATIVE_APP_NODE_SERIES = '24'

/**
 * Normalize a Node pin to the **exec boundary** (`24.17.0` → `24`).
 *
 * Mirrors `entitlementSeries('node', …)` in the daemon registry so deploy
 * grants and vendored paths agree on the series directory.
 */
export function nodeEntitlementSeries(version: string = DEFAULT_NATIVE_APP_NODE_SERIES): string {
  const major = version.trim().split('.')[0]
  if (!major || !/^\d+$/.test(major)) return DEFAULT_NATIVE_APP_NODE_SERIES
  return major
}

/**
 * Default Deno series when a Deno app declares no `denoVersion`. Deno ships one
 * major (2) and many minors, so a series is the major: the host runs the newest
 * 2.x release.
 */
export const DEFAULT_NATIVE_APP_DENO_SERIES = '2'

/**
 * Normalize a Deno pin to the **exec boundary** (`2.9.7` → `2`).
 *
 * Mirrors `entitlementSeries('deno', …)` in the daemon registry.
 */
export function denoEntitlementSeries(version: string = DEFAULT_NATIVE_APP_DENO_SERIES): string {
  const major = version.trim().split('.')[0]
  if (!major || !/^\d+$/.test(major)) return DEFAULT_NATIVE_APP_DENO_SERIES
  return major
}
