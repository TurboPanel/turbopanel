import type { EnvironmentDeployNativeAppService } from '../../contracts/commands/schemas.ts'
import { parseResourceLimits } from '../../features/organizations/resource-limits.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Effective (most restrictive) org ∩ server ceiling for one account.
 *
 * The per-principal systemd slice is generated from this, so a per-app
 * `CPUQuota` can never add up to more than the account is entitled to. Absent
 * fields stay absent — an unset limit means "no slice directive", not zero.
 */
export function effectiveAccountLimits(
  orgOptions: unknown,
  serverOptions: unknown
): EnvironmentDeployNativeAppService['accountLimits'] | undefined {
  const orgLimits =
    parseResourceLimits(isPlainObject(orgOptions) ? orgOptions.resourceLimits : null) ?? {}
  const serverLimits =
    parseResourceLimits(isPlainObject(serverOptions) ? serverOptions.resourceLimits : null) ?? {}
  const pick = (a?: number, b?: number): number | undefined => {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.min(a, b)
  }
  const cpus = pick(orgLimits.maxCpus, serverLimits.maxCpus)
  const memoryBytes = pick(orgLimits.maxMemoryBytes, serverLimits.maxMemoryBytes)
  if (cpus === undefined && memoryBytes === undefined) return undefined
  return {
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
  }
}
