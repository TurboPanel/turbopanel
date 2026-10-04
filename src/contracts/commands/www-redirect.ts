/**
 * Deploy-time checks for the hosting `wwwRedirect` option. The daemon applies
 * the same rules in `turbopaneld/src/contracts/deploy-validation.ts`.
 */

import { wwwSiblingHostname } from './hostname.ts'
import type { EnvironmentDeployHosting } from './schemas.ts'

function isHttp(hosting: EnvironmentDeployHosting): boolean {
  return (hosting.protocol ?? 'http') === 'http'
}

/**
 * `wwwRedirect` serves a second name per hostname, so it only makes sense on
 * `http`, every such name must be a valid hostname, and none may already be a
 * hostname in the same deploy (that would be two sites for one name).
 */
export function validateDeployWwwRedirects(hostings: EnvironmentDeployHosting[]): string | null {
  const served = new Set<string>()
  for (const hosting of hostings) {
    if (isHttp(hosting)) for (const hostname of hosting.hostnames) served.add(hostname)
  }
  for (const hosting of hostings) {
    if (!hosting.wwwRedirect) continue
    if (!isHttp(hosting)) return 'wwwRedirect requires the http protocol'
    for (const hostname of hosting.hostnames) {
      const sibling = wwwSiblingHostname(hostname)
      if (sibling === null) {
        return `wwwRedirect: no valid www/non-www name for hostname ${hostname}`
      }
      if (served.has(sibling)) {
        return `wwwRedirect: ${sibling} is already a hostname in this environment (it would be redirected from ${hostname})`
      }
    }
  }
  return null
}
