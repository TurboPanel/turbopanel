import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { revokeDaemonKey } from '../../daemon/authn/server-identity-db.ts'
import { license, server } from '../../lib/db/schema.ts'
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

export async function disconnectServersBoundToLicense(
  db: Db,
  licenseId: string,
  organizationId: string,
): Promise<void> {
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .where(and(
      eq(server.licenseId, licenseId),
      eq(server.organizationId, organizationId),
    ))

  for (const row of rows) {
    await revokeDaemonKey(db, row.id)
  }
}

/** Soft-invalidates a license and revokes daemon keys on bound servers. */
export async function invalidateLicense(
  db: Db,
  licenseId: string,
  organizationId: string,
): Promise<boolean> {
  const revoked = await revokeLicense(db, licenseId, organizationId)
  if (!revoked) return false
  await disconnectServersBoundToLicense(db, licenseId, organizationId)
  return true
}

export type LicenseBoundServer = {
  id: string
  displayName: string | null
}

export async function listServersBoundToLicenses(
  db: Db,
  organizationId: string,
  licenseIds: string[],
): Promise<Map<string, LicenseBoundServer>> {
  const bound = new Map<string, LicenseBoundServer>()
  if (licenseIds.length === 0) return bound

  const rows = await db
    .select({
      licenseId: server.licenseId,
      id: server.id,
      displayName: server.displayName,
    })
    .from(server)
    .where(and(
      eq(server.organizationId, organizationId),
      inArray(server.licenseId, licenseIds),
    ))

  const byLicense = new Map<string, LicenseBoundServer[]>()
  for (const row of rows) {
    if (!row.licenseId) continue
    const list = byLicense.get(row.licenseId) ?? []
    list.push({ id: row.id, displayName: row.displayName })
    byLicense.set(row.licenseId, list)
  }

  for (const [licenseId, servers] of byLicense) {
    if (servers.length === 1) {
      bound.set(licenseId, servers[0]!)
    }
  }

  return bound
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
