import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import { verifyDaemonLicense } from './daemon/authn/license.ts'
import {
  parseServerAddresses,
  serverAddressesEquals,
  type ServerAddresses,
} from './server-addresses.ts'
import {
  parseServerOsMetadata,
  parseServerTimeSync,
  serverOsMetadataEquals,
  serverTimeSyncEquals,
  type ServerMetadata,
  type ServerOsMetadata,
  type ServerTimeSync,
} from './lib/db/server-metadata.ts'
import { license, server } from './lib/db/schema.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ServerHelloIdentity = {
  serverId?: string
  machineId?: string
  hostname?: string
  licenseId?: string
  licenseToken?: string
  os?: ServerOsMetadata
  timeSync?: ServerTimeSync
  addresses?: ServerAddresses
}

function metadataPatch(identity: ServerHelloIdentity): Partial<ServerMetadata> {
  const patch: Partial<ServerMetadata> = {}
  const machineId = identity.machineId?.trim()
  const hostname = identity.hostname?.trim()
  if (machineId) patch.machineId = machineId
  if (hostname) patch.hostname = hostname
  const os = parseServerOsMetadata(identity.os)
  if (os) patch.os = os
  const timeSync = parseServerTimeSync(identity.timeSync)
  if (timeSync) {
    patch.timeSync = {
      ...timeSync,
      capturedAt: timeSync.capturedAt ?? new Date().toISOString(),
    }
  }
  const addresses =
    identity.addresses === undefined
      ? undefined
      : parseServerAddresses(identity.addresses)
  if (addresses !== undefined) patch.addresses = addresses
  return patch
}

/**
 * Pure merge of hostname/machineId/os/timeSync/addresses into `server.metadata`
 * — no DB I/O. Returns null when nothing would change (idempotent skip).
 */
export function mergeServerMetadataIdentity(
  current: ServerMetadata | null | undefined,
  identity: Pick<
    ServerHelloIdentity,
    'hostname' | 'machineId' | 'os' | 'timeSync' | 'addresses'
  >,
): ServerMetadata | null {
  const patch = metadataPatch(identity)
  if (Object.keys(patch).length === 0) return null

  const base = current ?? {}
  const next: ServerMetadata = { ...base }

  let changed = false
  if (patch.machineId !== undefined && patch.machineId !== base.machineId) {
    next.machineId = patch.machineId
    changed = true
  }
  if (patch.hostname !== undefined && patch.hostname !== base.hostname) {
    next.hostname = patch.hostname
    changed = true
  }
  if (patch.os !== undefined && !serverOsMetadataEquals(patch.os, base.os)) {
    next.os = patch.os
    changed = true
  }
  if (patch.timeSync !== undefined) {
    const mergedTimeSync = { ...base.timeSync, ...patch.timeSync }
    if (!serverTimeSyncEquals(mergedTimeSync, base.timeSync)) {
      next.timeSync = mergedTimeSync
      changed = true
    }
  }
  if (
    patch.addresses !== undefined &&
    !serverAddressesEquals(patch.addresses, base.addresses)
  ) {
    next.addresses = patch.addresses
    changed = true
  }

  return changed ? next : null
}

