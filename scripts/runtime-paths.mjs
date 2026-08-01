/** @typedef {Record<string, string | undefined>} EnvBag */

export const DEFAULT_TURBOPANEL_HOME = '/opt/turbopanel'
export const DEFAULT_RUNTIMES_DIR = `${DEFAULT_TURBOPANEL_HOME}/vendor`

/**
 * @param {EnvBag} [env]
 * @returns {string}
 */
export function resolveRuntimesDir(env = process.env) {
  const override = (env.TURBOPANEL_RUNTIMES_DIR ?? '').trim()
  const dir = override || DEFAULT_RUNTIMES_DIR
  let end = dir.length
  while (end > 0 && (dir.codePointAt(end - 1) ?? 0) === 47) {
    end--
  }
  return end === 0 ? '/' : dir.slice(0, end)
}
