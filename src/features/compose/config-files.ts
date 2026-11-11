/**
 * Generated config files for Compose `configs:` with `content`.
 *
 * The control plane splits each file into ordered parts (literal text, or the
 * name of a secret key) and the daemon puts it together on the `/run` tmpfs
 * under `/run/turbopanel/deployments/<projectId>/<environmentId>/configs/`.
 * Parts hold no secret value; values travel sealed in `variableMaterial[]`.
 */

import { DEFAULT_DEPLOY_RUN_DIR, slugToken } from './secret-files.ts'

export type DeployConfigFilePart = { text: string } | { secretKey: string }

export type DeployConfigFileEntry = {
  composeServiceName: string
  /** Top-level Compose `configs:` source name the compiled document uses. */
  source: string
  /** Basename under the host configs directory. */
  relativePath: string
  parts: DeployConfigFilePart[]
}

/** A secret a generated file reads, kept so a reboot can ask for its value. */
export type DeployConfigSecretRef = { composeServiceName: string; key: string }

/** Limits the daemon's payload parser enforces too (UTF-8 bytes of text). */
export const MAX_CONFIG_FILE_TEXT_BYTES = 65_536
export const MAX_CONFIG_FILES_PER_SERVICE = 16
export const MAX_CONFIG_FILES_TEXT_BYTES_PER_DEPLOY = 262_144

export function configSourceName(composeServiceName: string, configName: string): string {
  return `${slugToken(composeServiceName)}_${slugToken(configName)}`.toLowerCase()
}

export function configRelativePath(composeServiceName: string, configName: string): string {
  return `${slugToken(composeServiceName)}--${slugToken(configName)}`
}

export function configHostDirectory(
  projectId: string,
  environmentId: string,
  runDir: string = DEFAULT_DEPLOY_RUN_DIR
): string {
  let end = runDir.length
  while (end > 0 && runDir[end - 1] === '/') end--
  return `${runDir.slice(0, end)}/deployments/${projectId}/${environmentId}/configs`
}

export function configHostPath(
  projectId: string,
  environmentId: string,
  relativePath: string,
  runDir: string = DEFAULT_DEPLOY_RUN_DIR
): string {
  return `${configHostDirectory(projectId, environmentId, runDir)}/${relativePath}`
}

/** UTF-8 byte length of a file's literal text. */
export function configTextBytes(parts: readonly DeployConfigFilePart[]): number {
  const encoder = new TextEncoder()
  let total = 0
  for (const part of parts) {
    if ('text' in part) total += encoder.encode(part.text).length
  }
  return total
}

/** The secret keys a file names, without repeats. */
export function configSecretKeys(parts: readonly DeployConfigFilePart[]): string[] {
  const keys = new Set<string>()
  for (const part of parts) {
    if ('secretKey' in part) keys.add(part.secretKey)
  }
  return [...keys]
}
