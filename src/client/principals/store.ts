import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import {
  isReservedPrincipalUsername,
  MAX_PRINCIPAL_USERNAME_LENGTH,
  MAX_SUFFIXED_PRINCIPAL_USERNAME_LENGTH,
  principalHomeDir,
  randomPrincipalUsernameSuffix,
} from '../../lib/naming.ts'
import {
  shellForAccessLevel,
  type PrincipalAccessLevel,
} from '../../lib/principal-access.ts'
import { loadRandomizedUsernamesDefault } from '../managed/org-defaults.ts'
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
 * this username (trimmed, case-insensitive) — as either its short `username`
 * or its `applied_username` (the name that lands on the host). Managed-engine
 * rows (`managed_id` set, `project_id` null) are excluded by the project join.
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
    sql`(lower(btrim(${principal.username})) = ${key} OR lower(btrim(${principal.appliedUsername})) = ${key})`,
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
  /** Applied login (short name + optional random suffix); defaults to `username`. */
  appliedUsername?: string
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
        appliedUsername: fields.appliedUsername ?? fields.username,
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

/**
 * `principal.metadata` key that records which compose alias a row was
 * materialized for.
 *
 * The idempotency key for compose reconciliation is `(project_id, alias)`, and
 * it lives in metadata rather than a column because the alias is a *document*
 * fact, not an account fact: renaming a compose alias should mint a new
 * account, not rename an existing tenant's Unix login out from under their
 * SFTP client. A row whose alias key is absent was created by hand in the UI
 * and is never adopted by a reconcile.
 */
export const COMPOSE_ALIAS_METADATA_KEY = 'composeAlias'

/** How a compose `access:` level maps onto the stored shell encoding. */
const ACCESS_LEVEL_FOR_COMPOSE: Readonly<
  Record<'none' | 'sftp' | 'ssh', PrincipalAccessLevel>
> = { none: 'none', sftp: 'sftp', ssh: 'shell' }

/**
 * The short username an alias becomes.
 *
 * An alias is a document-local identifier with a laxer charset than a Linux
 * login (it may be 64 characters and mixed case), so it is folded rather than
 * assumed usable: lowercased, non-POSIX characters dropped, and truncated to
 * whatever still leaves room for the randomized `_<11>` applied suffix. A
 * reserved name (`root`, anything `tp`-prefixed) is prefixed rather than
 * refused — the operator named a principal in *their* document and the host's
 * namespace is not theirs to know about.
 */
export function composeAliasShortUsername(alias: string): string {
  const folded = alias.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const seeded = /^[a-z_]/.test(folded) ? folded : `u${folded}`
  const capped = seeded.slice(0, MAX_SUFFIXED_PRINCIPAL_USERNAME_LENGTH)
  const safe = capped.length > 0 ? capped : 'user'
  return isReservedPrincipalUsername(safe)
    ? `u${safe}`.slice(0, MAX_SUFFIXED_PRINCIPAL_USERNAME_LENGTH)
    : safe
}

export type EnsureComposePrincipalInput = {
  organizationId: string
  projectId: string
  /** Alias as declared in the document's root `x-turbopanel.principals`. */
  alias: string
  /** Requested access level from the alias entry. Seeds the shell on create. */
  access?: 'none' | 'sftp' | 'ssh'
}

/**
 * The `principal` row a compose alias names, creating it when it does not
 * exist yet.
 *
 * **Idempotent by `(project_id, alias)`**, which is what lets deploy-prepare
 * run this on every deploy: the second call finds the row the first minted
 * instead of piling up an account per deploy.
 *
 * **Create-only for `options`.** The requested `access` seeds the shell when
 * the row is minted and is never re-applied: `principal.options` is the single
 * source of truth for what the host does, an operator may legitimately raise or
 * suspend access from the UI afterwards, and a reconcile that re-asserted the
 * document would silently undo that. Compose declares that an account *exists*;
 * the panel decides what it can do.
 */