function defaultDisplayName(_identity: ServerHelloIdentity): string | null {
  return null
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

function nowTs(): string {
  return new Date().toISOString()
}

export async function touchServerMetadata(
  db: Db,
  serverId: string,
  identity: ServerHelloIdentity,
): Promise<void> {
  const rows = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const base = rows[0]?.metadata as ServerMetadata | null | undefined
  if (!mergeServerMetadataIdentity(base, identity)) return

  // Patch only changed identity keys via jsonb || so a concurrent connect
  // projection that wrote metadata.geo cannot be wiped by this hello update.
  const patch = metadataPatch(identity)
  const delta: Partial<ServerMetadata> = {}
  if (
    patch.machineId !== undefined &&
    patch.machineId !== base?.machineId
  ) {
    delta.machineId = patch.machineId
  }
  if (patch.hostname !== undefined && patch.hostname !== base?.hostname) {
    delta.hostname = patch.hostname
  }
  if (
    patch.os !== undefined &&
    !serverOsMetadataEquals(patch.os, base?.os)
  ) {
    delta.os = patch.os
  }
  if (patch.timeSync !== undefined) {
    const mergedTimeSync = { ...base?.timeSync, ...patch.timeSync }
    if (!serverTimeSyncEquals(mergedTimeSync, base?.timeSync)) {
      // Persist the deep-merged object so jsonb || replaces the key with the
      // full fact set (partial command outcomes must not clobber NTP fields).
      delta.timeSync = mergedTimeSync
    }
  }
  if (
    patch.addresses !== undefined &&
    !serverAddressesEquals(patch.addresses, base?.addresses)
  ) {
    delta.addresses = patch.addresses
  }
  if (Object.keys(delta).length === 0) return

  await db.update(server).set({
    metadata: sql`COALESCE(${server.metadata}, '{}'::jsonb) || ${
      JSON.stringify(delta)
    }::jsonb`,
    updatedAt: nowTs(),
  }).where(eq(server.id, serverId))
}

async function findExistingServerId(
  db: Db,
  identity: ServerHelloIdentity,
): Promise<string | undefined> {
  const hinted = identity.serverId?.trim()
  if (hinted && UUID_RE.test(hinted)) {
    const existing = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, hinted))
      .limit(1)
    if (existing.length > 0) return existing[0].id
  }

  const machineId = identity.machineId?.trim()
  if (machineId) {
    const byMachine = await db
      .select({ id: server.id })
      .from(server)
      .where(sql`${server.metadata}->>'machineId' = ${machineId}`)
      .limit(1)
    if (byMachine.length > 0) return byMachine[0].id
  }

  const hostname = identity.hostname?.trim()
  if (hostname) {
    const byHostname = await db
      .select({ id: server.id })
      .from(server)
      .where(sql`${server.metadata}->>'hostname' = ${hostname}`)
      .orderBy(server.createdAt)
      .limit(1)
    if (byHostname.length > 0) return byHostname[0].id
  }

  return undefined
}

/**
 * Find the single server already latched to this license (one-shot seats).
 */
async function findServerBoundToLicense(
  db: Db,
  licenseId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ serverId: license.serverId })
    .from(license)
    .where(eq(license.id, licenseId))
    .limit(1)
  return row?.serverId ?? undefined
}

/**
 * Resolve an existing server row to reuse for a licensed enrollment.
 *
 * Licenses are one-shot once a server latches onto them:
 *  - Re-enroll is allowed only when the daemon presents its persisted
 *    `serverId` and that row is already bound to *this* license.
 *  - A brand-new host with a already-bound license is rejected (caller gets
 *    null) — mint a new registration key via Add Server instead.
 *  - `machineId` / `hostname` are never used for reuse: cloned VMs share
 *    `/etc/machine-id` (and often hostnames).
 */
async function findReusableLicensedServerId(
  db: Db,
  identity: ServerHelloIdentity,
  licenseId: string,
): Promise<string | undefined> {
  const boundServerId = await findServerBoundToLicense(db, licenseId)
  if (!boundServerId) return undefined

  const hinted = identity.serverId?.trim()
  if (hinted && UUID_RE.test(hinted) && hinted === boundServerId) {
    return boundServerId
  }

  // License already consumed by another (or unknown) server.
  return undefined
}

type ServerLicenseBinding = {
  licenseId: string | null
  organizationId: string | null
}

export async function getServerLicenseBinding(
  db: Db,
  serverId: string,
): Promise<ServerLicenseBinding | null> {
  const [serverRow] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!serverRow) return null

  const [licenseRow] = await db
    .select({ id: license.id })
    .from(license)
    .where(eq(license.serverId, serverId))
    .limit(1)

  return {
    licenseId: licenseRow?.id ?? null,
    organizationId: serverRow.organizationId,
  }
}

/** Accept only the same license that already latched this server (or unbound). */
function credentialAuthorizedForServer(
  binding: ServerLicenseBinding,
  licenseId: string,
): boolean {
  if (!binding.licenseId) return true
  return binding.licenseId === licenseId
}

