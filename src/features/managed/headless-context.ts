/**
 * Minimal Hono {@link Context} for managed apply helpers that only read
 * secrets and emit JSON error responses (no HTTP request).
 */

import type { Context } from 'hono'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'

export type HeadlessManagedSecrets = {
  secretsConfig?: SecretsConfig
  dataEncryptionSecrets?: DerivedSecretsConfig
}

/**
 * Answers `get('secretsConfig')` / `get('dataEncryptionSecrets')` and
 * `json(body, status)` as a plain {@link Response}.
 */
export function headlessManagedContext(secrets: HeadlessManagedSecrets): Context {
  return {
    get(key: string) {
      if (key === 'secretsConfig') return secrets.secretsConfig
      if (key === 'dataEncryptionSecrets') return secrets.dataEncryptionSecrets
      return undefined
    },
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as Context
}
