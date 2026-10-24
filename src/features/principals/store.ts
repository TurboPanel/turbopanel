import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import {
  isReservedPrincipalUsername,
  MAX_PRINCIPAL_USERNAME_LENGTH,
  MAX_SUFFIXED_PRINCIPAL_USERNAME_LENGTH,
  principalHomeDir,
} from '../../lib/naming.ts'
import type { PrincipalAccessLevel } from '../../features/principals/principal-access.ts'
import { loadPrincipalNamePolicy } from '../../features/managed/load-org-defaults.ts'
import { isManagedLoginNameTaken } from '../../features/managed/logins.ts'
import type { PrincipalNameScheme } from '../../lib/principal-name-scheme.ts'
import { deriveFreeSystemName } from './system-name.ts'
import type { PrincipalUsage } from './placement-records.ts'
import { encryptSecret, generateSealedSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { Db } from '../../db/connection.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  binding,
  environment,
  folder,
  login,
  managed,
  organization,
  principal,
  project,
  replica,
  secret,
  server,
  storage,
  tenancy,
  workspace,
} from '../../db/schema.ts'

export const USERNAME_IN_USE_ERROR = 'username_in_use'
export const PRINCIPAL_IN_USE_ERROR = 'principal_in_use'
export const USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * True when a principal owned by one of `organizationIds` already holds `key`
 * (lower-cased) as its typed `username` or its applied login. One pool per
 * organization; mirrors the unique indexes `uniq_principal_organization_*` so
 * a collision answers 409 before the index refuses the insert.
 */
async function isPoolNameTaken(
  db: Db,
  organizationIds: readonly string[],
  key: string,
  excludePrincipalId?: string
): Promise<boolean> {
  const conditions = [
    inArray(principal.organizationId, [...organizationIds]),
    sql`(lower(${principal.username}) = ${key} OR lower(${principal.appliedUsername}) = ${key})`,
  ]
  if (excludePrincipalId) {
    conditions.push(ne(principal.id, excludePrincipalId))
  }

  const rows = await db
    .select({ id: principal.id })
    .from(principal)
    .where(and(...conditions))
    .limit(1)

  return rows.length > 0
}

/**
 * True when a database login the customer made on a cluster of one of the
 * organizations already uses this name (typed or applied). A login that
 * shares its site owner's Linux user name (`principal_id` set) is the one
 * allowed overlap; the cluster's own root and replication logins sit outside
 * the pool.
 */
async function isLoginPoolNameTaken(
  db: Db,
  organizationIds: readonly string[],
  key: string,
  excludePrincipalId?: string
): Promise<boolean> {
  const conditions = [
    inArray(workspace.organizationId, [...organizationIds]),
    eq(login.role, 'user'),
    sql`(lower(${login.username}) = ${key} OR lower(${login.appliedUsername}) = ${key})`,
  ]
  if (excludePrincipalId) {
    conditions.push(sql`${login.principalId} IS DISTINCT FROM ${excludePrincipalId}::uuid`)
  }
  const rows = await db
    .select({ id: login.id })
    .from(login)
    .innerJoin(managed, eq(managed.id, login.managedId))
    .innerJoin(environment, eq(environment.id, managed.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(and(...conditions))
    .limit(1)
  return rows.length > 0
}

/**
 * True when another principal in the organization already uses this username
 * (trimmed, case-insensitive) — as either its short `username` or its
 * `applied_username` (the name that lands on the host). Keyed on
 * `principal.organization_id`, so a row with no project (tenancy-only) counts
 * too. A database login the organization made with that name counts as well
 * (one name pool across both forms), unless it belongs to `excludePrincipalId`.
 */
export async function isServerPrincipalUsernameTaken(
  db: Db,
  organizationId: string,
  username: string,
  excludePrincipalId?: string
): Promise<boolean> {
  const key = username.trim().toLowerCase()
  if (!key) return false
  return (
    (await isPoolNameTaken(db, [organizationId], key, excludePrincipalId)) ||
    (await isLoginPoolNameTaken(db, [organizationId], key, excludePrincipalId))
  )
}

/**
 * What still uses a principal, with the same key names as the principal list
 * and the 409 body (`PrincipalUsage` minus the placements, which a delete
 * clears itself).
 */
export type PrincipalReferences = Omit<PrincipalUsage, 'otherPlacements'>

/** True when any count in `refs` is above zero. */
export function isPrincipalReferenced(refs: PrincipalReferences): boolean {
  return Object.values(refs).some((total) => total > 0)
}

/**
 * What still uses a principal. A delete is refused while any of these is
 * non-zero: the row going away would strand the service, binding, storage
 * entry or secret that names it, and the host account could not be removed
 * anyway while something still runs as it.
 */
export async function countPrincipalReferences(
  db: Db,
  principalId: string
): Promise<PrincipalReferences> {
  const count = async (
    table: typeof tenancy | typeof storage | typeof secret | typeof login | typeof folder
  ) => {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.principalId, principalId))
    return row?.total ?? 0
  }
  const [bound] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(binding)
    .innerJoin(login, eq(login.id, binding.loginId))
    .where(eq(login.principalId, principalId))
  return {
    tenancies: await count(tenancy),
    bindings: bound?.total ?? 0,
    storages: await count(storage),
    secrets: await count(secret),
    logins: await count(login),
    folders: await count(folder),
  }
}