async function applyLicensedServerBinding(
  db: Db,
  serverId: string,
  identity: ServerHelloIdentity,
  organizationId: string,
): Promise<void> {
  const licenseId = identity.licenseId!.trim()
  const binding = await getServerLicenseBinding(db, serverId)
  if (!binding) return

  const now = nowTs()
  if (!binding.licenseId) {
    await db
      .update(license)
      .set({ serverId, updatedAt: now })
      .where(and(
        eq(license.id, licenseId),
        isNull(license.serverId),
        isNull(license.revokedAt),
      ))
    await db.update(server).set({
      organizationId,
      updatedAt: now,
    }).where(eq(server.id, serverId))
    return
  }

  if (binding.licenseId === licenseId && !binding.organizationId) {
    await db.update(server).set({
      organizationId,
      updatedAt: now,
    }).where(eq(server.id, serverId))
  }
}

/** Touch metadata and latch org/license when the credential matches this row. */
async function authorizeAndBindLicensedServer(
  db: Db,
  serverId: string,
  identity: ServerHelloIdentity,
  licenseId: string,
  organizationId: string,
): Promise<string | null> {
  const binding = await getServerLicenseBinding(db, serverId)
  if (!binding || !credentialAuthorizedForServer(binding, licenseId)) {
    return null
  }
  await touchServerMetadata(db, serverId, identity)
  await applyLicensedServerBinding(db, serverId, identity, organizationId)
  return serverId
}

/**
 * Insert a server then latch the license. If the license was already consumed
 * (concurrent enroll), delete the orphan server and throw unique violation so
 * the caller can take the race-reuse path.
 */
async function insertLicensedServer(
  db: Db,
  identity: ServerHelloIdentity,
  licenseId: string,
  organizationId: string,
): Promise<string> {
  const patch = metadataPatch(identity)
  const now = nowTs()
  const inserted = await db
    .insert(server)
    .values({
      organizationId,
      displayName: defaultDisplayName(identity),
      createdAt: now,
      updatedAt: now,
      metadata: Object.keys(patch).length > 0 ? patch : null,
    })
    .returning({ id: server.id })

  const id = inserted[0]?.id
  if (!id) throw new Error('failed to insert server row')

  const latched = await db
    .update(license)
    .set({ serverId: id, updatedAt: now })
    .where(and(
      eq(license.id, licenseId),
      isNull(license.serverId),
      isNull(license.revokedAt),
    ))
    .returning({ id: license.id })

  if (latched.length === 0) {
    await db.delete(server).where(eq(server.id, id))
    const err = new Error('license already consumed') as Error & { code: string }
    err.code = '23505'
    throw err
  }

  return id
}

async function resolveLicensedServerId(
  db: Db,
  identity: ServerHelloIdentity,
): Promise<string | null> {
  const licenseId = identity.licenseId?.trim()
  const licenseToken = identity.licenseToken?.trim()
  if (!licenseId || !licenseToken) return null

  const verified = await verifyDaemonLicense(db, licenseId, licenseToken)
  if (!verified) return null

  // Already latched: only the bound server may re-enroll (with matching serverId).
  const boundServerId = await findServerBoundToLicense(db, licenseId)
  if (boundServerId) {
    const reusable = await findReusableLicensedServerId(db, identity, licenseId)
    if (!reusable) return null
    return authorizeAndBindLicensedServer(
      db,
      reusable,
      identity,
      licenseId,
      verified.organizationId,
    )
  }

  try {
    return await insertLicensedServer(
      db,
      identity,
      licenseId,
      verified.organizationId,
    )
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // Concurrent first enroll: the winner owns the license; only that server
    // may continue, and only when this caller presents the matching serverId.
    const raced = await findReusableLicensedServerId(db, identity, licenseId)
    if (!raced) return null
    return authorizeAndBindLicensedServer(
      db,
      raced,
      identity,
      licenseId,
      verified.organizationId,
    )
  }
}

/**
 * Resolve the canonical server.id (uuidv7) for a connecting daemon.
 * Reuses by serverId, metadata.machineId, or hostname. Creates a row only when
 * a valid license is presented. Returns null for unknown servers without a
 * license.
 */
export async function resolveServerId(
  db: Db,
  identity: ServerHelloIdentity,
): Promise<string | null> {
  if (identity.licenseId?.trim()) {
    return resolveLicensedServerId(db, identity)
  }

  const existing = await findExistingServerId(db, identity)
  if (existing) {
    await touchServerMetadata(db, existing, identity)
    return existing
  }
  return null
}
