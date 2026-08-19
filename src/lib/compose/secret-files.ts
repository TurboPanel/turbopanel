/**
 * Compose standalone secret file paths and plan entries.
 *
 * Host files live under `/run/turbopanel/deployments/<projectId>/<environmentId>/secrets/`.
 * Compiled YAML references those paths; values never enter compose.yaml.
 */

export const DEFAULT_DEPLOY_RUN_DIR = '/run/turbopanel'

export type DeploySecretPlanEntry = {
  key: string
  composeServiceName: string
  /** Top-level Compose `secrets:` source name. */
  source: string
  /** Filename under `/run/secrets/` inside the container. */
  target: string
  /** Basename under the host secrets directory. */
  relativePath: string
  forBuild: boolean
  forRuntime: boolean
}

function isWordChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z')
    || (ch >= 'A' && ch <= 'Z')
    || (ch >= '0' && ch <= '9')
    || ch === '_'
}

function trimCharRun(value: string, ch: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === ch) start++
  while (end > start && value[end - 1] === ch) end--
  return value.slice(start, end)
}

function trimTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end--
  return path.slice(0, end)
}

/** Linear-time slug (Sonar typescript:S8786 — no `\W+` / anchor trims). */
function slugToken(value: string): string {
  let slug = ''
  for (const ch of value) {
    slug += isWordChar(ch) ? ch : '_'
  }
  slug = trimCharRun(slug, '_')
  return slug.length > 0 ? slug : 'x'
}

export function composeSecretSourceName(
  composeServiceName: string,
  key: string,
): string {
  return `${slugToken(composeServiceName)}_${slugToken(key)}`.toLowerCase()
}

function isSafeSecretTargetKey(key: string): boolean {
  if (key.length === 0) return false
  for (const ch of key) {
    const isAlnum = (ch >= 'A' && ch <= 'Z')
      || (ch >= 'a' && ch <= 'z')
      || (ch >= '0' && ch <= '9')
    if (!isAlnum && ch !== '.' && ch !== '_' && ch !== '-') return false
  }
  return true
}

export function composeSecretTargetName(key: string): string {
  if (isSafeSecretTargetKey(key)) return key
  return slugToken(key)
}

export function secretRelativePath(
  composeServiceName: string,
  key: string,
): string {
  return `${slugToken(composeServiceName)}--${key}`
}

export function secretHostDirectory(
  projectId: string,
  environmentId: string,
  runDir: string = DEFAULT_DEPLOY_RUN_DIR,
): string {
  return `${trimTrailingSlashes(runDir)}/deployments/${projectId}/${environmentId}/secrets`
}

export function secretHostPath(
  projectId: string,
  environmentId: string,
  relativePath: string,
  runDir: string = DEFAULT_DEPLOY_RUN_DIR,
): string {
  return `${secretHostDirectory(projectId, environmentId, runDir)}/${relativePath}`
}

export function secretContainerPath(target: string): string {
  return `/run/secrets/${target}`
}

export function secretFileEnvKey(key: string): string {
  return key.endsWith('_FILE') ? key : `${key}_FILE`
}

export function buildSecretPlanEntry(params: {
  key: string
  composeServiceName: string
  forBuild: boolean
  forRuntime: boolean
  /** Container `/run/secrets/<target>` name; defaults to the variable key. */
  target?: string
}): DeploySecretPlanEntry {
  const target = composeSecretTargetName(params.target ?? params.key)
  return {
    key: params.key,
    composeServiceName: params.composeServiceName,
    source: composeSecretSourceName(params.composeServiceName, params.key),
    target,
    relativePath: secretRelativePath(params.composeServiceName, params.key),
    forBuild: params.forBuild,
    forRuntime: params.forRuntime,
  }
}
