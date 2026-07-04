/**
 * Vendored runtime root contract (mirrors daemon `src/paths/layout.ts`).
 *
 * Override with `TURBOPANEL_RUNTIMES_DIR` or `TURBOPANEL_RUNTIME_DIR`.
 */

export const DEFAULT_TURBOPANEL_HOME = '/opt/turbopanel'

/** Production FHS default for vendored runtimes (`/opt/turbopanel/vendor`). */
export const DEFAULT_RUNTIMES_DIR = `${DEFAULT_TURBOPANEL_HOME}/vendor`

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/'
}

/** Resolve the vendored runtime root directory. */
export function resolveRuntimesDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const override = env.TURBOPANEL_RUNTIMES_DIR?.trim() ||
    env.TURBOPANEL_RUNTIME_DIR?.trim()
  return stripTrailingSlash(override || DEFAULT_RUNTIMES_DIR)
}

/** Managed Node binary (`…/node/current/bin/node`). */
export function resolveManagedNodeBin(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return env.TURBOPANEL_NODE?.trim() ||
    `${resolveRuntimesDir(env)}/node/current/bin/node`
}

/** Managed Deno binary (`…/deno/current/deno`). */
export function resolveManagedDenoBin(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return env.TURBOPANEL_DENO?.trim() ||
    `${resolveRuntimesDir(env)}/deno/current/deno`
}
