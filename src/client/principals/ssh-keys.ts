/**
 * Storage for the public keys that may authenticate as a principal.
 *
 * Separate from `./store.ts` because the read shape differs in a way that
 * matters: entitlements are loaded to *render* a form, keys are loaded to
 * *build a payload the host authenticates against*, and the two have different
 * containment rules. Keeping them apart makes it hard to accidentally hand a
 * serializer the raw key rows or hand the daemon a display shape.
 */

import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  principal,
  principalSshKey,
  project,
  workspace,
} from '../../lib/db/schema.ts'
import { parseSshPublicKey } from '../../lib/ssh-public-key.ts'

/**
 * Cap per account, matching the daemon's `MAX_KEYS_PER_PRINCIPAL`.
 *
 * Enforced here so the failure lands on the request that added the 65th key,
 * rather than on the next unrelated reconcile — which would be a confusing
 * distance from the cause.
 */
export const MAX_SSH_KEYS_PER_PRINCIPAL = 64

export const SSH_KEY_LIMIT_ERROR = 'ssh_key_limit'
export const SSH_KEY_DUPLICATE_ERROR = 'ssh_key_duplicate'

/** One key as the API renders it. Never includes anything the operator pasted. */
export type PrincipalSshKeyRow = {
  id: string
  name: string
  keyType: string
  publicKey: string
  fingerprint: string
  comment: string | null
  bits: number | null
  createdAt: string
}

export class SshKeyRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshKeyRejected'
  }
}

export async function listSshKeys(
  db: Db,
  principalId: string,
): Promise<PrincipalSshKeyRow[]> {
  return await db
    .select({
      id: principalSshKey.id,
      name: principalSshKey.name,
      keyType: principalSshKey.keyType,
      publicKey: principalSshKey.publicKey,
      fingerprint: principalSshKey.fingerprint,
      comment: principalSshKey.comment,
      bits: principalSshKey.bits,
      createdAt: principalSshKey.createdAt,
    })
    .from(principalSshKey)
    .where(eq(principalSshKey.principalId, principalId))
    .orderBy(asc(principalSshKey.createdAt))
}

/**
 * Canonical key lines for a set of principals, keyed by principal id.
 *
 * This is what feeds the deploy and reconcile payloads. The map always has an
 * entry for every id asked about, including the ones with no keys — an absent
 * entry and an empty one mean different things downstream ("say nothing" versus
 * "revoke everything"), and a caller building a full-state reconcile must not
 * have to guess which it is holding.
 */
export async function loadSshKeysByPrincipalIds(
  tx: Db,
  principalIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byPrincipal = new Map<string, string[]>(
    principalIds.map((id) => [id, []]),
  )
  if (principalIds.length === 0) return byPrincipal
  const rows = await tx
    .select({
      principalId: principalSshKey.principalId,
      publicKey: principalSshKey.publicKey,
    })
    .from(principalSshKey)
    .where(inArray(principalSshKey.principalId, [...principalIds]))

  for (const row of rows) {
    byPrincipal.get(row.principalId)?.push(row.publicKey)
  }
  return byPrincipal
}

/** How many keys each of these principals holds. */
export async function countSshKeysByPrincipalIds(
  tx: Db,
  principalIds: readonly string[],
): Promise<Map<string, number>> {
  const keys = await loadSshKeysByPrincipalIds(tx, principalIds)
  return new Map([...keys].map(([id, list]) => [id, list.length]))
}

export type AddSshKeyInput = {
  principalId: string
  name: string
  /** The operator's pasted line. Parsed and re-rendered; never stored as-is. */
  publicKey: unknown
  /** Org member adding it — provenance, not ownership. */
  userId?: string | null
}

/**
 * Parse, validate, and store one key.
 *
 * Throws {@link SshKeyRejected} with the parser's own message rather than a
 * generic "invalid key": an operator pasting a key gets it wrong in specific,
 * fixable ways (a stray options field, a DSA key, the private half), and each
 * of those deserves the sentence that says what to do.
 */
export async function addSshKey(
  db: Db,
  input: AddSshKeyInput,
): Promise<PrincipalSshKeyRow> {
  const name = input.name.trim()
  if (name.length === 0 || name.length > 255) {
    throw new SshKeyRejected('name must be between 1 and 255 characters')
  }

  const parsed = await parseSshPublicKey(input.publicKey)
  if (!parsed.ok) throw new SshKeyRejected(parsed.error)

  return await db.transaction(async (tx) => {
    const existing = await tx
      .select({ fingerprint: principalSshKey.fingerprint })
      .from(principalSshKey)
      .where(eq(principalSshKey.principalId, input.principalId))

    if (existing.length >= MAX_SSH_KEYS_PER_PRINCIPAL) {
      throw new SshKeyRejected(SSH_KEY_LIMIT_ERROR)
    }
    // Checked here as well as by the unique constraint, so the operator gets
    // "you already added this key" rather than a constraint violation. The
    // constraint stays as the real guarantee.
    if (existing.some((row) => row.fingerprint === parsed.value.fingerprint)) {
      throw new SshKeyRejected(SSH_KEY_DUPLICATE_ERROR)
    }

    const [inserted] = await tx
      .insert(principalSshKey)
      .values({
        principalId: input.principalId,
        name,
        keyType: parsed.value.keyType,
        publicKey: parsed.value.publicKey,
        fingerprint: parsed.value.fingerprint,
        comment: parsed.value.comment ?? null,
        bits: parsed.value.bits ?? null,
        userId: input.userId ?? null,
      })
      .returning({
        id: principalSshKey.id,
        name: principalSshKey.name,
        keyType: principalSshKey.keyType,
        publicKey: principalSshKey.publicKey,
        fingerprint: principalSshKey.fingerprint,
        comment: principalSshKey.comment,
        bits: principalSshKey.bits,
        createdAt: principalSshKey.createdAt,
      })
    return inserted
  })
}

/** Remove one key. Returns false when it was not this principal's to remove. */
export async function removeSshKey(
  db: Db,
  principalId: string,
  keyId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(principalSshKey)
    .where(
      and(
        eq(principalSshKey.id, keyId),
        // Scoped by principal, so a key id from another account cannot be
        // deleted by guessing it.
        eq(principalSshKey.principalId, principalId),
      ),
    )
    .returning({ id: principalSshKey.id })
  return deleted.length > 0
}

/**
 * Every principal in an organization that holds this fingerprint.
 *
 * The lost-laptop query, and the reason keys are a table. An operator with a
 * fingerprint needs every account it opens — across projects and servers —
 * before they can say the credential is contained.
 */
export async function principalsWithFingerprint(
  db: Db,
  organizationId: string,
  fingerprint: string,
): Promise<Array<{ principalId: string; username: string }>> {
  return await db
    .select({
      principalId: principal.id,
      username: principal.username,
    })
    .from(principalSshKey)
    .innerJoin(principal, eq(principal.id, principalSshKey.principalId))
    .innerJoin(project, eq(principal.projectId, project.id))
    .innerJoin(workspace, eq(project.workspaceId, workspace.id))
    .where(
      and(
        eq(workspace.organizationId, organizationId),
        eq(principalSshKey.fingerprint, fingerprint),
      ),
    )
}
