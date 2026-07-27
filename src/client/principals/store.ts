import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  encryptSecret,
  generateSealedSecret,
} from '../authn/data-encryption.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import type { Db } from '../../db.ts'
import { assignment, principal } from '../../lib/db/schema.ts'

export const PRINCIPAL_KINDS = new Set(['system', 'database'])
export const PRINCIPAL_PROVIDERS = new Set([
  'pam',
  'postgres',
  'mysql',
  'redis',
  'clickhouse',
])
export const USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export async function replaceAssignments(
  tx: Db,
  principalId: string,
  nextServiceIds: string[],
): Promise<void> {
  const existing = await tx
    .select({ serviceId: assignment.serviceId })
    .from(assignment)
    .where(eq(assignment.principalId, principalId))

  const current = new Set(existing.map((row) => row.serviceId))
  const next = new Set(nextServiceIds)

  const toDelete = [...current].filter((id) => !next.has(id))
  const toInsert = [...next].filter((id) => !current.has(id))

  if (toDelete.length > 0) {
    await tx
      .delete(assignment)
      .where(
        and(
          eq(assignment.principalId, principalId),
          inArray(assignment.serviceId, toDelete),
        ),
      )
  }

  if (toInsert.length > 0) {
    await tx.insert(assignment).values(
      toInsert.map((serviceId) => ({
        principalId,
        serviceId,
      })),
    )
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
 * Insert a principal row and its initial assignment edges in one transaction.
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

    await tx.insert(assignment).values(
      serviceIds.map((serviceId) => ({
        principalId: inserted.id,
        serviceId,
      })),
    )

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
}

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

  const { plaintext, sealed } = await generateSealedSecret(dataEncryptionSecrets)
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
