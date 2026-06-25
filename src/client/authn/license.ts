import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { license } from '../../lib/db/schema.ts'
import { generatePassword } from '../../generate-secret.ts'
import { hashPassword, verifyPassword } from './password.ts'

export type LicenseRecord = {
  id: string
  organizationId: string
  displayName: string | null
  createdAt: string
}

function nowTs(): string {
  return new Date().toISOString()
}

export async function generateLicenseToken(): Promise<{
  plaintext: string
  hashed: string
}> {
  const plaintext = generatePassword(48)
  const hashed = await hashPassword(plaintext)
  return { plaintext, hashed }
}

export async function verifyLicenseToken(
  plaintext: string,
  hashed: string,
): Promise<boolean> {
  return verifyPassword(plaintext, hashed)
}

export async function createLicense(
  db: Db,
  opts: { organizationId: string; displayName?: string },
): Promise<{ licenseId: string; licenseToken: string }> {
  const { plaintext, hashed } = await generateLicenseToken()
  const now = nowTs()

  const inserted = await db
    .insert(license)
    .values({
      organizationId: opts.organizationId,
      displayName: opts.displayName ?? null,
      token: hashed,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: license.id })

  const licenseId = inserted[0]?.id
  if (!licenseId) {
    throw new Error('License creation failed')
  }

  return { licenseId, licenseToken: plaintext }
}

export async function revokeLicense(
  db: Db,
  licenseId: string,
  organizationId: string,
): Promise<boolean> {
  const updated = await db
    .update(license)
    .set({ revokedAt: nowTs(), updatedAt: nowTs() })
    .where(and(
      eq(license.id, licenseId),
      eq(license.organizationId, organizationId),
      isNull(license.revokedAt),
    ))
    .returning({ id: license.id })

  return updated.length > 0
}

export async function listLicenses(
  db: Db,
  organizationId: string,
): Promise<LicenseRecord[]> {
  return db
    .select({
      id: license.id,
      organizationId: license.organizationId,
      displayName: license.displayName,
      createdAt: license.createdAt,
    })
    .from(license)
    .where(and(
      eq(license.organizationId, organizationId),
      isNull(license.revokedAt),
    ))
}

export async function lookupActiveLicense(
  db: Db,
  licenseId: string,
): Promise<{ organizationId: string; token: string } | null> {
  const rows = await db
    .select({
      organizationId: license.organizationId,
      token: license.token,
    })
    .from(license)
    .where(and(eq(license.id, licenseId), isNull(license.revokedAt)))
    .limit(1)

  return rows[0] ?? null
}
