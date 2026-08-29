import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import {
  encryptSecret,
  generateSealedSecret,
} from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import type { Db } from '../../db.ts'
import {
  replica,
  organization,
  principal,
  project,
  server,
  entitlement,
  tenancy,
  workspace,
} from '../../lib/db/schema.ts'

export const PRINCIPAL_KINDS = new Set(['system', 'database'])
export const PRINCIPAL_PROVIDERS = new Set([
  'server',
  'postgres',
  'mysql',
  'redis',
  'clickhouse',
])
export const SERVER_PRINCIPAL_PROVIDER = 'server'
export const USERNAME_IN_USE_ERROR = 'username_in_use'
export const USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * True when another server-provider principal in the organization already uses
 * this username (trimmed, case-insensitive). Managed-engine rows
 * (`managed_id` set, `project_id` null) are excluded by the project join.
 */
export async function isServerPrincipalUsernameTaken(
  db: Db,
  organizationId: string,
  username: string,
  excludePrincipalId?: string,
): Promise<boolean> {
  const key = username.trim().toLowerCase()
  if (!key) return false

  const conditions = [
    eq(workspace.organizationId, organizationId),
    eq(principal.provider, SERVER_PRINCIPAL_PROVIDER),
    sql`lower(btrim(${principal.username})) = ${key}`,
  ]
  if (excludePrincipalId) {
    conditions.push(ne(principal.id, excludePrincipalId))
  }

  const rows = await db
    .select({ id: principal.id })
    .from(principal)
    .innerJoin(project, eq(principal.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .where(and(...conditions))
    .limit(1)

  return rows.length > 0
}

export async function replaceTenancies(
  tx: Db,
  principalId: string,
  nextServiceIds: string[],
): Promise<void> {
  const existing = await tx
    .select({ serviceId: tenancy.serviceId })
    .from(tenancy)
    .where(eq(tenancy.principalId, principalId))

  const current = new Set(existing.map((row) => row.serviceId))
  const next = new Set(nextServiceIds)

  const toDelete = [...current].filter((id) => !next.has(id))
  const toInsert = [...next].filter((id) => !current.has(id))

  if (toDelete.length > 0) {
    await tx
      .delete(tenancy)
      .where(
        and(
          eq(tenancy.principalId, principalId),
          inArray(tenancy.serviceId, toDelete),
        ),
      )
  }

  if (toInsert.length > 0) {
    await tx.insert(tenancy).values(
      toInsert.map((serviceId) => ({
        principalId,
        serviceId,
      })),
    )
  }
}

/** One runtime series a principal may execute, with its provenance. */
export type PrincipalEntitlementRow = {
  runtime: string
  series: string
  grantedBy: 'operator' | 'deploy'
}

export async function loadEntitlementsByPrincipalIds(
  tx: Db,
  principalIds: readonly string[],
): Promise<Map<string, PrincipalEntitlementRow[]>> {
  const byPrincipal = new Map<string, PrincipalEntitlementRow[]>()
  if (principalIds.length === 0) return byPrincipal
  const rows = await tx
    .select({
      principalId: entitlement.principalId,
      runtime: entitlement.runtime,
      series: entitlement.series,
      grantedBy: entitlement.grantedBy,
    })
    .from(entitlement)
    .where(inArray(entitlement.principalId, [...principalIds]))

  for (const row of rows) {
    const list = byPrincipal.get(row.principalId) ?? []
    list.push({
      runtime: row.runtime,
      series: row.series,
      grantedBy: row.grantedBy as 'operator' | 'deploy',
    })
    byPrincipal.set(row.principalId, list)
  }
  return byPrincipal
}

/**
 * Reconcile a principal's entitlements to exactly `next`.
 *
 * Deletes are the point: a grant that can only ever be added is not a grant,
 * it is a ratchet. The daemon mirrors this on the host by dropping unix group
 * membership for any registry group no longer present.
 */
export async function replaceEntitlements(
  tx: Db,
  principalId: string,
  next: readonly PrincipalEntitlementRow[],
): Promise<void> {
  const key = (e: { runtime: string; series: string }) =>
    `${e.runtime}@${e.series}`
  const existing = await tx
    .select({
      runtime: entitlement.runtime,
      series: entitlement.series,
    })
    .from(entitlement)
    .where(eq(entitlement.principalId, principalId))

  const current = new Set(existing.map(key))
  const desired = new Map(next.map((entry) => [key(entry), entry]))

  const toDelete = [...current].filter((k) => !desired.has(k))
  if (toDelete.length > 0) {
    await tx.delete(entitlement).where(
      and(
        eq(entitlement.principalId, principalId),
        inArray(
          sql`${entitlement.runtime} || '@' || ${entitlement.series}`,
          toDelete,
        ),
      ),
    )
  }

  const toInsert = [...desired.entries()]
    .filter(([k]) => !current.has(k))
    .map(([, entry]) => ({
      principalId,
      runtime: entry.runtime,
      series: entry.series,
      grantedBy: entry.grantedBy,
    }))
  if (toInsert.length > 0) {
    await tx.insert(entitlement).values(toInsert)
  }
}

export type CreatePrincipalFields = {
  kind: string
  provider: string
  username: string
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
}

/**
 * Insert a principal row and its initial tenancy edges in one transaction.
 * Callers are responsible for authz and field validation.
 */
export async function createPrincipal(
  db: Db,
  fields: CreatePrincipalFields,
  serviceIds: string[],
): Promise<string> {
  return await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(principal)
      .values({
        kind: fields.kind,
        provider: fields.provider,
        username: fields.username,
        ...(fields.metadata != null ? { metadata: fields.metadata } : {}),
        ...(fields.options != null ? { options: fields.options } : {}),
      })
      .returning({ id: principal.id })

    if (serviceIds.length > 0) {
      await tx.insert(tenancy).values(
        serviceIds.map((serviceId) => ({
          principalId: inserted.id,
          serviceId,
        })),
      )
    }

    return inserted.id
  })
}

