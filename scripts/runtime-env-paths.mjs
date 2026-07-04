/**
 * Resolve secret-bearing runtime env paths from the instance-launch contract.
 * Mirrors the compose logic in src/server-paths.ts for standalone Node scripts.
 */
export function resolveRuntimeEnvConfigDir(env = process.env) {
  return (env.TURBOPANEL_CONFIG_DIR?.trim() || '/etc/turbopanel').replace(/\/$/, '')
}

export function resolveRuntimeEnvPath(env = process.env) {
  const explicit = env.TURBOPANEL_INSTANCE_RUNTIME_ENV?.trim()
  if (explicit) return explicit
  return `${resolveRuntimeEnvConfigDir(env)}/instance/runtime.env`
}

export function resolveRuntimeDevVarsPath(env = process.env) {
  const explicit = env.TURBOPANEL_INSTANCE_RUNTIME_DEV_VARS?.trim()
  if (explicit) return explicit
  return `${resolveRuntimeEnvConfigDir(env)}/instance/runtime.dev-vars`
}
