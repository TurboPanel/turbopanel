/**
 * Deploy-time checks for the hosting `www` mode. The daemon applies the same
 * rules in `turbopaneld/src/contracts/deploy-validation.ts`.
 */

import { wwwSiblingHostname } from './hostname.ts'
import type { EnvironmentDeployHosting } from './schemas.ts'

function isHttp(hosting: EnvironmentDeployHosting): boolean {
  return (hosting.protocol ?? 'http') === 'http'
}

function validateWwwHostnames(
  hosting: EnvironmentDeployHosting,
  typed: ReadonlySet<string>
): string | null {
  for (const hostname of hosting.hostnames) {
    const sibling = wwwSiblingHostname(hostname)
    if (sibling === null) {
      return `www: ${hostname} has no www or bare spelling to use`
    }
    if (typed.has(sibling)) {
      return `www: ${sibling} is already a hostname in this environment, so ${hostname} cannot also claim it`
    }
  }
  return null
}

/** Hostings on different paths of one name must make the same www choice. */
function findMixedWwwModes(hostings: readonly EnvironmentDeployHosting[]): string | null {
  const modeByName = new Map<string, string>()
  for (const hosting of hostings) {
    const mode = hosting.www ?? 'off'
    for (const hostname of hosting.hostnames) {
      const seen = modeByName.get(hostname)
      if (seen !== undefined && seen !== mode) {
        return `www: every path of ${hostname} must use the same www choice (found ${seen} and ${mode})`
      }
      modeByName.set(hostname, mode)
    }
  }
  return null
}

/**
 * `www` answers on a second name per hostname, so it only makes sense on
 * `http`, every such name must be a valid hostname, none may already be a
 * hostname in the same deploy (that would be two sites for one name), and every
 * path of one name must make the same choice (so one spelling is never a
 * redirect for one path and the site for another).
 */
export function validateDeployWwwModes(hostings: EnvironmentDeployHosting[]): string | null {
  const http = hostings.filter(isHttp)
  const typed = new Set(http.flatMap((hosting) => hosting.hostnames))
  for (const hosting of hostings.filter((h) => h.www !== undefined)) {
    const error = isHttp(hosting)
      ? validateWwwHostnames(hosting, typed)
      : 'www requires the http protocol'
    if (error) return error
  }
  return findMixedWwwModes(http)
}
