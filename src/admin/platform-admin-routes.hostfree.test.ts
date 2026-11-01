/**
 * The admin router carries no self-hosted-only route unless a composition
 * root injects `registerPlatformAdminRoutes`. Workers never does.
 */
import { assert, assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { ADMIN_API_PREFIX } from '../app/surfaces.ts'
import { deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { registerAdminRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** Same predicate as the Workers suite in `src/workers.entry.test.ts`. */
const SELF_HOSTED_ONLY_ROUTE = /\/instance\/(tunnel-token|ingress|acme-dns)/

async function buildApp(opts: { runtime: 'deno' | 'workers'; hook?: boolean }) {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  registerAdminRoutes(app, {
    secrets,
    runtime: opts.runtime,
    devSurface: false,
    ...(opts.hook
      ? {
          registerPlatformAdminRoutes: (admin: Hono<AppEnv>) => {
            admin.post('/instance/ingress/probe', (c) => c.json({ ok: true }))
          },
        }
      : {}),
  })
  return app
}

test('registerAdminRoutes without the hook has no self-hosted-only routes', async () => {
  for (const runtime of ['workers', 'deno'] as const) {
    const paths = (await buildApp({ runtime })).routes.map((route) => route.path)
    // Positive control: the admin router is mounted, so an empty table cannot pass.
    assert(paths.includes(`${ADMIN_API_PREFIX}/instance/daemon`), runtime)
    assertEquals(
      paths.filter((path) => SELF_HOSTED_ONLY_ROUTE.test(path)),
      [],
      runtime
    )
  }
})

test('the hook mounts routes under the admin prefix and behind the admin session check', async () => {
  const app = await buildApp({ runtime: 'deno', hook: true })
  assert(app.routes.some((route) => route.path === `${ADMIN_API_PREFIX}/instance/ingress/probe`))
  const res = await app.request(`${ADMIN_API_PREFIX}/instance/ingress/probe`, { method: 'POST' })
  assertEquals(res.status, 401)
})
