import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { principal } from '../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { materializeBindingsForPrincipal } from '../bindings/materialize.ts'

type Rematerialize = typeof materializeBindingsForPrincipal

/**
 * Undo a rotate-password request that could not be applied. The stored
 * credential goes back to its previous value AND the bound projects' variables
 * (already rewritten with the new password) are rewritten again from it, so the
 * control plane, the live engine and every project still agree on the old
 * password. Without the second step the next deploy of each bound project would
 * try to log in with a password the database never received.
 *
 * Each step is attempted even if the other fails; a variable rewrite that
 * fails is logged and returned so the caller can tell the operator.
 */
export async function rollBackPrincipalRotation(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: { principalId: string; previousPassword: string | null | undefined },
  rematerialize: Rematerialize = materializeBindingsForPrincipal
): Promise<{ variablesRestored: boolean }> {
  if (typeof params.previousPassword !== 'string') return { variablesRestored: false }
  await db
    .update(principal)
    .set({ password: params.previousPassword, updatedAt: new Date().toISOString() })
    .where(eq(principal.id, params.principalId))
  try {
    const result = await rematerialize(db, dataEncryptionSecrets, params.principalId)
    if ('ok' in result) return { variablesRestored: true }
    compatLogWarn(
      'managed-rotation',
      `could not restore bound project variables for ${params.principalId}: ${result.kind}`
    )
  } catch (error) {
    compatLogWarn(
      'managed-rotation',
      `could not restore bound project variables for ${params.principalId}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`
    )
  }
  return { variablesRestored: false }
}
