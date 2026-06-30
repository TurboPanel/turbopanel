import { eq, sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import { verifyDaemonLicense } from './daemon/authn/license.ts'
import type { ServerMetadata } from './lib/db/server-metadata.ts'
import { server } from './lib/db/schema.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ServerHelloIdentity = {
  serverId?: string
  machineId?: string
  hostname?: string
  licenseId?: string
  licenseToken?: string
}

function metadataPatch(identity: ServerHelloIdentity): Partial<ServerMetadata> {
  const patch: Partial<ServerMetadata> = {}
  const machineId = identity.machineId?.trim()
  const hostname = identity.hostname?.trim()
  if (machineId) patch.machineId = machineId
  if (hostname) patch.hostname = hostname
  return patch
}

/** Pure merge of hostname/machineId into `server.metadata` — no DB I/O. */
export function mergeServerMetadataIdentity(
  current: ServerMetadata | null | undefined,
  identity: Pick<ServerHelloIdentity, 'hostname' | 'machineId'>,
): ServerMetadata | null {
  const patch = metadataPatch(identity)
  if (Object.keys(patch).length === 0) return null
  return { ...(current ?? {}), ...patch }
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
  const merged = mergeServerMetadataIdentity(
    rows[0]?.metadata as ServerMetadata | null | undefined,
    identity,
  )
  if (!merged) return
  await db.update(server).set({
    metadata: merged,
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
 * Resolve an existing server row to reuse for a licensed enrollment.
 *
 * Reuse is keyed on hardware-independent identity only:
 *  1. an explicit persisted `serverId` (the daemon's own canonical id), or
 *  2. a server already bound to *this exact license* (idempotent re-enroll).
 *
 * `machineId` / `hostname` are intentionally NOT used here: cloned VMs share
 * `/etc/machine-id` (and often hostnames), so matching on them lets a brand-new
 * server silently hijack/overwrite an existing server row. A new license must
 * always create a new server.
 */
async function findReusableLicensedServerId(
  db: Db,
  identity: ServerHelloIdentity,
  licenseId: string,
): Promise<string | undefined> {
  const hinted = identity.serverId?.trim()
  if (hinted && UUID_RE.test(hinted)) {
    const byId = await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, hinted))
      .limit(1)
    if (byId.length > 0) return byId[0].id
  }

  const byLicense = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.licenseId, licenseId))
    .limit(1)
  if (byLicense.length > 0) return byLicense[0].id

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
  const [row] = await db
    .select({
      licenseId: server.licenseId,
      organizationId: server.organizationId,
    })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row ?? null
}

function credentialAuthorizedForServer(
  binding: ServerLicenseBinding,
  licenseId: string,
  organizationId: string,
): boolean {
  if (!binding.licenseId) return true
  if (binding.licenseId === licenseId) return true
  // Recovery: any verified license credential from the server's organization.
  if (binding.organizationId && binding.organizationId === organizationId) {
    return true
  }
  return false
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
    await db.update(server).set({
      licenseId,
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

async function resolveLicensedServerId(
  db: Db,
  identity: ServerHelloIdentity,
): Promise<string | null> {
  const licenseId = identity.licenseId?.trim()
  const licenseToken = identity.licenseToken?.trim()
  if (!licenseId || !licenseToken) return null

  const verified = await verifyDaemonLicense(db, licenseId, licenseToken)
  if (!verified) return null

  const existing = await findReusableLicensedServerId(db, identity, licenseId)
  if (existing) {
    const binding = await getServerLicenseBinding(db, existing)
    if (
      !binding ||
      !credentialAuthorizedForServer(binding, licenseId, verified.organizationId)
    ) {
      return null
    }
    await touchServerMetadata(db, existing, identity)
    await applyLicensedServerBinding(
      db,
      existing,
      identity,
      verified.organizationId,
    )
    return existing
  }

  const patch = metadataPatch(identity)
  const now = nowTs()
  try {
    const inserted = await db
      .insert(server)
      .values({
        licenseId,
        organizationId: verified.organizationId,
        displayName: defaultDisplayName(identity),
        createdAt: now,
        updatedAt: now,
        metadata: Object.keys(patch).length > 0 ? patch : null,
      })
      .returning({ id: server.id })

    const id = inserted[0]?.id
    if (!id) throw new Error('failed to insert server row')
    return id
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const raced = await findReusableLicensedServerId(db, identity, licenseId)
    if (!raced) throw err
    const racedBinding = await getServerLicenseBinding(db, raced)
    if (
      !racedBinding ||
      !credentialAuthorizedForServer(
        racedBinding,
        licenseId,
        verified.organizationId,
      )
    ) {
      return null
    }
    await touchServerMetadata(db, raced, identity)
    await applyLicensedServerBinding(
      db,
      raced,
      identity,
      verified.organizationId,
    )
    return raced
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
