import { eq, sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import { servers } from './db/schema.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ServerHelloIdentity = {
  serverId?: string
  machineId?: string
  hostname?: string
}

function metadataPatch(identity: ServerHelloIdentity): Record<string, string> {
  const patch: Record<string, string> = {}
  const machineId = identity.machineId?.trim()
  const hostname = identity.hostname?.trim()
  if (machineId) patch.machineId = machineId
  if (hostname) patch.hostname = hostname
  return patch
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

async function touchServerMetadata(
  db: Db,
  serverId: string,
  identity: ServerHelloIdentity,
): Promise<void> {
  const patch = metadataPatch(identity)
  if (Object.keys(patch).length === 0) return
  const rows = await db
    .select({ metadata: servers.metadata })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1)
  const current = (rows[0]?.metadata ?? {}) as Record<string, string>
  await db.update(servers).set({
    metadata: { ...current, ...patch },
  }).where(eq(servers.id, serverId))
}

async function findExistingServerId(
  db: Db,
  identity: ServerHelloIdentity,
): Promise<string | undefined> {
  const hinted = identity.serverId?.trim()
  if (hinted && UUID_RE.test(hinted)) {
    const existing = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, hinted))
      .limit(1)
    if (existing.length > 0) return existing[0].id
  }

  const machineId = identity.machineId?.trim()
  if (machineId) {
    const byMachine = await db
      .select({ id: servers.id })
      .from(servers)
      .where(sql`${servers.metadata}->>'machineId' = ${machineId}`)
      .limit(1)
    if (byMachine.length > 0) return byMachine[0].id
  }

  const hostname = identity.hostname?.trim()
  if (hostname) {
    const byHostname = await db
      .select({ id: servers.id })
      .from(servers)
      .where(sql`${servers.metadata}->>'hostname' = ${hostname}`)
      .orderBy(servers.createdAt)
      .limit(1)
    if (byHostname.length > 0) return byHostname[0].id
  }

  return undefined
}

/**
 * Resolve the canonical servers.id (uuidv7) for a connecting daemon.
 * Creates a row on first sight; reuses by serverId, metadata.machineId, or hostname.
 */
export async function resolveServerId(
  db: Db,
  identity: ServerHelloIdentity,
): Promise<string> {
  const existing = await findExistingServerId(db, identity)
  if (existing) {
    await touchServerMetadata(db, existing, identity)
    return existing
  }

  const patch = metadataPatch(identity)
  try {
    const inserted = await db
      .insert(servers)
      .values({
        metadata: Object.keys(patch).length > 0 ? patch : null,
      })
      .returning({ id: servers.id })

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