export async function replaceTenancies(
  tx: Db,
  principalId: string,
  nextServiceIds: string[]
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
      .where(and(eq(tenancy.principalId, principalId), inArray(tenancy.serviceId, toDelete)))
  }

  if (toInsert.length > 0) {
    await tx.insert(tenancy).values(
      toInsert.map((serviceId) => ({
        principalId,
        serviceId,
      }))
    )
  }
}

export type CreatePrincipalFields = {
  organizationId: string
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
  serviceIds: string[]
): Promise<string> {
  return await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(principal)
      .values({
        organizationId: fields.organizationId,
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
        }))
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
 * SFTP client. A row whose alias key is absent was created by hand in the UI.
 * A reconcile adopts such a row only when a document names it: an alias whose
 * short username equals the typed username of one hand-made row in the same
 * project is stamped onto that row instead of minting a second account for the
 * same name (`adoptManualPrincipal`).
 */
export const COMPOSE_ALIAS_METADATA_KEY = 'composeAlias'

/** How a compose `access:` level maps onto the stored access level. */
const ACCESS_LEVEL_FOR_COMPOSE: Readonly<Record<'none' | 'sftp' | 'ssh', PrincipalAccessLevel>> = {
  none: 'none',
  sftp: 'sftp',
  ssh: 'shell',
}

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
  // Dash runs fold to one and edge dashes go: the host refuses builds for a
  // name ending in `-` or holding `--` (see `hasPlainPrincipalDashes`).
  const folded = alias
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .split('-')
    .filter((part) => part.length > 0)
    .join('-')
  const seeded = /^[a-z_]/.test(folded) ? folded : `u${folded}`
  const capped = capShortUsername(seeded)
  const safe = capped.length > 0 ? capped : 'user'
  return isReservedPrincipalUsername(safe) ? capShortUsername(`u${safe}`) : safe
}

/** Cap to the suffixed short-name length without leaving a trailing `-`. */
function capShortUsername(value: string): string {
  let capped = value.slice(0, MAX_SUFFIXED_PRINCIPAL_USERNAME_LENGTH)
  while (capped.endsWith('-')) capped = capped.slice(0, -1)
  return capped
}

export type EnsureComposePrincipalInput = {
  organizationId: string
  projectId: string
  /** Alias as declared in the document's root `x-turbopanel.principals`. */
  alias: string
  /** Requested access level from the alias entry. Seeds the access level on create. */
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
 * **Create-only for `access`.** The requested `access` seeds the level when
 * the row is minted and is never re-applied: `principal.access` is the single
 * source of truth for what the host does, an operator may legitimately raise or
 * suspend access from the UI afterwards, and a reconcile that re-asserted the
 * document would silently undo that. Compose declares that an account *exists*;
 * the panel decides what it can do.
 */
export async function ensureComposePrincipal(
  db: Db,
  input: EnsureComposePrincipalInput
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

    const shortUsername = composeAliasShortUsername(input.alias)
    const adopted = await adoptManualPrincipal(tx, input.projectId, shortUsername, input.alias)
    if (adopted) return { principalId: adopted, created: false }
    const { appliedUsername, nameScheme } = await resolveComposeAppliedUsername(
      tx,
      input.organizationId,
      shortUsername
    )
    // The typed name sits in the organization pool too. When another
    // principal already holds the alias's short name (the same alias in a
    // second project, say), the row keeps its derived login as the typed name
    // as well; the alias itself lives in `metadata.composeAlias`.
    const username =
      appliedUsername !== shortUsername &&
      (await isServerPrincipalUsernameTaken(tx, input.organizationId, shortUsername))
        ? appliedUsername
        : shortUsername

    const [row] = await tx
      .insert(principal)
      .values({
        organizationId: input.organizationId,
        username,
        appliedUsername,
        projectId: input.projectId,
        metadata: {
          home: principalHomeDir(appliedUsername),
          [COMPOSE_ALIAS_METADATA_KEY]: input.alias,
        },
        access: ACCESS_LEVEL_FOR_COMPOSE[input.access ?? 'none'],
        options: { nameScheme },
      })
      .returning({ id: principal.id })

    return { principalId: row.id, created: true }
  })
}

