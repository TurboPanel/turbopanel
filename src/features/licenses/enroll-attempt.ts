/**
 * The enrol-attempt record — a registration key whose daemon has started
 * enrolling but whose server is not bound yet.
 *
 * `license.server_id` is latched only by a **successful** enrol, and a
 * refused one (a hosted tier gate, a transient failure) deliberately leaves
 * the key untouched so the refusal cannot consume it. Without this record a
 * key whose server is being provisioned is indistinguishable from one
 * nobody has used: the console would offer it for deletion and count its
 * license as free. So an **authenticated** attempt — the key's token and
 * the daemon's signature both verified — writes one `setting` row per key
 * (`LICENSE_ENROLL_ATTEMPT:<licenseId>`), before the tier gate runs. The
 * same storage shape as the pending-checkout record: no migration.
 *
 * Only unbound, unrevoked keys are ever counted as provisioning (the reads
 * join on `license`), so a stale row left by a later bind or revoke changes
 * nothing; the successful enrol and the revoke clear it anyway.
 *
 * Workers-bundleable: nothing at module load.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { license, setting } from '../../db/schema.ts'

export const LICENSE_ENROLL_ATTEMPT_KEY_PREFIX = 'LICENSE_ENROLL_ATTEMPT:'
export const LICENSE_ENROLL_ATTEMPT_RECORD_VERSION = 1

export type LicenseEnrollAttemptRecord = Readonly<{
  version: typeof LICENSE_ENROLL_ATTEMPT_RECORD_VERSION
  /** When the daemon last tried to enrol with this key (ISO). */
  at: string
  /** The hostname the daemon reported, when it sent one. */
  hostname: string | null
}>

export function licenseEnrollAttemptKey(licenseId: string): string {
  return `${LICENSE_ENROLL_ATTEMPT_KEY_PREFIX}${licenseId}`
}

/** `null` for anything that is not a version-1 record. */
export function parseLicenseEnrollAttempt(value: unknown): LicenseEnrollAttemptRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.version !== LICENSE_ENROLL_ATTEMPT_RECORD_VERSION) return null
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) {
    return null
  }
  const hostname =
    typeof record.hostname === 'string' && record.hostname.trim() ? record.hostname.trim() : null
  return { version: LICENSE_ENROLL_ATTEMPT_RECORD_VERSION, at: record.at, hostname }
}

/** Upsert the record — an authenticated daemon just tried to enrol with this key. */
export async function recordLicenseEnrollAttempt(
  db: Db,
  licenseId: string,
  hostname: string | null | undefined,
  nowMs = Date.now()
): Promise<void> {
  const key = licenseEnrollAttemptKey(licenseId)
  const now = new Date(nowMs).toISOString()
  const value: LicenseEnrollAttemptRecord = {
    version: LICENSE_ENROLL_ATTEMPT_RECORD_VERSION,
    at: now,
    hostname: typeof hostname === 'string' && hostname.trim() ? hostname.trim() : null,
  }
  await db
    .insert(setting)
    .values({ key, value, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } })
}

/** Drop the record: the key bound its server, or it was revoked. */
export async function clearLicenseEnrollAttempt(db: Db, licenseId: string): Promise<void> {
  await db.delete(setting).where(eq(setting.key, licenseEnrollAttemptKey(licenseId)))
}

/**
 * The provisioning keys of one organization — active, unbound, with an
 * enrol attempt on record — by license id. Two plain reads (the unbound keys,
 * then their records by key) rather than a string-built join.
 */
export async function listProvisioningLicenses(
  db: Db,
  organizationId: string
): Promise<Map<string, LicenseEnrollAttemptRecord>> {
  const unbound = await db
    .select({ id: license.id })
    .from(license)
    .where(
      and(
        eq(license.organizationId, organizationId),
        isNull(license.revokedAt),
        isNull(license.serverId)
      )
    )
  const out = new Map<string, LicenseEnrollAttemptRecord>()
  if (unbound.length === 0) return out
  const idByKey = new Map(unbound.map((row) => [licenseEnrollAttemptKey(row.id), row.id]))
  const records = await db
    .select({ key: setting.key, value: setting.value })
    .from(setting)
    .where(inArray(setting.key, [...idByKey.keys()]))
  for (const row of records) {
    const licenseId = idByKey.get(row.key)
    const record = parseLicenseEnrollAttempt(row.value)
    if (licenseId && record) out.set(licenseId, record)
  }
  return out
}
