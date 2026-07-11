import type { Response } from 'hono'

export type LicenseRuntime = 'deno' | 'workers'

/**
 * Billing gate for license invalidation. Self-hosted always allows.
 * Workers: future subscription / seat billing checks go here.
 */
export async function assertLicenseInvalidationAllowed(
  _runtime: LicenseRuntime,
  _licenseId: string,
): Promise<Response | null> {
  return null
}