export async function ensureComposePrincipal(
  db: Db,
  input: EnsureComposePrincipalInput,
): Promise<{ principalId: string; created: boolean }> {
  const existing = await findComposePrincipal(db, input.projectId, input.alias)
  if (existing) return { principalId: existing, created: false }

  return await db.transaction(async (tx) => {
    // Same org-wide serialization the interactive create path takes: two
    // deploys racing on one alias would otherwise both miss the probe below.
    await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, input.organizationId))
      .for('update')
      .limit(1)

    const raced = await findComposePrincipal(tx, input.projectId, input.alias)
    if (raced) return { principalId: raced, created: false }

    const username = composeAliasShortUsername(input.alias)
    const appliedUsername = await resolveComposeAppliedUsername(
      tx,
      input.organizationId,
      username,
    )

    const [row] = await tx
      .insert(principal)
      .values({
        kind: 'system',
        provider: SERVER_PRINCIPAL_PROVIDER,
        username,
        appliedUsername,
        projectId: input.projectId,
        metadata: {
          home: principalHomeDir(appliedUsername),
          [COMPOSE_ALIAS_METADATA_KEY]: input.alias,
        },
        options: {
          shell: shellForAccessLevel(
            ACCESS_LEVEL_FOR_COMPOSE[input.access ?? 'none'],
          ),
        },
      })
      .returning({ id: principal.id })

    return { principalId: row.id, created: true }
  })
}

/** The row this project already materialized for `alias`, if any. */
async function findComposePrincipal(
  db: Db,
  projectId: string,
  alias: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        eq(principal.projectId, projectId),
        eq(principal.provider, SERVER_PRINCIPAL_PROVIDER),
        sql`${principal.metadata} ->> ${COMPOSE_ALIAS_METADATA_KEY} = ${alias}`,
      ),
    )
    .limit(1)
  return row?.id
}

/**
 * A host login for `username` that no other principal in the org holds.
 *
 * Unlike the interactive create path this never fails on a collision: the
 * operator is not standing there to pick another name, and refusing the deploy
 * over a name they never typed would be the worst of both. The randomized
 * `_<11>` suffix is applied whenever the short name is taken (and always when
 * the org asks for randomized usernames), which is the same shape
 * `resolveManagedAppliedUsername` uses for engine logins.
 */
async function resolveComposeAppliedUsername(
  tx: Db,
  organizationId: string,
  username: string,
): Promise<string> {
  const randomize = await loadRandomizedUsernamesDefault(tx, organizationId)
  if (
    !randomize &&
    !(await isServerPrincipalUsernameTaken(tx, organizationId, username))
  ) {
    return username
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = `${username}${randomPrincipalUsernameSuffix()}`
      .slice(0, MAX_PRINCIPAL_USERNAME_LENGTH)
    if (!(await isServerPrincipalUsernameTaken(tx, organizationId, candidate))) {
      return candidate
    }
  }
  // 36^11 odds three times over. Returning the last candidate unprobed beats
  // throwing on a live namespace mid-deploy.
  return `${username}${randomPrincipalUsernameSuffix()}`
    .slice(0, MAX_PRINCIPAL_USERNAME_LENGTH)
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

/**
 * Enable password sign-in for a **server** principal by storing its
 * sha512-crypt hash in the `password` column.
 *
 * The same column managed-engine principals use for their sealed envelope, but
 * a different format on purpose: a server principal's password is verified by
 * the host's libcrypt, so what the panel needs is the hash the daemon will
 * write to `/etc/shadow` — the plaintext is shown once at set time and never
 * stored. The two formats cannot collide (`$6$…` vs. a sealed envelope) and
 * the two principal kinds never share a code path that reads the column.
 */
export async function setServerPrincipalPasswordHash(
  db: Db,
  principalId: string,
  passwordHash: string,
): Promise<void> {
  await persistPrincipalPassword(db, principalId, passwordHash)
}

/**
 * Disable password sign-in: drop the hash. The daemon locks the account's
 * shadow entry on the next reconcile because the material then carries no
 * `passwordHash` — there is deliberately no "kept but disabled" state, unlike
 * SSH keys, because a password is re-typed while a key would have to be
 * re-collected from every device.
 */
export async function clearServerPrincipalPassword(
  db: Db,
  principalId: string,
): Promise<void> {
  const updated = await db
    .update(principal)
    .set({ password: null, updatedAt: new Date().toISOString() })
    .where(eq(principal.id, principalId))
    .returning({ id: principal.id })
  if (updated.length !== 1) {
    throw new Error('Principal not found')
  }
}

/**
 * Which of these principals have password sign-in enabled — presence only,
 * mirroring `countSshKeysByPrincipalIds`. The hash itself never reaches a
 * serializer.
 */
export async function passwordEnabledByPrincipalIds(
  db: Db,
  principalIds: readonly string[],
): Promise<Set<string>> {
  const enabled = new Set<string>()
  if (principalIds.length === 0) return enabled
  const rows = await db
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        inArray(principal.id, [...principalIds]),
        isNotNull(principal.password),
      ),
    )
  for (const row of rows) enabled.add(row.id)
  return enabled
}

