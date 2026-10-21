import type { Db } from '../../db/connection.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { materializeBindingsForLogin } from '../bindings/materialize.ts'
import { setLoginPassword } from './logins.ts'

type Rematerialize = typeof materializeBindingsForLogin
type RestorePassword = typeof setLoginPassword

/**
 * Undo a rotate-password request that could not be applied. The stored
 * credential goes back to its previous value AND the bound projects' variables (already rewritten with
 * the new password) are rewritten again from it, so the control plane, the
 * live engine and every project still agree on the old password. Without the
 * second step the next deploy of each bound project would try to log in with
 * a password the database never received.
 *
 * Each step is attempted even if the other fails; a variable rewrite that
 * fails is logged and returned so the caller can tell the operator.
 */
export async function rollBackLoginRotation(
  db: Db,
  dataEncryptionSecrets: DerivedSecretsConfig,
  params: { loginId: string; previousPassword: string | null | undefined },
  rematerialize: Rematerialize = materializeBindingsForLogin,
  restorePassword: RestorePassword = setLoginPassword
): Promise<{ variablesRestored: boolean }> {
  if (typeof params.previousPassword !== 'string') return { variablesRestored: false }
  await restorePassword(db, params.loginId, params.previousPassword)
  try {
    const result = await rematerialize(db, dataEncryptionSecrets, params.loginId)
    if ('ok' in result) return { variablesRestored: true }
    compatLogWarn(
      'managed-rotation',
      `could not restore bound project variables for login ${params.loginId}: ${result.kind}`
    )
  } catch (error) {
    compatLogWarn(
      'managed-rotation',
      `could not restore bound project variables for login ${params.loginId}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`
    )
  }
  return { variablesRestored: false }
}
