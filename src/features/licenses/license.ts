import { and, eq, exists, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { revokeBoundDaemonKey } from './revoke-bound-daemon-key.ts'
import { key, license, server, tier } from '../../db/schema.ts'
import { isUnusedKeyExpired } from './key-expiry.ts'
import { generatePassword } from '../../lib/secrets/generate-secret.ts'
import { hashPassword, verifyPassword } from '../../lib/secrets/password.ts'
import { forEachSequential } from '../../lib/sequential.ts'

export type LicenseRecord = {
  id: string
  organizationId: string
  name: string | null
  createdAt: string
  /** The tier chosen in Add Server, which this key holds until its server enrolls. */
  tierId: string | null
  tierLabel: string | null
  /** When an unused key stops working (`key-expiry.ts`); null never expires. */
  expiresAt: string | null
}

function nowTs(): string {
  return new Date().toISOString()
}

export async function generateLicenseToken(): Promise<{
  plaintext: string
  hashed: string
}> {
  const plaintext = generatePassword()
  const hashed = await hashPassword(plaintext)
  return { plaintext, hashed }
}

export async function verifyLicenseToken(plaintext: string, hashed: string): Promise<boolean> {
  return verifyPassword(plaintext, hashed)
}

/**
 * Mint one registration key. `tierId` is the tier a manager chose in Add
 * Server: the key holds a seat there, and the server that enrolls with it
 * takes that seat (`applyAddServerTierAtEnroll`). Without one the key
 * carries no tier and a manager assigns one later.
 */
export async function createLicense(
  db: Db,
  opts: {
    organizationId: string
    name?: string
    tierId?: string
    expiresAt?: string
    /** Mint the key with no token at all: it can only be used through a ticket (`tickets.ts`). */
    tokenless?: boolean
  }
): Promise<{ licenseId: string; licenseToken: string }> {
  const { plaintext, hashed } = opts.tokenless
    ? { plaintext: '', hashed: null }
    : await generateLicenseToken()
  const now = nowTs()

  const inserted = await db
    .insert(license)
    .values({
      organizationId: opts.organizationId,
      name: opts.name ?? null,
      ...(opts.tierId ? { tierId: opts.tierId } : {}),
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
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

/**
 * Erase a key's token hash. Called when the key binds to a server: from then
 * on the token verifies nothing, so a copy of it captured anywhere is dead.
 */
export async function eraseLicenseToken(db: Db, licenseId: string): Promise<void> {
  await db.update(license).set({ token: null, updatedAt: nowTs() }).where(eq(license.id, licenseId))
}

/**
 * Erase the token hash a bound key still carries, once the daemon of the
 * server it is bound to has proved its key on a session (`POST
 * /auth/session`). A bound key keeps no token hash; the one way it gets one
 * back is a co-located Repair Connection that re-issues the token and keeps
 * the stored daemon key, and a daemon that never parks never re-enrolls to
 * erase it.
 *
 * One conditional write, compare-and-swap on the hash the caller read: a
 * repair that re-issued the token after that read is left alone. It also
 * requires the proved key to still be the server's active key, checked in the
 * same statement, so a repair that removed the key (the daemon must then
 * re-enroll with the new token) keeps its token. True when it erased.
 */
export async function eraseBoundLicenseTokenForKey(
  db: Db,
  params: { licenseId: string; serverId: string; keyId: string; tokenHash: string }
): Promise<boolean> {
  const heldKey = db
    .select({ id: key.id })
    .from(key)
    .where(and(eq(key.id, params.keyId), eq(key.serverId, params.serverId), isNull(key.revokedAt)))
  const rows = await db
    .update(license)
    .set({ token: null, updatedAt: nowTs() })
    .where(
      and(
        eq(license.id, params.licenseId),
        eq(license.serverId, params.serverId),
        eq(license.token, params.tokenHash),
        isNull(license.revokedAt),
        exists(heldKey)
      )
    )
    .returning({ id: license.id })
  return rows.length > 0
}

/**
 * Owner action for a key minted before tickets existed whose token may have
 * crossed an edge: burn the old token and issue a fresh one-hour ticket for
 * the same key. Only an unbound, unrevoked key can be rotated.
 */
export async function burnUnboundLicenseToken(
  db: Db,
  licenseId: string,
  organizationId: string
): Promise<boolean> {
  const rows = await db
    .update(license)
    .set({ token: null, updatedAt: nowTs() })
    .where(
      and(
        eq(license.id, licenseId),
        eq(license.organizationId, organizationId),
        isNull(license.serverId),
        isNull(license.revokedAt)
      )
    )
    .returning({ id: license.id })
  return rows.length > 0
}

export async function revokeLicense(
  db: Db,
  licenseId: string,
  organizationId: string
): Promise<boolean> {
  const updated = await db
    .update(license)
    .set({ revokedAt: nowTs(), updatedAt: nowTs() })
    .where(
      and(
        eq(license.id, licenseId),
        eq(license.organizationId, organizationId),
        isNull(license.revokedAt)
      )
    )
    .returning({ id: license.id })

  return updated.length > 0
}

/**
 * Retire the key(s) bound to a server, inside the server delete's own
 * transaction: from the moment the row is gone no daemon still running on
 * that host can enroll again with its key, and the key never sits active and
 * unused (holding a license) in between. Returns how many were revoked.
 */
export async function revokeLicensesBoundToServer(
  db: Db,
  serverId: string,
  organizationId: string
): Promise<number> {
  const now = nowTs()
  const revoked = await db
    .update(license)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(license.serverId, serverId),
        eq(license.organizationId, organizationId),
        isNull(license.revokedAt)
      )
    )
    .returning({ id: license.id })
  return revoked.length
}

export async function disconnectServersBoundToLicense(
  db: Db,
  licenseId: string,
  organizationId: string
): Promise<string[]> {
  const rows = await db
    .select({ id: server.id })
    .from(license)
    .innerJoin(server, eq(server.id, license.serverId))
    .where(and(eq(license.id, licenseId), eq(license.organizationId, organizationId)))

  const serverIds: string[] = []
  await forEachSequential(rows, async (row) => {
    serverIds.push(row.id)
    await revokeBoundDaemonKey(db, row.id)
  })
  return serverIds
}

export type LicenseAttachment =
  | { ok: false; reason: 'not_found' }
  | { ok: true; boundServer: { id: string; name: string | null } | null }

/** What `invalidateLicense` would see, without revoking anything: the bound server. */
export async function inspectLicenseAttachment(
  db: Db,
  licenseId: string,
  organizationId: string
): Promise<LicenseAttachment> {
  const rows = await db
    .select({
      serverId: license.serverId,
      boundId: server.id,
      boundName: server.name,
    })
    .from(license)
    .leftJoin(server, eq(server.id, license.serverId))
    .where(
      and(
        eq(license.id, licenseId),
        eq(license.organizationId, organizationId),
        isNull(license.revokedAt)
      )
    )
    .limit(1)
  const row = rows[0]
  if (!row) return { ok: false, reason: 'not_found' }
  const boundId = row.boundId ?? row.serverId
  return {
    ok: true,
    boundServer: boundId ? { id: boundId, name: row.boundName ?? null } : null,
  }
}

export type InvalidateLicenseResult =
  | { ok: false; reason: 'not_found' }
  | {
      ok: false
      reason: 'attached'
      boundServer: { id: string; name: string | null }
    }
  | { ok: true; serverIds: string[] }

/**
 * Soft-invalidates a license. A live `server_id` attachment without `force`
 * is refused so the console can tell the operator to delete the server first.
 * `serverIds` is always empty on the non-force success path because attachment
 * was refused. `revokeLicense` + `disconnectServersBoundToLicense` run only
 * when `force` is set (or the seat is already unbound).
 */
export async function invalidateLicense(
  db: Db,
  licenseId: string,
  organizationId: string,
  opts?: { force?: boolean }
): Promise<InvalidateLicenseResult> {
  const rows = await db
    .select({
      licenseId: license.id,
      serverId: license.serverId,
      boundId: server.id,
      boundName: server.name,
    })
    .from(license)
    .leftJoin(server, eq(server.id, license.serverId))
    .where(
      and(
        eq(license.id, licenseId),
        eq(license.organizationId, organizationId),
        isNull(license.revokedAt)
      )
    )
    .limit(1)
  const row = rows[0]
  if (!row) return { ok: false, reason: 'not_found' }

  const boundId = row.boundId ?? row.serverId
  if (boundId && !opts?.force) {
    return {
      ok: false,
      reason: 'attached',
      boundServer: { id: boundId, name: row.boundName ?? null },
    }
  }

  const revoked = await revokeLicense(db, licenseId, organizationId)
  if (!revoked) return { ok: false, reason: 'not_found' }
  if (!opts?.force) return { ok: true, serverIds: [] }
  const serverIds = await disconnectServersBoundToLicense(db, licenseId, organizationId)
  return { ok: true, serverIds }
}

export type LicenseBoundServer = {
  id: string
  name: string | null
}

export async function listServersBoundToLicenses(
  db: Db,
  organizationId: string,
  licenseIds: string[]
): Promise<Map<string, LicenseBoundServer>> {
  const bound = new Map<string, LicenseBoundServer>()
  if (licenseIds.length === 0) return bound

  const rows = await db
    .select({
      licenseId: license.id,
      id: server.id,
      name: server.name,
    })
    .from(license)
    .innerJoin(server, eq(server.id, license.serverId))
    .where(and(eq(license.organizationId, organizationId), inArray(license.id, licenseIds)))

  for (const row of rows) {
    bound.set(row.licenseId, { id: row.id, name: row.name })
  }

  return bound
}

export async function listLicenses(db: Db, organizationId: string): Promise<LicenseRecord[]> {
  return await db
    .select({
      id: license.id,
      organizationId: license.organizationId,
      name: license.name,
      createdAt: license.createdAt,
      tierId: license.tierId,
      tierLabel: tier.label,
      expiresAt: license.expiresAt,
    })
    .from(license)
    .leftJoin(tier, eq(tier.id, license.tierId))
    .where(and(eq(license.organizationId, organizationId), isNull(license.revokedAt)))
}

export async function lookupActiveLicense(
  db: Db,
  licenseId: string
): Promise<{ organizationId: string; token: string | null; serverId: string | null } | null> {
  const rows = await db
    .select({
      organizationId: license.organizationId,
      token: license.token,
      serverId: license.serverId,
      expiresAt: license.expiresAt,
    })
    .from(license)
    .where(and(eq(license.id, licenseId), isNull(license.revokedAt)))
    .limit(1)

  const row = rows[0]
  // An unused key past its expiry cannot enroll; a bound key never expires.
  if (!row || isUnusedKeyExpired(row)) return null
  return { organizationId: row.organizationId, token: row.token, serverId: row.serverId }
}