/**
 * Bind `alias` to the hand-made account of this project whose typed username
 * is `shortUsername`, so a document that names an account the operator already
 * added on Bindings reuses that row (and its host login) instead of creating a
 * second one. Only rows with no alias yet are taken; the row keeps its access,
 * keys and assignments.
 */
async function adoptManualPrincipal(
  db: Db,
  projectId: string,
  shortUsername: string,
  alias: string
): Promise<string | undefined> {
  const [row] = await db
    .update(principal)
    .set({
      metadata: sql`coalesce(${principal.metadata}, '{}'::jsonb) || ${JSON.stringify({
        [COMPOSE_ALIAS_METADATA_KEY]: alias,
      })}::jsonb`,
    })
    .where(
      and(
        eq(principal.projectId, projectId),
        eq(principal.username, shortUsername),
        sql`${principal.metadata} ->> ${COMPOSE_ALIAS_METADATA_KEY} is null`
      )
    )
    .returning({ id: principal.id })
  return row?.id
}

/** The row this project already materialized for `alias`, if any. */
async function findComposePrincipal(
  db: Db,
  projectId: string,
  alias: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        eq(principal.projectId, projectId),
        sql`${principal.metadata} ->> ${COMPOSE_ALIAS_METADATA_KEY} = ${alias}`
      )
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
  username: string
): Promise<{ appliedUsername: string; nameScheme: PrincipalNameScheme }> {
  // Compose aliases always follow the org default scheme (the document has no
  // per-principal choice and the lock only restricts what a person may pick).
  const { defaultScheme } = await loadPrincipalNamePolicy(tx, organizationId)
  const isTaken = (candidate: string) =>
    isServerPrincipalUsernameTaken(tx, organizationId, candidate)
  if (defaultScheme === 'plain') {
    if (!(await isTaken(username))) {
      return { appliedUsername: username, nameScheme: 'plain' }
    }
    // Plain name already held by someone else: suffix it rather than fail a
    // deploy over a name the operator never typed.
    const appliedUsername = await deriveFreeSystemName(
      { scheme: 'partial', typed: username, maxLength: MAX_PRINCIPAL_USERNAME_LENGTH },
      isTaken
    )
    return { appliedUsername, nameScheme: 'partial' }
  }
  const appliedUsername = await deriveFreeSystemName(
    { scheme: defaultScheme, typed: username, maxLength: MAX_PRINCIPAL_USERNAME_LENGTH },
    isTaken
  )
  return { appliedUsername, nameScheme: defaultScheme }
}

export type SetPrincipalPasswordInput = { readonly generate: true } | { readonly password: string }

