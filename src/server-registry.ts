import { eq, sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import type { ServerMetadata } from './db/server-metadata.ts'
import { lookupActiveLicense, verifyLicenseToken } from './authn/license.ts'
import { getResourceId, registerResource } from './authz/resource-registry.ts'
import { server } from './db/schema.ts'

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

/** Register (or refresh) the authz `resource` row for an org-assigned server. */
export async function ensureServerResource(
  db: Db,
  serverId: string,
  organizationId: string,
): Promise<string> {
  const orgResourceId = await getResourceId(db, 'organization', organizationId)
  if (!orgResourceId) {
    throw new Error(`ORG_RESOURCE_NOT_REGISTERED:${organizationId}`)
  }

  return registerResource(db, {
    kind: 'server',
    itemId: serverId,
    organizationId,
    parentId: orgResourceId,
  })
}

async function touchServerMetadata(
  db: Db,
  serverId: string,
  identity: ServerHelloIdentity,
): Promise<void> {
  const patch = metadataPatch(identity)
  if (Object.keys(patch).length === 0) return
  const rows = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const current = (rows[0]?.metadata ?? {}) as ServerMetadata
  await db.update(server).set({
    metadata: { ...current, ...patch },
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

async function applyLicensedServerBinding(
  db: Db,
  serverId: string,
  identity: ServerHelloIdentity,
  organizationId: string,
): Promise<void> {
  const licenseId = identity.licenseId!.trim()
  const now = nowTs()

  await db.update(server).set({
    licenseId,
    organizationId,
    updatedAt: now,
  }).where(eq(server.id, serverId))
  await ensureServerResource(db, serverId, organizationId)
}

async function resolveLicensedServerId(
  db: Db,
  identity: ServerHelloIdentity,
): Promise<string | null> {
  const licenseId = identity.licenseId?.trim()
  const licenseToken = identity.licenseToken?.trim()
  if (!licenseId || !licenseToken) return null

  const activeLicense = await lookupActiveLicense(db, licenseId)
  if (!activeLicense) return null

  const tokenValid = await verifyLicenseToken(
    licenseToken,
    activeLicense.hashedToken,
  )
  if (!tokenValid) return null

  const existing = await findExistingServerId(db, identity)
  if (existing) {
    await touchServerMetadata(db, existing, identity)
    await applyLicensedServerBinding(
      db,
      existing,
      identity,
      activeLicense.organizationId,
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
        organizationId: activeLicense.organizationId,
        displayName: defaultDisplayName(identity),
        createdAt: now,
        updatedAt: now,
        metadata: Object.keys(patch).length > 0 ? patch : null,
      })
      .returning({ id: server.id })

    const id = inserted[0]?.id
    if (!id) throw new Error('failed to insert server row')
    await ensureServerResource(db, id, activeLicense.organizationId)
    return id
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const raced = await findExistingServerId(db, identity)
    if (!raced) throw err
    await touchServerMetadata(db, raced, identity)
    await applyLicensedServerBinding(
      db,
      raced,
      identity,
      activeLicense.organizationId,
    )
    return raced
  }
}

/**
 * Resolve the canonical server.id (uuidv7) for a connecting daemon.
 * Reuses by serverId, metadata.machineId, or hostname. Creates a row on first
 * sight when no match exists; organization assignment is operator-driven via
 * the developer console.
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

  const patch = metadataPatch(identity)
  const now = nowTs()
  try {
    const inserted = await db
      .insert(server)
      .values({
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
    const raced = await findExistingServerId(db, identity)
    if (!raced) throw err
    await touchServerMetadata(db, raced, identity)
    return raced
  }
}
