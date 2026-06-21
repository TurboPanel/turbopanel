import type { Db } from '../../db.ts'
import {
  lookupActiveLicense,
  verifyLicenseToken,
} from '../../client/authn/license.ts'

export type VerifiedDaemonLicense = {
  organizationId: string
}

/** Verify a daemon hello licenseId + licenseToken pair against the license table. */
export async function verifyDaemonLicense(
  db: Db,
  licenseId: string,
  licenseToken: string,
): Promise<VerifiedDaemonLicense | null> {
  const id = licenseId.trim()
  const token = licenseToken.trim()
  if (!id || !token) return null

  const activeLicense = await lookupActiveLicense(db, id)
  if (!activeLicense) return null

  const tokenValid = await verifyLicenseToken(token, activeLicense.hashedToken)
  if (!tokenValid) return null

  return { organizationId: activeLicense.organizationId }
}
