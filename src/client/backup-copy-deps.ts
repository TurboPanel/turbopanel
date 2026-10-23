import type { Context } from 'hono'
import type { AppEnv } from '../app/app.ts'
import type { CopyResealDeps } from '../features/backups/targets.ts'

/**
 * The secrets a backup reconcile needs to seal copy targets for a host. A
 * reconcile is the complete set, so every caller passes these: without them a
 * push would leave the copy target off the host's policies.
 */
export function copyDepsOf(c: Context<AppEnv>): CopyResealDeps | undefined {
  const secretsConfig = c.get('secretsConfig')
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  return secretsConfig && dataEncryptionSecrets
    ? { secretsConfig, dataEncryptionSecrets }
    : undefined
}
