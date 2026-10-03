import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { registerOrganizationRoutes } from '../../client/organizations/routes.ts'
import { registerOrganizationSessionGuards, SESSION_GUARDED_ORG_PATHS } from './session-guards.ts'

const test = Deno.test.bind(Deno)

test('audit, deploy-hooks and compose-resource-defaults return 401 without a session', async () => {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  registerOrganizationSessionGuards(app, secrets)
  registerOrganizationRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  const id = '11111111-1111-4111-8111-111111111111'
  for (const pattern of SESSION_GUARDED_ORG_PATHS) {
    const path = pattern.replace(':id', id)
    const res = await app.request(path)
    assertEquals(res.status, 401, path)
  }
})