export type SetPrincipalPasswordInput =
  | { readonly generate: true }
  | { readonly password: string }

async function persistPrincipalPassword(
  db: Db,
  principalId: string,
  sealed: string,
): Promise<void> {
  const updated = await db
    .update(principal)
    .set({
      password: sealed,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(principal.id, principalId))
    .returning({ id: principal.id })

  if (updated.length !== 1) {
    throw new Error('Principal not found')
  }
}

/**
 * Seal and persist a principal password. With `{ generate: true }`, returns
 * the plaintext once for show-once UX; with `{ password }`, stores only the
 * sealed envelope.
 *
 * Throws when no principal row matches `principalId`.
 */
export async function setPrincipalPassword(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  principalId: string,
  input: SetPrincipalPasswordInput,
): Promise<{ plaintext?: string }> {
  if ('generate' in input && input.generate) {
    const { plaintext, sealed } = await generateSealedSecret(dataEncryptionSecrets)
    await persistPrincipalPassword(db, principalId, sealed)
    return { plaintext }
  }

  if (!('password' in input)) {
    throw new TypeError('password or generate:true is required')
  }

  const sealed = await encryptSecret(dataEncryptionSecrets, input.password)
  await persistPrincipalPassword(db, principalId, sealed)

  return {}
}

export type CreateManagedPrincipalInput = {
  managedId: string
  provider: string
  username: string
  kind?: string
  metadata?: Record<string, unknown> | null
  /**
   * Override the generated password length. Replication principals use
   * {@link REPLICATION_PASSWORD_LENGTH} — MySQL caps `SOURCE_PASSWORD` in
   * `CHANGE REPLICATION SOURCE` at 32 chars (error 3056).
   */
  passwordLength?: number
}

/** MySQL rejects replication passwords longer than 32 chars (error 3056). */
export const REPLICATION_PASSWORD_LENGTH = 32

/**
 * Insert a managed-engine principal with a freshly generated sealed password
 * in a single statement. Returns the show-once plaintext; no subsequent code
 * path returns a stored password.
 */
export async function createManagedPrincipal(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  input: CreateManagedPrincipalInput,
): Promise<{ principalId: string; password: string }> {
  if (!USERNAME_RE.test(input.username)) {
    throw new TypeError('invalid username')
  }
  if (!PRINCIPAL_PROVIDERS.has(input.provider)) {
    throw new TypeError('invalid provider')
  }

  const { plaintext, sealed } = await generateSealedSecret(
    dataEncryptionSecrets,
    input.passwordLength !== undefined ? { length: input.passwordLength } : undefined,
  )
  const [inserted] = await db
    .insert(principal)
    .values({
      kind: input.kind ?? 'database',
      provider: input.provider,
      username: input.username,
      managedId: input.managedId,
      password: sealed,
      ...(input.metadata != null ? { metadata: input.metadata } : {}),
    })
    .returning({ id: principal.id })

  return { principalId: inserted.id, password: plaintext }
}

/**
 * Rotate a principal password (generate + seal). Returns show-once plaintext.
 * Propagates `Principal not found` from {@link setPrincipalPassword}.
 */
export async function rotatePrincipalPassword(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  principalId: string,
): Promise<{ plaintext: string }> {
  const result = await setPrincipalPassword(
    db,
    dataEncryptionSecrets,
    principalId,
    { generate: true },
  )
  if (result.plaintext === undefined) {
    throw new TypeError('expected generated plaintext')
  }
  return { plaintext: result.plaintext }
}

/** Managed principals for listing — never selects `password`. */
export type ManagedPrincipalListRow = {
  id: string
  kind: string
  provider: string
  username: string
  managedId: string | null
  metadata: unknown
  options: unknown
  createdAt: string
  updatedAt: string
}

export async function listManagedPrincipals(
  db: Db,
  managedId: string,
): Promise<ManagedPrincipalListRow[]> {
  return await db
    .select({
      id: principal.id,
      kind: principal.kind,
      provider: principal.provider,
      username: principal.username,
      managedId: principal.managedId,
      metadata: principal.metadata,
      options: principal.options,
      createdAt: principal.createdAt,
      updatedAt: principal.updatedAt,
    })
    .from(principal)
    .where(eq(principal.managedId, managedId))
    .orderBy(asc(principal.username))
}

/**
 * Distinct non-null `server.organization_id` across the cluster's
 * `replica` servers (server owner — not the creating org, because a
 * server may host another org's cluster via grants).
 */
export async function resolveManagedOwningOrganizationIds(
  db: Db,
  managedId: string,
  /** Prospective member server still being added (not yet in `replica`). */
  extraServerIds: readonly string[] = [],
): Promise<string[]> {
  const memberOrgs = await db
    .selectDistinct({ organizationId: server.organizationId })
    .from(replica)
    .innerJoin(server, eq(replica.serverId, server.id))
    .where(
      and(
        eq(replica.managedId, managedId),
        isNotNull(server.organizationId),
      ),
    )

  const ids = new Set<string>()
  for (const row of memberOrgs) {
    if (row.organizationId) ids.add(row.organizationId)
  }

  if (extraServerIds.length > 0) {
    const extra = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(inArray(server.id, [...extraServerIds]))
    for (const row of extra) {
      if (row.organizationId) ids.add(row.organizationId)
    }
  }

  return [...ids].sort((a, b) => a.localeCompare(b))
}

/**
 * True when a managed-engine principal (`managed_id IS NOT NULL`) already uses
 * this username on any cluster whose member servers belong to one of the
 * given owning-organization ids (trimmed, case-insensitive).
 * Mirrors {@link isServerPrincipalUsernameTaken} for the managed login
 * namespace.
 */
export async function isManagedUsernameTaken(
  db: Db,
  owningOrganizationIds: readonly string[],
  username: string,
  excludePrincipalId?: string,
): Promise<boolean> {
  const key = username.trim().toLowerCase()
  if (!key || owningOrganizationIds.length === 0) return false

  const conditions = [
    isNotNull(principal.managedId),
    inArray(server.organizationId, [...owningOrganizationIds]),
    sql`lower(btrim(${principal.username})) = ${key}`,
  ]
  if (excludePrincipalId) {
    conditions.push(ne(principal.id, excludePrincipalId))
  }

  const rows = await db
    .select({ id: principal.id })
    .from(principal)
    .innerJoin(replica, eq(principal.managedId, replica.managedId))
    .innerJoin(server, eq(replica.serverId, server.id))
    .where(and(...conditions))
    .limit(1)

  return rows.length > 0
}

/**
 * Prefer `preferred` when free across the owning-org managed login namespace;
 * otherwise return a deterministic short suffix from `managedId`
 * (`preferred_<8 hex>`), validated against {@link USERNAME_RE} and the engine
 * identifier pattern/maxLength. Cluster create must never 409 on a
 * system-generated root name.
 */
export async function resolveAvailableManagedRootUsername(
  db: Db,
  owningOrganizationIds: readonly string[],
  preferred: string,
  managedId: string,
  identifier: { pattern: RegExp; maxLength: number },
): Promise<string> {
  if (
    USERNAME_RE.test(preferred) &&
    identifier.pattern.test(preferred) &&
    preferred.length <= identifier.maxLength &&
    !(await isManagedUsernameTaken(db, owningOrganizationIds, preferred))
  ) {
    return preferred
  }

  const hex = managedId.replaceAll('-', '').slice(0, 8).toLowerCase()
  const candidate = `${preferred}_${hex}`
  if (
    !USERNAME_RE.test(candidate) ||
    !identifier.pattern.test(candidate) ||
    candidate.length > identifier.maxLength
  ) {
    throw new TypeError(
      `unable to derive available managed root username from preferred=${preferred}`,
    )
  }
  if (await isManagedUsernameTaken(db, owningOrganizationIds, candidate)) {
    // Extremely unlikely collision on uuid-derived suffix — append short tail.
    const tail = managedId.replaceAll('-', '').slice(8, 12).toLowerCase()
    const fallback = `${preferred}_${hex}${tail}`
    if (
      !USERNAME_RE.test(fallback) ||
      !identifier.pattern.test(fallback) ||
      fallback.length > identifier.maxLength
    ) {
      throw new TypeError('unable to derive unique managed root username')
    }
    return fallback
  }
  return candidate
}

/**
 * Ensure a cluster replication principal exists (`metadata.managedReplication`).
 * Not a client login — excluded from ProxySQL frontend users and managed-users
 * list routes. Username resolves under the same org-wide FOR UPDATE probe as
 * root, persisted on `managed.metadata.replicationUsername`.
 */
export async function ensureManagedReplicationPrincipal(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: {
    managedId: string
    preferredUsername?: string
    provider: string
    identifier: { pattern: RegExp; maxLength: number }
  },
): Promise<{ principalId: string; username: string; created: boolean }> {
  const rows = await listManagedPrincipals(db, params.managedId)
  for (const row of rows) {
    if (
      isRecord(row.metadata) &&
      row.metadata.managedReplication === true
    ) {
      return {
        principalId: row.id,
        username: row.username,
        created: false,
      }
    }
  }

  const preferred = params.preferredUsername ?? 'tp_repl'
  const owningOrgIds = await resolveManagedOwningOrganizationIds(
    db,
    params.managedId,
  )
  await lockOrganizationsForUpdate(db, owningOrgIds)
  const username = await resolveAvailableManagedRootUsername(
    db,
    owningOrgIds,
    preferred,
    params.managedId,
    params.identifier,
  )
  const created = await createManagedPrincipal(db, dataEncryptionSecrets, {
    managedId: params.managedId,
    provider: params.provider,
    username,
    passwordLength: REPLICATION_PASSWORD_LENGTH,
    metadata: { managedReplication: true },
  })
  return {
    principalId: created.principalId,
    username,
    created: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Lock owning organization rows FOR UPDATE (ordered by id for deadlock safety)
 * before a managed username uniqueness probe. Same pattern as
 * `insertProjectPrincipal`.
 */
export async function lockOrganizationsForUpdate(
  db: Db,
  organizationIds: readonly string[],
): Promise<void> {
  if (organizationIds.length === 0) return
  const ordered = [...organizationIds].sort((a, b) => a.localeCompare(b))
  for (const organizationId of ordered) {
    await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .for('update')
      .limit(1)
  }
}
