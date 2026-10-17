/**
 * The cluster's own replication login: made on first use, reused after.
 * It is not a client login: it stays out of the ProxySQL frontend users and
 * the managed-users list routes.
 */

import type { Db } from '../../db/connection.ts'
import type { PrincipalNameScheme } from '../../lib/principal-name-scheme.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  lockOrganizationsForUpdate,
  REPLICATION_PASSWORD_LENGTH,
  resolveManagedAppliedUsername,
  resolveManagedHomeOrganizationId,
  resolveManagedOwningOrganizationIds,
} from '../principals/store.ts'
import { createManagedLogin, findManagedLoginByRole } from './logins.ts'

/** A `plain` request that collided and got a suffix is stored as `partial`. */
function storedSchemeAfterFallback(
  requested: PrincipalNameScheme,
  applied: string,
  typed: string
): PrincipalNameScheme {
  return requested === 'plain' && applied !== typed ? 'partial' : requested
}

/**
 * Ensure a cluster replication login exists. The applied name resolves under
 * the same org-wide FOR UPDATE probe as root (random `_<11>` suffix per
 * `randomizeSuffix`), persisted on `managed.metadata.replicationUsername`.
 */
export async function ensureManagedReplicationLogin(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: {
    managedId: string
    preferredUsername?: string
    identifier: { pattern: RegExp; maxLength: number }
    /** Org default name scheme (`loadPrincipalNamePolicy`). */
    nameScheme: PrincipalNameScheme
  }
): Promise<{ loginId: string; appliedUsername: string; created: boolean }> {
  const existing = await findManagedLoginByRole(db, params.managedId, 'replication')
  if (existing) {
    return { loginId: existing.id, appliedUsername: existing.appliedUsername, created: false }
  }

  const preferred = params.preferredUsername ?? 'tp_repl'
  const owningOrgIds = await resolveManagedOwningOrganizationIds(
    db,
    params.managedId,
    [],
    await resolveManagedHomeOrganizationId(db, params.managedId)
  )
  await lockOrganizationsForUpdate(db, owningOrgIds)
  const appliedUsername = await resolveManagedAppliedUsername(
    db,
    owningOrgIds,
    preferred,
    params.identifier,
    { scheme: params.nameScheme }
  )
  const created = await createManagedLogin(db, dataEncryptionSecrets, {
    managedId: params.managedId,
    role: 'replication',
    username: preferred,
    appliedUsername,
    nameScheme: storedSchemeAfterFallback(params.nameScheme, appliedUsername, preferred),
    passwordLength: REPLICATION_PASSWORD_LENGTH,
  })
  return { loginId: created.loginId, appliedUsername, created: true }
}
