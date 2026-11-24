/**
 * A site's background workers and post-deploy commands are service options, set
 * on the service (`PATCH /services/:id`, the service's worker and post-deploy
 * settings), never read from Compose. Left in `x-turbopanel` they would be
 * dropped without a word, so a site would deploy with no queue worker; refuse
 * them at save and say where they go.
 */
import { TURBOPANEL_EXTENSION_KEY } from './placement.ts'

export const SERVICE_OPTION_ONLY_KEYS = [
  'workers',
  'postDeployCommands',
  'postDeployTimeoutSeconds',
  'postDeployTiming',
] as const

export type ServiceOptionOnlyKeyIssue = { path: string; message: string }

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function collectServiceOptionOnlyKeyIssues(
  services: Record<string, unknown>
): ServiceOptionOnlyKeyIssue[] {
  const issues: ServiceOptionOnlyKeyIssue[] = []
  for (const [name, service] of Object.entries(services)) {
    if (!isMapping(service)) continue
    const extension = service[TURBOPANEL_EXTENSION_KEY]
    if (!isMapping(extension)) continue
    for (const key of SERVICE_OPTION_ONLY_KEYS) {
      if (!(key in extension)) continue
      issues.push({
        path: `services.${name}.${TURBOPANEL_EXTENSION_KEY}.${key}`,
        message: `${key} is not read from Compose; set it in the service's worker and post-deploy settings instead`,
      })
    }
  }
  return issues
}
