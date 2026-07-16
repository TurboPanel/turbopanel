import type { Response } from 'hono'

export type LicenseRuntime = 'deno' | 'workers'

/**
 * Billing gate for license invalidation. Always allows today.
 * Future subscription / seat billing checks go here for both runtimes.
 */
export async function assertLicenseInvalidationAllowed(
  _runtime: LicenseRuntime,
  _licenseId: string,
): Promise<Response | null> {
  return null
}