async function persistPrincipalPassword(
  db: Db,
  principalId: string,
  sealed: string
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
  input: SetPrincipalPasswordInput
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
  passwordHash: string
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
export async function clearServerPrincipalPassword(db: Db, principalId: string): Promise<void> {
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
  principalIds: readonly string[]
): Promise<Set<string>> {
  const enabled = new Set<string>()
  if (principalIds.length === 0) return enabled
  const rows = await db
    .select({ id: principal.id })
    .from(principal)
    .where(and(inArray(principal.id, [...principalIds]), isNotNull(principal.password)))
  for (const row of rows) enabled.add(row.id)
  return enabled
}

/** MySQL rejects replication passwords longer than 32 chars (error 3056). */
export const REPLICATION_PASSWORD_LENGTH = 32

/**
 * The managed row's home organization — resolved through
 * `environment → project → workspace`, all NOT NULL, so this is always
 * exactly one org. Distinct from {@link resolveManagedOwningOrganizationIds},
 * which returns the (possibly plural, possibly empty) set of orgs whose
 * servers currently host the cluster's replicas.
 */
export async function resolveManagedHomeOrganizationId(db: Db, managedId: string): Promise<string> {
  const [row] = await db
    .select({ organizationId: workspace.organizationId })
    .from(managed)
    .innerJoin(environment, eq(environment.id, managed.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(eq(managed.id, managedId))
    .limit(1)
  if (!row) throw new TypeError('managed row not found')
  return row.organizationId
}

/**
 * Rotate a principal password (generate + seal). Returns show-once plaintext.
 * Propagates `Principal not found` from {@link setPrincipalPassword}.
 */
export async function rotatePrincipalPassword(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  principalId: string
): Promise<{ plaintext: string }> {
  const result = await setPrincipalPassword(db, dataEncryptionSecrets, principalId, {
    generate: true,
  })
  if (result.plaintext === undefined) {
    throw new TypeError('expected generated plaintext')
  }
  return { plaintext: result.plaintext }
}

/**
 * Distinct non-null `server.organization_id` across the cluster's
 * `replica` servers (server owner — not the creating org, because a
 * server may host another org's cluster via grants), plus the cluster's home
 * organization when given: that is the org whose name pool the cluster's
 * logins live in (`principal.organization_id`), so a name probe must see it
 * even when every member server belongs to someone else.
 */
export async function resolveManagedOwningOrganizationIds(
  db: Db,
  managedId: string,
  /** Prospective member server still being added (not yet in `replica`). */
  extraServerIds: readonly string[] = [],
  homeOrganizationId?: string
): Promise<string[]> {
  const memberOrgs = await db
    .selectDistinct({ organizationId: server.organizationId })
    .from(replica)
    .innerJoin(server, eq(replica.serverId, server.id))
    .where(and(eq(replica.managedId, managedId), isNotNull(server.organizationId)))

  const ids = new Set<string>()
  if (homeOrganizationId) ids.add(homeOrganizationId)
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
 * True when a site owner's Linux user of one of the given organizations
 * already uses this username, short or applied (trimmed, case-insensitive):
 * the same organization pool {@link isServerPrincipalUsernameTaken} consults.
 * Callers pass the cluster's home organization alongside the owning ones.
 */
export async function isManagedUsernameTaken(
  db: Db,
  owningOrganizationIds: readonly string[],
  username: string,
  excludePrincipalId?: string
): Promise<boolean> {
  const key = username.trim().toLowerCase()
  if (!key || owningOrganizationIds.length === 0) return false
  return await isPoolNameTaken(db, owningOrganizationIds, key, excludePrincipalId)
}

/**
 * Resolve the **applied** engine login for a managed principal whose typed
 * (display) name is `shortUsername`, under `opts.scheme`:
 * `plain` is the typed name when free across the owning-org managed login
 * namespace (on collision it falls back to a random suffix so a system
 * generated name never 409s cluster create); `partial` is
 * `<typed>_<11 random chars>`; `random` is a fully random name. Callers that
 * must never expose a bare engine admin name (the root login) pass `partial`
 * or `random`, never `plain`.
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
  opts: { scheme: PrincipalNameScheme }
): Promise<string> {
  if (
    !USERNAME_RE.test(shortUsername) ||
    !identifier.pattern.test(shortUsername) ||
    shortUsername.length > identifier.maxLength
  ) {
    throw new TypeError(`invalid managed short username: ${shortUsername}`)
  }

  // Both forms of the name pool: Linux users and database logins.
  const isTaken = async (candidate: string) =>
    (await isManagedUsernameTaken(db, owningOrganizationIds, candidate)) ||
    (await isManagedLoginNameTaken(db, owningOrganizationIds, candidate))
  if (opts.scheme === 'plain' && !(await isTaken(shortUsername))) {
    return shortUsername
  }

  const drawn = opts.scheme === 'plain' ? 'partial' : opts.scheme
  const candidate = await deriveFreeSystemName(
    { scheme: drawn, typed: shortUsername, maxLength: identifier.maxLength },
    isTaken
  )
  if (
    !USERNAME_RE.test(candidate) ||
    !identifier.pattern.test(candidate) ||
    candidate.length > identifier.maxLength
  ) {
    throw new TypeError(
      `generated managed username does not fit engine identifier limits: ${shortUsername}`
    )
  }
  return candidate
}

/**
 * Lock owning organization rows FOR UPDATE (ordered by id for deadlock safety)
 * before a managed username uniqueness probe. Same pattern as
 * `insertProjectPrincipal`.
 */
export async function lockOrganizationsForUpdate(
  db: Db,
  organizationIds: readonly string[]
): Promise<void> {
  if (organizationIds.length === 0) return
  const ordered = [...organizationIds].sort((a, b) => a.localeCompare(b))
  await forEachSequential(ordered, async (organizationId) => {
    await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .for('update')
      .limit(1)
  })
}
