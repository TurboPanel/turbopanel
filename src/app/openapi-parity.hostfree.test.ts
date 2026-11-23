import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { type AppEnv, createApp } from './app.ts'
import {
  ADMIN_API_PREFIX,
  CLIENT_API_PREFIX,
  DAEMON_API_PREFIX,
  INSTALL_API_PREFIX,
} from './surfaces.ts'
import { registerAdminRoutes } from '../admin/routes.ts'
import { getAdminOpenApiSpec } from '../admin/openapi/index.ts'
import { getWorkersAdminOpenApiSpec } from '../admin/openapi/workers.ts'
import { getClientOpenApiSpec } from '../client/openapi/index.ts'
import { getDaemonOpenApiSpec } from '../daemon/openapi/index.ts'
import { registerIngressAdminRoutes } from '../platform/deno/ingress/admin-routes.ts'
import { registerDaemonApiRoutes } from '../daemon/api-routes.ts'
import { deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { OPENAPI_PARITY_BASELINE } from './openapi-parity-baseline.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SELF_DESCRIBING = /\/(openapi\.json|reference)$/

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])

type Runtime = 'deno' | 'workers'

/** `/orgs/:id{[0-9]+}/x` becomes `/orgs/{id}/x`, the spec's spelling. */
function toSpecPath(path: string): string {
  const normalized = path.replaceAll(/:([A-Za-z_]\w*)(\{[^}]*\})?/g, '{$1}')
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

function registeredOperations(app: Hono<AppEnv>, ...prefixes: string[]): Set<string> {
  const out = new Set<string>()
  for (const route of app.routes) {
    const method = route.method.toLowerCase()
    // Middleware registers under ALL; only real verbs are operations.
    if (!METHODS.has(method)) continue
    if (!prefixes.some((prefix) => route.path.startsWith(`${prefix}/`))) continue
    // The spec and its viewer describe themselves nowhere; they are not API.
    if (SELF_DESCRIBING.test(route.path)) continue
    out.add(`${method.toUpperCase()} ${toSpecPath(route.path)}`)
  }
  return out
}

function documentedOperations(spec: object): Set<string> {
  const out = new Set<string>()
  const paths = (spec as { paths: Record<string, Record<string, unknown>> }).paths
  for (const [path, item] of Object.entries(paths)) {
    for (const method of Object.keys(item)) {
      if (METHODS.has(method)) out.add(`${method.toUpperCase()} ${toSpecPath(path)}`)
    }
  }
  return out
}

async function clientApp(runtime: Runtime): Promise<Hono<AppEnv>> {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  return createApp({ secrets, runtime, signupEnvOverride: undefined })
}

async function adminApp(runtime: Runtime): Promise<Hono<AppEnv>> {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  registerAdminRoutes(app, {
    secrets,
    runtime,
    devSurface: false,
    // Self-hosted only: Workers has no ingress routes, as in production.
    ...(runtime === 'deno'
      ? {
          registerPlatformAdminRoutes: (admin, deps) =>
            registerIngressAdminRoutes(admin, { ...deps, selfKid: () => null }),
        }
      : {}),
  })
  return app
}

function daemonApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerDaemonApiRoutes(app, { runtime: 'deno' })
  return app
}

const SERVER = 'https://panel.example.net'

type Case = {
  name: string
  baseline: keyof typeof OPENAPI_PARITY_BASELINE
  routes: () => Promise<Set<string>> | Set<string>
  spec: () => Set<string>
}

const CASES: Case[] = [
  ...(['deno', 'workers'] as const).map((runtime): Case => ({
    name: `client (${runtime})`,
    baseline: 'client',
    // The install routes live on their own prefix and are documented in the
    // client spec (Deno only).
    routes: async () =>
      registeredOperations(await clientApp(runtime), CLIENT_API_PREFIX, INSTALL_API_PREFIX),
    spec: () =>
      new Set(
        [...documentedOperations(getClientOpenApiSpec(SERVER, { runtime }))].filter((op) =>
          [CLIENT_API_PREFIX, INSTALL_API_PREFIX].some((prefix) =>
            op.split(' ')[1].startsWith(`${prefix}/`)
          )
        )
      ),
  })),
  {
    name: 'admin (deno)',
    baseline: 'adminDeno',
    routes: async () => registeredOperations(await adminApp('deno'), ADMIN_API_PREFIX),
    spec: () => documentedOperations(getAdminOpenApiSpec(SERVER, { runtime: 'deno' })),
  },
  {
    name: 'admin (workers)',
    baseline: 'adminWorkers',
    routes: async () => registeredOperations(await adminApp('workers'), ADMIN_API_PREFIX),
    spec: () => documentedOperations(getWorkersAdminOpenApiSpec(SERVER)),
  },
  {
    name: 'daemon',
    baseline: 'daemon',
    routes: () => registeredOperations(daemonApp(), DAEMON_API_PREFIX),
    spec: () => documentedOperations(getDaemonOpenApiSpec(SERVER)),
  },
]

/**
 * Every registered route on the client, admin and daemon surfaces needs an
 * OpenAPI operation. `OPENAPI_PARITY_BASELINE` lists today's known gaps and
 * may only shrink: a new route without a spec fails here, and so does a
 * baseline line whose route is now documented or gone.
 *
 * Not covered, on purpose: the developer surface (dev builds only), the git
 * and billing webhooks (callers are GitHub, GitLab and Stripe), WebSocket
 * upgrades (documented in the daemon spec as a GET) and the Workers-only
 * billing routes, which register through a hook this suite does not pass.
 * The Deno-only ingress admin routes are registered here, as the server does.
 */
for (const item of CASES) {
  test(`openapi parity: ${item.name} routes and spec agree`, async () => {
    const routes = await item.routes()
    // Positive control: an empty router would pass trivially.
    assertEquals(routes.size > 0, true, 'no routes registered')
    const spec = item.spec()
    const baseline = new Set(OPENAPI_PARITY_BASELINE[item.baseline])
    const undocumented = [...routes].filter((op) => !spec.has(op) && !baseline.has(op)).sort()
    assertEquals(undocumented, [], 'routes without a spec operation: add them to the spec')
    const staleBaseline = [...baseline].filter((op) => spec.has(op) || !routes.has(op)).sort()
    assertEquals(staleBaseline, [], 'baseline lines that are fixed or gone: delete them')
  })
}
