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

/** Series offered for one runtime, or `[]` for one this list does not know. */
export function runtimeSeries(runtime: string): readonly string[] {
  if (runtime === 'php') return ['8.1', '8.2', '8.3', '8.4', '8.5']
  if (runtime === 'node') return ['22', '24', '26']
  if (runtime === 'deno') return ['2']
  return []
}

/** Default Node series when a native app declares no `nodeVersion`. */
export const DEFAULT_NATIVE_APP_NODE_SERIES = '24'

/**
 * Default Deno series when a Deno app declares no `denoVersion`. Deno ships one
 * major (2) and many minors, so a series is the major: the host runs the newest
 * 2.x release.
 */
export const DEFAULT_NATIVE_APP_DENO_SERIES = '2'

/**
 * Normalize a Deno pin to its series (`2.9.7` → `2`), the directory the host
 * vendors it under. Mirrors the daemon registry's series normalization.
 */
export function denoRuntimeSeries(version: string = DEFAULT_NATIVE_APP_DENO_SERIES): string {
  const major = version.trim().split('.')[0]
  if (!major || !/^\d+$/.test(major)) return DEFAULT_NATIVE_APP_DENO_SERIES
  return major
}
