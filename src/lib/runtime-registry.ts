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

/** Runtimes a principal can be entitled to execute. */
export const SUPPORTED_RUNTIMES: readonly string[] = ['php', 'node']

/**
 * Series across every runtime, as one flat list.
 *
 * Flat because an entitlement is validated as a `(runtime, series)` pair
 * against the registry on the host anyway; this is a shape gate, not the
 * authority. `runtimeSeries` is what the UI should offer per runtime.
 */
export const SUPPORTED_RUNTIME_SERIES: readonly string[] = [
  '8.3',
  '8.4',
  '22',
  '24',
]

/** Series offered for one runtime, or `[]` for one this list does not know. */
export function runtimeSeries(runtime: string): readonly string[] {
  if (runtime === 'php') return ['8.3', '8.4']
  if (runtime === 'node') return ['22', '24']
  return []
}
