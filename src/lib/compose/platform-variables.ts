/**
 * Reserved TURBOPANEL_* deploy variable helpers.
 *
 * Pure — no DB / Deno / Workers APIs. Injected last by deploy-prepare so user
 * variables never shadow platform identity keys.
 */

import { RESERVED_DEPLOY_VARIABLE_KEYS } from '../naming.ts'
import type { DeployVariableEntry } from './apply-variables.ts'

export type PlatformDeployVariableInput = {
  projectId: string
  environmentId: string
  serviceId: string
  /** Row UUID — omit for custom-naming services with no pre-allocation. */
  containerId?: string
  /** Compose `container_name` / future DNS label — omit when unallocated. */
  containerName?: string
}

function platformEntry(key: string, value: string): DeployVariableEntry {
  return {
    key,
    value,
    isSecret: false,
    isLiteral: true,
    forBuild: false,
    forRuntime: true,
  }
}

/**
 * Build the six reserved deploy identity variables for one compose service
 * clone. When `containerId` / `containerName` are omitted (custom naming
 * without pre-allocation), the three container-scoped keys are left out.
 *
 * `TURBOPANEL_SERVICE_HOST` equals the container name — Docker's embedded DNS
 * resolves `container_name` on the compose user-defined network today; it is
 * also the future DNS label.
 */
export function buildPlatformDeployVariables(
  input: PlatformDeployVariableInput,
): DeployVariableEntry[] {
  const entries: DeployVariableEntry[] = [
    platformEntry('TURBOPANEL_PROJECT_ID', input.projectId),
    platformEntry('TURBOPANEL_ENVIRONMENT_ID', input.environmentId),
    platformEntry('TURBOPANEL_SERVICE_ID', input.serviceId),
  ]
  if (input.containerId) {
    entries.push(platformEntry('TURBOPANEL_CONTAINER_ID', input.containerId))
  }
  if (input.containerName) {
    entries.push(
      platformEntry('TURBOPANEL_CONTAINER_NAME', input.containerName),
      platformEntry('TURBOPANEL_SERVICE_HOST', input.containerName),
    )
  }
  return entries
}

/** Drop any entries whose key is in {@link RESERVED_DEPLOY_VARIABLE_KEYS}. */
export function stripReservedDeployVariableKeys(
  entries: readonly DeployVariableEntry[],
): DeployVariableEntry[] {
  return entries.filter((entry) => !RESERVED_DEPLOY_VARIABLE_KEYS.has(entry.key))
}
