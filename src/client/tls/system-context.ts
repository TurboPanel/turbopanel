/**
 * A request-less Hono context for the work the leaf sweep does on its own
 * (renewing leaves, retiring an overdue rotation). It answers only for the
 * secrets and builds JSON responses; there is no request, registry or queue.
 */
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'

export function systemRotationContext(deps: {
  secretsConfig: SecretsConfig | null
  dataEncryptionSecrets: DerivedSecretsConfig | null
}): Context<AppEnv> {
  return {
    get(key: string) {
      if (key === 'secretsConfig') return deps.secretsConfig ?? undefined
      if (key === 'dataEncryptionSecrets') return deps.dataEncryptionSecrets ?? undefined
      return undefined
    },
    json(body: unknown, status?: number) {
      return new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  } as Context<AppEnv>
}
