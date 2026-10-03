import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'

/** Organization routes that read the session but had no middleware mounted. */
export const SESSION_GUARDED_ORG_PATHS = [
  '/organizations/:id/audit',
  '/organizations/:id/deploy-hooks',
  '/organizations/:id/compose-resource-defaults',
] as const

/** Mount the session middleware so these routes answer 401 without a session. */
export function registerOrganizationSessionGuards(
  router: Hono<AppEnv>,
  secrets: DerivedSecretsConfig
) {
  for (const path of SESSION_GUARDED_ORG_PATHS) {
    router.use(path, createSessionMiddleware(secrets))
  }
}