export type CreateManagedPrincipalInput = {
  managedId: string
  provider: string
  username: string
  /** Applied engine login (short name + optional random suffix); defaults to `username`. */
  appliedUsername?: string
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
  const appliedUsername = input.appliedUsername ?? input.username
  if (!USERNAME_RE.test(appliedUsername)) {
    throw new TypeError('invalid applied username')
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
      appliedUsername,
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
  appliedUsername: string
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
      appliedUsername: principal.appliedUsername,
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
 * this username — short or applied — on any cluster whose member servers
 * belong to one of the given owning-organization ids (trimmed,
 * case-insensitive). Mirrors {@link isServerPrincipalUsernameTaken} for the
 * managed login namespace.
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
    sql`(lower(btrim(${principal.username})) = ${key} OR lower(btrim(${principal.appliedUsername})) = ${key})`,
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
 * Resolve the **applied** engine login for a managed principal whose short
 * name is `shortUsername`. With `suffix: true` (the org randomized-usernames
 * default, and always the root path) the result is
 * `<short>_<11 random chars>` — the bare short name is never returned, so
 * reserved engine admin names (`postgres` / `root`) never become logins.
 * With `suffix: false` the bare short name wins when free across the
 * owning-org managed login namespace; on collision it falls back to a random
 * suffix so cluster create never 409s on a system-generated name.
 *
 * Validated against {@link USERNAME_RE} and the engine identifier
 * pattern/maxLength (a suffixed name must fit maxLength whole). A random
 * candidate that somehow collides (36^11 odds) is replaced by a fresh one
 * returned unprobed — this path must never throw on a live namespace.
 */
export async function resolveManagedAppliedUsername(
  db: Db,
  owningOrganizationIds: readonly string[],
  shortUsername: string,
  identifier: { pattern: RegExp; maxLength: number },
  opts: { suffix: boolean },
): Promise<string> {
  if (
    !USERNAME_RE.test(shortUsername) ||
    !identifier.pattern.test(shortUsername) ||
    shortUsername.length > identifier.maxLength
  ) {
    throw new TypeError(
      `invalid managed short username: ${shortUsername}`,
    )
  }

  if (
    !opts.suffix &&
    !(await isManagedUsernameTaken(db, owningOrganizationIds, shortUsername))
  ) {
    return shortUsername
  }

  const suffixed = (): string => {
    const candidate = `${shortUsername}${randomPrincipalUsernameSuffix()}`
    if (
      !USERNAME_RE.test(candidate) ||
      !identifier.pattern.test(candidate) ||
      candidate.length > identifier.maxLength
    ) {
      throw new TypeError(
        `suffixed managed username does not fit engine identifier limits: ${shortUsername}`,
      )
    }
    return candidate
  }

  const candidate = suffixed()
  if (!(await isManagedUsernameTaken(db, owningOrganizationIds, candidate))) {
    return candidate
  }
  return suffixed()
}

/**
 * Ensure a cluster replication principal exists (`metadata.managedReplication`).
 * Not a client login — excluded from ProxySQL frontend users and managed-users
 * list routes. The applied login resolves under the same org-wide FOR UPDATE
 * probe as root (random `_<11>` suffix per `randomizeSuffix`), persisted on
 * `managed.metadata.replicationUsername`.
 */
export async function ensureManagedReplicationPrincipal(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: {
    managedId: string
    preferredUsername?: string
    provider: string
    identifier: { pattern: RegExp; maxLength: number }
    /** Org randomized-usernames default (`resolveRandomizedPrincipalUsernames`). */
    randomizeSuffix: boolean
  },
): Promise<{ principalId: string; appliedUsername: string; created: boolean }> {
  const rows = await listManagedPrincipals(db, params.managedId)
  for (const row of rows) {
    if (
      isRecord(row.metadata) &&
      row.metadata.managedReplication === true
    ) {
      return {
        principalId: row.id,
        appliedUsername: row.appliedUsername,
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
  const appliedUsername = await resolveManagedAppliedUsername(
    db,
    owningOrgIds,
    preferred,
    params.identifier,
    { suffix: params.randomizeSuffix },
  )
  const created = await createManagedPrincipal(db, dataEncryptionSecrets, {
    managedId: params.managedId,
    provider: params.provider,
    username: preferred,
    appliedUsername,
    passwordLength: REPLICATION_PASSWORD_LENGTH,
    metadata: { managedReplication: true },
  })
  return {
    principalId: created.principalId,
    appliedUsername,
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
