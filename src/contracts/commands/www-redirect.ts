/**
 * Deploy-time checks for the hosting `www` mode. The daemon applies the same
 * rules in `turbopaneld/src/contracts/deploy-validation.ts`.
 */

import { type HostingWwwNames, hostingWwwNames, wwwSiblingHostname } from './hostname.ts'
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

function expandWwwNames(hostings: readonly EnvironmentDeployHosting[]): HostingWwwNames[] {
  return hostings.flatMap((hosting) =>
    hosting.hostnames.flatMap((hostname) => hostingWwwNames(hostname, hosting.www) ?? [])
  )
}

/** A name one hosting redirects away must not be a name another one serves. */
function findRedirectServedClash(hostings: readonly EnvironmentDeployHosting[]): string | null {
  const expanded = expandWwwNames(hostings)
  const served = new Set(expanded.flatMap((names) => names.serve))
  const clash = expanded.find(
    (names) => names.redirect !== null && served.has(names.redirect.from)
  )?.redirect
  return clash
    ? `www: ${clash.from} is sent to ${clash.to} by one hosting but served by another`
    : null
}

/**
 * `www` answers on a second name per hostname, so it only makes sense on
 * `http`, every such name must be a valid hostname, none may already be a
 * hostname in the same deploy (that would be two sites for one name), and a
 * name redirected by one hosting may not be served by another (two hostings on
 * different paths of one name must agree on which spelling is the site).
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
  return findRedirectServedClash(http)
}
