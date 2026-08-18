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

function slugToken(value: string): string {
  const slug = value.replaceAll(/\W+/g, '_').replace(/^_+/, '').replace(/_+$/, '')
  return slug.length > 0 ? slug : 'x'
}

export function composeSecretSourceName(
  composeServiceName: string,
  key: string,
): string {
  return `${slugToken(composeServiceName)}_${slugToken(key)}`.toLowerCase()
}

export function composeSecretTargetName(key: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(key)) return key
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
  return `${runDir.replace(/\/+$/, '')}/deployments/${projectId}/${environmentId}/secrets`
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
